import { XMLParser } from "fast-xml-parser";
import { HTTPException } from "hono/http-exception";
import type { Ctx, Env } from "./env";

const API = "https://export.arxiv.org/api/query";
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
  return (s.match(BARE_ID) ?? s.match(URL_ID))?.[1] ?? null;
}

/** Turns free text into an arXiv API search_query. Field-prefixed queries pass through. */
export function buildSearchQuery(q: string, category?: string): string {
  const trimmed = q.trim();
  let query: string;
  if (/\b(ti|au|abs|co|jr|cat|rn|all):/.test(trimmed) || /\b(AND|OR|ANDNOT)\b/.test(trimmed)) {
    query = trimmed;
  } else {
    const phrases = [...trimmed.matchAll(/"([^"]+)"|(\S+)/g)].map((m) =>
      m[1] ? `all:"${m[1]}"` : `all:${m[2]!.replace(/[():]/g, "")}`,
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

async function cachedFetch(url: string, ttlSeconds: number, ctx?: Ctx): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (res.ok) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
    const put = cache.put(key, copy);
    ctx ? ctx.waitUntil(put) : await put;
  }
  return res;
}

export async function searchArxiv(p: SearchParams, ctx?: Ctx): Promise<SearchResult> {
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
  let res: Response;
  try {
    res = await cachedFetch(`${API}?${params}`, 3600, ctx);
  } catch (err) {
    console.error("arXiv fetch failed", err);
    throw new HTTPException(502, { message: "arXiv is unreachable right now. Try again in a moment." });
  }
  if (!res.ok) throw new HTTPException(502, { message: `arXiv API returned ${res.status}` });
  return parseAtom(await res.text());
}

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

/** Paper metadata, cached in D1. Body is not loaded (see getPaperWithBody). */
export async function getPaper(env: Env, id: string, ctx?: Ctx): Promise<Paper | null> {
  const row = await env.DB.prepare(
    "SELECT arxiv_id, title, authors, abstract, categories, published, updated, NULL AS body, body_source FROM papers WHERE arxiv_id = ?",
  )
    .bind(id)
    .first<PaperRow>();
  if (row) return rowToPaper(row);
  const { papers } = await searchArxiv({ q: id }, ctx);
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

/** Paper with full text, extracting and caching it on first use. */
export async function getPaperWithBody(env: Env, id: string, ctx?: Ctx): Promise<Paper | null> {
  const meta = await getPaper(env, id, ctx);
  if (!meta) return null;
  const row = await env.DB.prepare("SELECT body, body_source FROM papers WHERE arxiv_id = ?")
    .bind(id)
    .first<{ body: string | null; body_source: Paper["body_source"] }>();
  if (row?.body) return { ...meta, body: row.body, body_source: row.body_source };

  let body: string | null = null;
  let source: Paper["body_source"] = "abstract";
  try {
    body = await fetchHtmlText(id);
    if (body) source = "html";
  } catch (err) {
    console.warn("html extraction failed", id, err);
  }
  if (!body) {
    try {
      body = await fetchPdfText(id);
      if (body) source = "pdf";
    } catch (err) {
      console.warn("pdf extraction failed", id, err);
    }
  }
  if (!body) {
    body = meta.abstract;
    source = "abstract";
  }
  body = body.slice(0, MAX_BODY_CHARS);
  await env.DB.prepare("UPDATE papers SET body = ?, body_source = ? WHERE arxiv_id = ?").bind(body, source, id).run();
  return { ...meta, body, body_source: source };
}

/** arXiv's LaTeX→HTML rendering (available for most papers since late 2023). */
async function fetchHtmlText(id: string): Promise<string | null> {
  const res = await fetch(`https://arxiv.org/html/${id}`, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
  const text = await htmlToText(res);
  return text.length > 2000 ? text : null;
}

async function fetchPdfText(id: string): Promise<string | null> {
  const res = await fetch(`https://arxiv.org/pdf/${id}`, { headers: { "user-agent": UA }, redirect: "follow" });
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

/**
 * Converts an arXiv (LaTeXML) HTML page to plain text with "## " heading
 * markers and inline $math$ taken from alttext.
 */
async function htmlToText(res: Response): Promise<string> {
  const out: string[] = [];
  let inArticle = 0;
  let skip = 0;
  const block = () => out.push("\n");
  const rewriter = new HTMLRewriter()
    .on("article", {
      element(el) {
        inArticle++;
        el.onEndTag(() => void inArticle--);
      },
    })
    .on("script, style, nav, footer, header, .ltx_page_footer, .ltx_role_footnote .ltx_tag", {
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
    .on("p, div, li, figcaption, tr, section, blockquote, .ltx_bibitem", {
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
    .trim();
}
