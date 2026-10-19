import { XMLParser } from "fast-xml-parser";
import { HTTPException } from "hono/http-exception";
import type { Ctx, Env } from "./env";

/** arXiv's mirror for programmatic access; all automated requests go here, not arxiv.org. */
const EXPORT = "https://export.arxiv.org";
const API = `${EXPORT}/api/query`;
const OAI = `${EXPORT}/oai2`;
const UA = "LichPapers/0.1 (+https://github.com/moikapy/lich-papers)";
/** D1 rows top out around 2 MB; keep extracted text comfortably below that. */
export const MAX_BODY_CHARS = 500_000;

export interface PaperMeta {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string | null;
  updated: string | null;
}

export interface Paper extends PaperMeta {
  body: string | null;
  body_source: "html" | "pdf" | "abstract" | null;
}

export interface SearchParams {
  q: string;
  start?: number;
  max?: number;
  sort?: "relevance" | "submittedDate" | "lastUpdatedDate";
  category?: string;
}

export interface SearchResult {
  total: number;
  start: number;
  papers: PaperMeta[];
}

const ID = String.raw`(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?`;
const BARE_ID = new RegExp(`^(?:arxiv:)?${ID}$`, "i");
const URL_ID = new RegExp(`arxiv\\.org/(?:abs|pdf|html)/${ID}`, "i");

/** Extracts a version-less arXiv id from a bare id, "arXiv:" reference, or abs/pdf/html URL. */
export function parseArxivId(input: string): string | null {
  const s = input.trim();
  const id = (s.match(BARE_ID) ?? s.match(URL_ID))?.[1];
  if (!id) return null;
  // Old-style ids are canonically "archive.CLASS/NNNNNNN" (lowercase archive, uppercase subject class).
  return id.replace(/^([a-z-]+)(?:\.([a-z]{2}))?\//i, (_, a: string, c?: string) => `${a.toLowerCase()}${c ? "." + c.toUpperCase() : ""}/`);
}

/** Turns free text into an arXiv API search_query. Field-prefixed queries pass through. */
export function buildSearchQuery(q: string, category?: string): string {
  const trimmed = q.trim();
  let query: string;
  if (/\b(ti|au|abs|co|jr|cat|rn|all):/.test(trimmed) || /\b(AND|OR|ANDNOT)\b/.test(trimmed)) {
    query = trimmed;
  } else {
    const phrases = [...trimmed.matchAll(/"([^"]+)"|(\S+)/g)].map((m) =>
      m[1] ? `all:"${m[1]}"` : `all:${m[2]!.replace(/["():]/g, "")}`,
    );
    query = phrases.filter((p) => p !== "all:").join(" AND ");
  }
  if (category) query = query ? `(${query}) AND cat:${category}` : `cat:${category}`;
  return query;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "author", "category", "link"].includes(name),
});

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export function parseAtom(text: string): SearchResult {
  const feed = xml.parse(text).feed ?? {};
  const entries: any[] = feed.entry ?? [];
  const papers: PaperMeta[] = [];
  for (const e of entries) {
    const id = parseArxivId(String(e.id ?? ""));
    // The API returns a single "Error" entry for malformed queries.
    if (!id || clean(e.title) === "Error") continue;
    papers.push({
      arxiv_id: id,
      title: clean(e.title),
      authors: (e.author ?? []).map((a: any) => clean(a.name)),
      abstract: clean(e.summary),
      categories: (e.category ?? []).map((c: any) => String(c["@_term"])),
      published: e.published ? String(e.published) : null,
      updated: e.updated ? String(e.updated) : null,
    });
  }
  return {
    total: Number(feed["opensearch:totalResults"]?.["#text"] ?? feed["opensearch:totalResults"] ?? papers.length),
    start: Number(feed["opensearch:startIndex"]?.["#text"] ?? feed["opensearch:startIndex"] ?? 0),
    papers,
  };
}

