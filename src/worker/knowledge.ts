import type { Env } from "./env";
import { tokenize } from "./paper-text";

export interface KnowledgeRow {
  id: number;
  session_id: string | null;
  arxiv_id: string | null;
  kind: "note" | "summary";
  title?: string | null;
  content: string;
  tags: string;
  created_at: number;
  paper_title?: string | null;
}

/** FTS5 MATCH expression: OR of quoted terms, so any overlap ranks. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set(tokenize(text))].slice(0, 24);
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ") : null;
}

export async function searchKnowledge(env: Env, userId: string, query: string, limit = 6): Promise<KnowledgeRow[]> {
  const match = ftsQuery(query);
  if (!match) return [];
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.session_id, k.arxiv_id, k.kind, k.title, k.content, k.tags, k.created_at, p.title AS paper_title
       FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid LEFT JOIN papers p ON p.arxiv_id = k.arxiv_id
      WHERE knowledge_fts MATCH ? AND k.user_id = ?
      ORDER BY bm25(knowledge_fts) LIMIT ?`,
  )
    .bind(match, userId, limit)
    .all<KnowledgeRow>();
  return results;
}

export async function listKnowledge(env: Env, userId: string, limit = 100): Promise<KnowledgeRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.session_id, k.arxiv_id, k.kind, k.title, k.content, k.tags, k.created_at, p.title AS paper_title
       FROM knowledge k LEFT JOIN papers p ON p.arxiv_id = k.arxiv_id
      WHERE k.user_id = ? ORDER BY k.created_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<KnowledgeRow>();
  return results;
}

export async function addKnowledge(
  env: Env,
  userId: string,
  entry: { content: string; title?: string | null; tags?: string; session_id?: string | null; arxiv_id?: string | null; kind?: "note" | "summary" },
): Promise<number> {
  const title = entry.title?.replace(/\s+/g, " ").trim().slice(0, 140) || null;
  const row = await env.DB.prepare(
    `INSERT INTO knowledge (user_id, session_id, arxiv_id, kind, title, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(userId, entry.session_id ?? null, entry.arxiv_id ?? null, entry.kind ?? "note", title, entry.content.slice(0, 8000), (entry.tags ?? "").slice(0, 300), Date.now())
    .first<{ id: number }>();
  return row!.id;
}

/** Notes (not session summaries) a free account can keep; Pro is unlimited. */
export const FREE_NOTE_LIMIT = 100;

/** Throws a user-facing message when a free account is at its note limit. */
export async function assertCanAddNote(env: Env, user: { id: string; plan: string }): Promise<void> {
  if (user.plan === "pro") return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM knowledge WHERE user_id = ? AND kind = 'note'").bind(user.id).first<{ n: number }>();
  if ((row?.n ?? 0) >= FREE_NOTE_LIMIT) {
    throw new NoteLimitError(`The free plan keeps up to ${FREE_NOTE_LIMIT} notes. Delete some, or upgrade to Pro for unlimited notes.`);
  }
}

export class NoteLimitError extends Error {}

const REPLAY_NOTE_CHARS = 500;

/** Flattens a stored note to one plain line so it cannot fake headings, lists, or system text when replayed. */
export function flattenNote(text: string, max = REPLAY_NOTE_CHARS): string {
  const flat = text.replace(/^[#\-*>\s]+/gm, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function formatKnowledge(rows: KnowledgeRow[]): string {
  return rows
    .map((r) => {
      const src = r.arxiv_id ? ` (arXiv:${r.arxiv_id})` : "";
      const tags = r.tags ? ` [${flattenNote(r.tags, 100)}]` : "";
      // Notes saved by the tutor during a session (not typed by the user) are labelled as such.
      const origin = r.kind === "note" && r.session_id ? "[tutor-written] " : "";
      const title = r.title ? `${flattenNote(r.title, 140)} — ` : "";
      return `- #${r.id} ${r.kind}${src}${tags}: ${origin}${title}${flattenNote(r.content)}`;
    })
    .join("\n");
}
