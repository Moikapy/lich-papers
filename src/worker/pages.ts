import { HTTPException } from "hono/http-exception";
import { Marked } from "marked";
import type { Env } from "./env";

/** A page in the sidebar tree (no content). */
export interface PageSummary {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  position: number;
  updated_at: number;
}

export interface Page extends PageSummary {
  content: string | null;
  format: "json" | "html";
  created_at: number;
}

export const MAX_PAGES = 2000;
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_TITLE_CHARS = 200;

const SUMMARY_COLS = "id, parent_id, title, icon, position, updated_at";

export async function listPages(env: Env, userId: string): Promise<PageSummary[]> {
  const { results } = await env.DB.prepare(`SELECT ${SUMMARY_COLS} FROM pages WHERE user_id = ? ORDER BY position, created_at`).bind(userId).all<PageSummary>();
  return results;
}

export async function getPage(env: Env, userId: string, id: string): Promise<Page> {
  const page = await env.DB.prepare(`SELECT ${SUMMARY_COLS}, content, format, created_at FROM pages WHERE id = ? AND user_id = ?`).bind(id, userId).first<Page>();
  if (!page) throw new HTTPException(404, { message: "Page not found" });
  return page;
}

const cleanTitle = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
const cleanIcon = (i: unknown) => {
  const s = String(i ?? "").trim();
  // An emoji or a couple of characters; anything longer isn't an icon.
  return s ? [...s].slice(0, 4).join("") : null;
};

/** Throws unless `parentId` is null or one of the user's pages. */
async function assertParent(env: Env, userId: string, parentId: string | null): Promise<void> {
  if (parentId === null) return;
  const row = await env.DB.prepare("SELECT 1 FROM pages WHERE id = ? AND user_id = ?").bind(parentId, userId).first();
  if (!row) throw new HTTPException(400, { message: "Parent page not found" });
}

/** Position after the last sibling. */
async function nextPosition(env: Env, userId: string, parentId: string | null): Promise<number> {
  const row = await env.DB.prepare("SELECT MAX(position) AS p FROM pages WHERE user_id = ? AND parent_id IS ?").bind(userId, parentId).first<{ p: number | null }>();
  return (row?.p ?? 0) + 1;
}