// ---------------------------------------------------------------- polite arXiv access

/**
 * arXiv asks programmatic clients to use export.arxiv.org, make one request at a time, and wait
 * about 3 seconds between requests. This gate enforces that across every Worker instance with a
 * single D1 row: each request reserves the next free slot and waits for it.
 */
const ARXIV_INTERVAL_MS = 3000;
const ARXIV_MAX_WAIT_MS = 15_000;

async function arxivSlot(env: Env): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "UPDATE arxiv_gate SET next_at = MAX(next_at, ?) + ? WHERE id = 1 AND next_at < ? RETURNING next_at",
  )
    .bind(now, ARXIV_INTERVAL_MS, now + ARXIV_MAX_WAIT_MS)
    .first<{ next_at: number }>();
  if (!row) throw new HTTPException(503, { message: "arXiv is busy right now. Try again in a few seconds." });
  const wait = row.next_at - ARXIV_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function arxivFetch(env: Env, url: string): Promise<Response> {
  await arxivSlot(env);
  try {
    return await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  } catch (err) {
    console.error("arXiv fetch failed", url, err);
    throw new HTTPException(502, { message: "arXiv is unreachable right now. Try again in a moment." });
  }
}

async function cachedArxivFetch(env: Env, url: string, ttlSeconds: number, ctx?: Ctx): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await arxivFetch(env, url);
  if (res.ok) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
    const put = cache.put(key, copy);
    ctx ? ctx.waitUntil(put) : await put;
  }
  return res;
}

export async function searchArxiv(env: Env, p: SearchParams, ctx?: Ctx): Promise<SearchResult> {
  const id = parseArxivId(p.q);
  const params = new URLSearchParams({
    start: String(p.start ?? 0),
    max_results: String(Math.min(p.max ?? 20, 50)),
  });
  if (id) {
    params.set("id_list", id);
  } else {
    params.set("search_query", buildSearchQuery(p.q, p.category));
    params.set("sortBy", p.sort ?? "relevance");
    params.set("sortOrder", "descending");
  }
  const res = await cachedArxivFetch(env, `${API}?${params}`, 3600, ctx);
  if (!res.ok) throw new HTTPException(502, { message: `arXiv API returned ${res.status}` });
  return parseAtom(await res.text());
}

// ---------------------------------------------------------------- licenses

/** arXiv's default license: distribution by arXiv only. */
export const ARXIV_DEFAULT_LICENSE = "http://arxiv.org/licenses/nonexclusive-distrib/1.0/";

/** Extracts the license URI from an OAI-PMH `metadataPrefix=arXiv` record; null when absent. */
export function parseOaiLicense(xmlText: string): string | null {
  const m = xmlText.match(/<license>\s*([^<\s]+)\s*<\/license>/);
  return m ? m[1]! : null;
}

/**
 * Whether we may display a paper's full text in the app (a commercial service):
 * CC BY, CC BY-SA, CC0 and public-domain dedications. NonCommercial and arXiv's default
 * license don't allow it, so those papers get the abstract and links to arXiv instead.
 */
