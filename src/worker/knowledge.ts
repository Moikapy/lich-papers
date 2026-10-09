import type { Env } from "./env";
import { tokenize } from "./paper-text";

export interface KnowledgeRow {
  id: number;
  session_id: string | null;
  arxiv_id: string | null;
  kind: "note" | "summary";
  content: string;
  tags: string;
  created_at: number;
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
    `SELECT k.id, k.session_id, k.arxiv_id, k.kind, k.content, k.tags, k.created_at
       FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
      WHERE knowledge_fts MATCH ? AND k.user_id = ?
      ORDER BY bm25(knowledge_fts) LIMIT ?`,
  )
    .bind(match, userId, limit)
    .all<KnowledgeRow>();
  return results;
}

export async function listKnowledge(env: Env, userId: string, limit = 100): Promise<KnowledgeRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, session_id, arxiv_id, kind, content, tags, created_at FROM knowledge WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(userId, limit)
    .all<KnowledgeRow>();
  return results;
}

export async function addKnowledge(
  env: Env,
  userId: string,
  entry: { content: string; tags?: string; session_id?: string | null; arxiv_id?: string | null; kind?: "note" | "summary" },
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO knowledge (user_id, session_id, arxiv_id, kind, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(userId, entry.session_id ?? null, entry.arxiv_id ?? null, entry.kind ?? "note", entry.content.slice(0, 8000), (entry.tags ?? "").slice(0, 300), Date.now())
    .first<{ id: number }>();
  return row!.id;
}

export function formatKnowledge(rows: KnowledgeRow[]): string {
  return rows
    .map((r) => {
      const src = r.arxiv_id ? ` (arXiv:${r.arxiv_id})` : "";
      const tags = r.tags ? ` [${r.tags}]` : "";
      return `- #${r.id} ${r.kind}${src}${tags}: ${r.content}`;
    })
    .join("\n");
}