export async function createPage(
  env: Env,
  userId: string,
  input: { parent_id?: string | null; title?: string; icon?: string | null; content?: string | null; format?: "json" | "html"; text?: string; source_note_id?: number },
): Promise<PageSummary> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PAGES) throw new HTTPException(400, { message: `You can have up to ${MAX_PAGES} pages.` });
  const parentId = input.parent_id || null;
  await assertParent(env, userId, parentId);
  const now = Date.now();
  const page: PageSummary = {
    id: crypto.randomUUID(),
    parent_id: parentId,
    title: cleanTitle(input.title),
    icon: cleanIcon(input.icon),
    position: await nextPosition(env, userId, parentId),
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO pages (id, user_id, parent_id, title, icon, content, format, text, position, source_note_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(page.id, userId, parentId, page.title, page.icon, input.content ?? null, input.format ?? "json", (input.text ?? "").slice(0, MAX_TEXT_CHARS), page.position, input.source_note_id ?? null, now, now)
    .run();
  return page;
}

/** True when `candidate` is `id` itself or one of its descendants. */
export function isInSubtree(pages: Pick<PageSummary, "id" | "parent_id">[], id: string, candidate: string): boolean {
  const parentOf = new Map(pages.map((p) => [p.id, p.parent_id]));
  for (let cur: string | null | undefined = candidate, hops = 0; cur && hops <= pages.length; cur = parentOf.get(cur), hops++) {
    if (cur === id) return true;
  }
  return false;
}

export async function updatePage(
  env: Env,
  userId: string,
  id: string,
  patch: { title?: unknown; icon?: unknown; content?: unknown; text?: unknown; parent_id?: unknown; position?: unknown },
): Promise<{ updated_at: number }> {
  await getPage(env, userId, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) sets.push("title = ?"), args.push(cleanTitle(patch.title));
  if (patch.icon !== undefined) sets.push("icon = ?"), args.push(cleanIcon(patch.icon));
  if (patch.content !== undefined) {
    const content = typeof patch.content === "string" ? patch.content : JSON.stringify(patch.content);
    if (content.length > MAX_CONTENT_CHARS) throw new HTTPException(413, { message: "This page is too large to save. Split it into smaller pages." });
    sets.push("content = ?", "format = 'json'");
    args.push(content);
  }
  if (patch.text !== undefined) sets.push("text = ?"), args.push(String(patch.text ?? "").slice(0, MAX_TEXT_CHARS));
  if (patch.parent_id !== undefined) {
    const parentId = patch.parent_id ? String(patch.parent_id) : null;
    await assertParent(env, userId, parentId);
    if (parentId && isInSubtree(await listPages(env, userId), id, parentId)) {
      throw new HTTPException(400, { message: "A page can't be moved inside itself." });
    }
    sets.push("parent_id = ?");
    args.push(parentId);
    if (patch.position === undefined) sets.push("position = ?"), args.push(await nextPosition(env, userId, parentId));
  }
  if (patch.position !== undefined) {
    const pos = Number(patch.position);
    if (!Number.isFinite(pos)) throw new HTTPException(400, { message: "Invalid position" });
    sets.push("position = ?");
    args.push(pos);
  }
  const now = Date.now();
  if (!sets.length) return { updated_at: now };
  sets.push("updated_at = ?");
  args.push(now);
  await env.DB.prepare(`UPDATE pages SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...args, id, userId).run();
  return { updated_at: now };
}

/** Deletes a page and everything nested under it. */
export async function deletePage(env: Env, userId: string, id: string): Promise<void> {
  await getPage(env, userId, id);
  // Children first, deepest last-in, so the delete doesn't depend on foreign-key cascades being on.
  await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (SELECT id FROM pages WHERE id = ? AND user_id = ?
       UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.user_id = ?)
     DELETE FROM pages WHERE id IN (SELECT id FROM sub) AND user_id = ?`,
  )
    .bind(id, userId, userId, userId)
    .run();
}

const markdown = new Marked({ gfm: true, breaks: false });

/**
 * Notes are Markdown with $…$ / $$…$$ math; the editor's math nodes read data-latex. Code is left
 * alone, and "$5 and $10" stays text (inline math can't start or end with a space or precede a digit).
 */
export function noteToHtml(md: string): string {
  const html = markdown.parse(md, { async: false }) as string;
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\$\$([^$]+)\$\$/g, (_m, tex: string) => `<div data-type="block-math" data-latex="${escapeAttr(unescapeHtml(tex.trim()))}"></div>`)
            .replace(/\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (_m, tex: string) => `<span data-type="inline-math" data-latex="${escapeAttr(unescapeHtml(tex))}"></span>`),
    )
    .join("");
}

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Copies knowledge notes and session summaries into pages, under one "Imported notes" page.
 * Each note is imported once; running it again only picks up new notes.
 */
export async function importNotes(env: Env, userId: string): Promise<{ imported: number; parent_id: string | null; first_id: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.kind, k.title, k.content, k.created_at FROM knowledge k
      WHERE k.user_id = ? AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.user_id = k.user_id AND p.source_note_id = k.id)
      ORDER BY k.created_at`,
  )
    .bind(userId)
    .all<{ id: number; kind: string; title: string | null; content: string; created_at: number }>();
  if (!results.length) return { imported: 0, parent_id: null, first_id: null };
  let parent = await env.DB.prepare("SELECT id FROM pages WHERE user_id = ? AND parent_id IS NULL AND title = 'Imported notes' LIMIT 1").bind(userId).first<{ id: string }>();
  if (!parent) parent = await createPage(env, userId, { title: "Imported notes", icon: "🗂️" });
  let firstId: string | null = null;
  for (const note of results) {
    const title = note.title || (note.kind === "summary" ? "Session summary" : note.content.replace(/[#*_`>\-]/g, "").trim().slice(0, 60)) || "Note";
    const page = await createPage(env, userId, {
      parent_id: parent.id,
      title,
      icon: note.kind === "summary" ? "🧭" : "📝",
      content: noteToHtml(note.content),
      format: "html",
      text: note.content,
      source_note_id: note.id,
    });
    firstId ??= page.id;
  }
  return { imported: results.length, parent_id: parent.id, first_id: firstId };
}