export function isOpenLicense(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const u = uri.toLowerCase();
  if (/creativecommons\.org\/publicdomain\//.test(u) || /creativecommons\.org\/licenses\/publicdomain/.test(u)) return true;
  const m = u.match(/creativecommons\.org\/licenses\/([a-z-]+)\//);
  return !!m && (m[1] === "by" || m[1] === "by-sa");
}

/** Human-readable name for a license URI. */
export function licenseLabel(uri: string | null | undefined): string {
  if (!uri || uri.includes("arxiv.org/licenses")) return "arXiv license (all rights reserved by the authors)";
  const u = uri.toLowerCase();
  if (u.includes("publicdomain/zero")) return "CC0 1.0 (public domain)";
  if (u.includes("publicdomain")) return "Public domain";
  const m = u.match(/licenses\/([a-z-]+)\/([\d.]+)/);
  return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : uri;
}

const LICENSE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** The paper's license URI (null = arXiv default), from OAI-PMH, cached in D1 for 30 days. */
export async function getPaperLicense(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT license, license_checked_at FROM papers WHERE arxiv_id = ?")
    .bind(id)
    .first<{ license: string | null; license_checked_at: number | null }>();
  if (row?.license_checked_at && Date.now() - row.license_checked_at < LICENSE_RECHECK_MS) return row.license;
  const res = await arxivFetch(env, `${OAI}?verb=GetRecord&identifier=oai:arXiv.org:${encodeURIComponent(id)}&metadataPrefix=arXiv`);
  if (!res.ok) return row?.license ?? null; // unknown → treated as not open
  const license = parseOaiLicense(await res.text());
  await env.DB.prepare("UPDATE papers SET license = ?, license_checked_at = ? WHERE arxiv_id = ?").bind(license, Date.now(), id).run();
  return license;
}

// ---------------------------------------------------------------- papers

interface PaperRow {
  arxiv_id: string;
  title: string;
  authors: string;
  abstract: string;
  categories: string;
  published: string | null;
  updated: string | null;
  body: string | null;
  body_source: Paper["body_source"];
}

function rowToPaper(r: PaperRow): Paper {
  return { ...r, authors: JSON.parse(r.authors), categories: JSON.parse(r.categories) };
}

/** Paper metadata (CC0), cached in D1. Body is not loaded (see getPaperWithBody). */
export async function getPaper(env: Env, id: string, ctx?: Ctx): Promise<Paper | null> {
  const row = await env.DB.prepare(
    "SELECT arxiv_id, title, authors, abstract, categories, published, updated, NULL AS body, NULL AS body_source FROM papers WHERE arxiv_id = ?",
  )
    .bind(id)
    .first<PaperRow>();
  if (row) return rowToPaper(row);
  const { papers } = await searchArxiv(env, { q: id }, ctx);
  const meta = papers.find((p) => p.arxiv_id === id);
  if (!meta) return null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO papers (arxiv_id, title, authors, abstract, categories, published, updated, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(meta.arxiv_id, meta.title, JSON.stringify(meta.authors), meta.abstract, JSON.stringify(meta.categories), meta.published, meta.updated, Date.now())
    .run();
  return { ...meta, body: null, body_source: null };
}

/** How long extracted full text is kept before it's dropped and re-fetched from arXiv. */
export const BODY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Paper with full text for the tutor. The text is fetched from arXiv on demand and kept only
 * briefly (BODY_TTL_MS) so answers stay fast without keeping a permanent copy.
 */
export async function getPaperWithBody(env: Env, id: string, ctx?: Ctx): Promise<Paper | null> {
  const meta = await getPaper(env, id, ctx);
  if (!meta) return null;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT body, body_source, body_expires_at FROM papers WHERE arxiv_id = ?")
    .bind(id)
    .first<{ body: string | null; body_source: Paper["body_source"]; body_expires_at: number | null }>();
  if (row?.body && row.body_source !== "abstract" && (row.body_expires_at ?? 0) > now) {
    return { ...meta, body: row.body, body_source: row.body_source };
  }

  let body: string | null = null;
  let source: Paper["body_source"] = "abstract";
  try {
    body = await fetchHtmlText(env, id);
    if (body) source = "html";
  } catch (err) {
    console.warn("html extraction failed", id, err);
  }
  if (!body) {
    try {
      body = await fetchPdfText(env, id);
      if (body) source = "pdf";
    } catch (err) {
      console.warn("pdf extraction failed", id, err);
    }
  }
  if (!body) {
    // Don't persist the fallback: a transient arXiv failure must not pin the abstract.
    return { ...meta, body: meta.abstract, body_source: "abstract" };
  }
  body = body.slice(0, MAX_BODY_CHARS);
  await env.DB.prepare("UPDATE papers SET body = ?, body_source = ?, body_expires_at = ? WHERE arxiv_id = ?")
    .bind(body, source, now + BODY_TTL_MS, id)
    .run();
  return { ...meta, body, body_source: source };
}

/** Drops expired full text (run daily by the cron trigger). */
export async function purgeExpiredBodies(env: Env): Promise<number> {
  const res = await env.DB.prepare("UPDATE papers SET body = NULL, body_source = NULL, body_expires_at = NULL WHERE body IS NOT NULL AND (body_expires_at IS NULL OR body_expires_at < ?)")
    .bind(Date.now())
    .run();
  return res.meta?.changes ?? 0;
}

/** arXiv's LaTeX→HTML rendering (available for most papers since late 2023). */
async function fetchHtmlText(env: Env, id: string): Promise<string | null> {
  const res = await arxivFetch(env, `${EXPORT}/html/${id}`);
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
  const text = await htmlToText(res);
  return text.length > 2000 ? text : null;
}

async function fetchPdfText(env: Env, id: string): Promise<string | null> {
  const res = await arxivFetch(env, `${EXPORT}/pdf/${id}`);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages
    .map((t, i) => `\n\n[page ${i + 1}]\n${t}`)
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Stands in for list-item indentation until whitespace is collapsed. */
const INDENT = "\u0001";

/**
 * Converts an arXiv (LaTeXML) HTML page to markdown-ish text: "## " heading markers,
 * "- " / "1. " list items and inline $math$ taken from alttext.
 */
async function htmlToText(res: Response): Promise<string> {
  const out: string[] = [];
  let inArticle = 0;
  let skip = 0;
  const lists: ("ul" | "ol")[] = [];
  let inItem = 0;
  // Paragraphs inside a list item stay on the item's line so the marker isn't orphaned.
  const block = () => out.push(inItem ? " " : "\n");
  const rewriter = new HTMLRewriter()
    .on("article", {
      element(el) {
        inArticle++;
        el.onEndTag(() => void inArticle--);
      },
    })
    .on("script, style, nav, footer, header, .ltx_page_footer, .ltx_role_footnote .ltx_tag, .ltx_tag_item", {
      element(el) {
        skip++;
        el.onEndTag(() => void skip--);
      },
    })
    .on("math", {
      element(el) {
        const alt = el.getAttribute("alttext");
        if (inArticle && !skip && alt) out.push(` $${alt}$ `);
        skip++;
        el.onEndTag(() => void skip--);
      },
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(el) {
        if (!inArticle) return;
        out.push("\n\n## ");
        el.onEndTag(() => void out.push("\n"));
      },
    })
    .on("ul, ol", {
      element(el) {
        if (!inArticle) return;
        lists.push(el.tagName === "ol" ? "ol" : "ul");
        el.onEndTag(() => {
          lists.pop();
          out.push("\n\n");
        });
      },
    })
    .on("li", {
      element(el) {
        if (!inArticle) return;
        const depth = Math.max(lists.length, 1);
        out.push(`\n\n${INDENT.repeat(depth - 1)}${lists[depth - 1] === "ol" ? "1. " : "- "}`);
        inItem++;
        el.onEndTag(() => {
          inItem--;
          out.push("\n");
        });
      },
    })
    .on("p, div, figcaption, tr, section, blockquote, .ltx_bibitem", {
      element(el) {
        if (!inArticle) return;
        block();
        el.onEndTag(() => void block());
      },
    })
    .onDocument({
      text(t) {
        if (inArticle && !skip) out.push(t.text);
      },
    });
  await rewriter.transform(res).arrayBuffer();
  return decodeEntities(out.join(""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll(INDENT, "   ")
    .trim();
}

// ---------------------------------------------------------------- figures

export interface Figure {
  /** 1-based, in document order. */
  n: number;
  /** The paper's own label, e.g. "Figure 3". */
  label: string;
  caption: string;
  /** Absolute image URL on arXiv's HTML rendering. */
  src: string;
}

const MAX_FIGURES = 40;

/** Parses figures (image + caption) out of arXiv's LaTeXML HTML. `base` resolves relative image paths. */
export async function parseFigures(res: Response, base: string): Promise<Figure[]> {
  const figs: { src: string | null; caption: string; label: string }[] = [];
  let cur: { src: string | null; caption: string; label: string } | null = null;
  let depth = 0;
  let inCaption = 0;
  let inTag = 0;
  await new HTMLRewriter()
    .on("figure", {
      element(el) {
        // Sub-figures (panels) belong to their outer figure.
        if (depth++ === 0) cur = { src: null, caption: "", label: "" };
        el.onEndTag(() => {
          if (--depth === 0 && cur) {
            if (cur.src && figs.length < MAX_FIGURES) figs.push(cur);
            cur = null;
          }
        });
      },
    })
    .on("figure img", {
      element(el) {
        const src = el.getAttribute("src");
        if (cur && !cur.src && src && !src.startsWith("data:")) cur.src = src;
      },
    })
    .on("figure figcaption", {
      element(el) {
        inCaption++;
        el.onEndTag(() => void inCaption--);
      },
    })
    .on("figure figcaption .ltx_tag", {
      element(el) {
        inTag++;
        el.onEndTag(() => void inTag--);
      },
    })
    .on("figure figcaption math", {
      element(el) {
        const alt = el.getAttribute("alttext");
        if (cur && alt) cur.caption += ` $${alt}$ `;
      },
    })
    .onDocument({
      text(t) {
        if (!cur || !inCaption) return;
        if (inTag) cur.label += t.text;
        else cur.caption += t.text;
      },
    })
    .transform(res)
    .arrayBuffer();
  return figs.map((f, i) => ({
    n: i + 1,
    label: decodeEntities(f.label).replace(/\s+/g, " ").replace(/:\s*$/, "").trim() || `Figure ${i + 1}`,
    caption: decodeEntities(f.caption).replace(/\$[^$]*\$/g, (m) => (m.length > 200 ? "$…$" : m)).replace(/\s+/g, " ").trim().slice(0, 1200),
    src: new URL(f.src!, base).toString(),
  }));
}

/** Figures of a paper's HTML rendering (empty when arXiv has no HTML for it). Cached for a day. */
export async function getFigures(env: Env, id: string, ctx?: Ctx): Promise<Figure[]> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://lich-papers.internal/figures/${encodeURIComponent(id)}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as Figure[];
  const res = await arxivFetch(env, `${EXPORT}/html/${id}`);
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return [];
  // Relative image paths are relative to the final (versioned) URL, e.g. /html/2401.00001v2/.
  const base = (res.url || `${EXPORT}/html/${id}`).replace(/\/?$/, "/");
  const figs = await parseFigures(res, base);
  const put = cache.put(key, Response.json(figs, { headers: { "cache-control": "public, max-age=86400" } }));
  ctx ? ctx.waitUntil(put) : await put;
  return figs;
}

const MAX_FIGURE_BYTES = 4 * 1024 * 1024;

/** Raster formats the Clef models accept. */
const FIGURE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Downloads one figure image as base64, or null if it isn't a reasonably sized PNG/JPEG/WebP on arXiv. */
export async function fetchFigureImage(env: Env, fig: Figure): Promise<{ base64: string; type: string } | null> {
  const host = new URL(fig.src).hostname;
  if (host !== "arxiv.org" && !host.endsWith(".arxiv.org")) return null;
  const res = await arxivFetch(env, fig.src);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  // SVG, GIF and other formats aren't something the decision model can read.
  if (!res.ok || !FIGURE_TYPES.has(type)) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_FIGURE_BYTES) return null;
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), type };
}
