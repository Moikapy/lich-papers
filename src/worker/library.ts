import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";

/** Generous caps that only stop runaway scripts. */
export const MAX_SAVED = 5000;
export const MAX_COLLECTIONS = 100;
export const MAX_COLLECTION_NAME = 60;

export interface Collection {
  id: number;
  name: string;
  paper_count: number;
}

export interface SavedPaper {
  arxiv_id: string;
  title: string | null;
  authors: string[];
  categories: string[];
  published: string | null;
  saved_at: number;
  collection_ids: number[];
}

/** Trims and collapses whitespace; null when empty. Throws when too long. */
export function normalizeCollectionName(raw: unknown): string | null {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (name.length > MAX_COLLECTION_NAME) throw new HTTPException(400, { message: `Collection names can be up to ${MAX_COLLECTION_NAME} characters` });
  return name;
}

export async function listCollections(env: Env, userId: string): Promise<Collection[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, (SELECT COUNT(*) FROM collection_papers cp WHERE cp.collection_id = c.id) AS paper_count
       FROM collections c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(userId)
    .all<Collection>();
  return results;
}

export async function listSaved(env: Env, userId: string): Promise<SavedPaper[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.arxiv_id, s.created_at AS saved_at, p.title, p.authors, p.categories, p.published,
            (SELECT json_group_array(cp.collection_id) FROM collection_papers cp WHERE cp.user_id = s.user_id AND cp.arxiv_id = s.arxiv_id) AS collection_ids
       FROM saved_papers s LEFT JOIN papers p ON p.arxiv_id = s.arxiv_id
      WHERE s.user_id = ? ORDER BY s.created_at DESC`,
  )
    .bind(userId)
    .all<{ arxiv_id: string; saved_at: number; title: string | null; authors: string | null; categories: string | null; published: string | null; collection_ids: string }>();
  return results.map((r) => ({
    ...r,
    authors: r.authors ? JSON.parse(r.authors) : [],
    categories: r.categories ? JSON.parse(r.categories) : [],
    collection_ids: JSON.parse(r.collection_ids),
  }));
}

/** Whether one paper is saved, and in which collections. */
export async function savedStatus(env: Env, userId: string, arxivId: string): Promise<{ saved: boolean; collection_ids: number[] }> {
  const [saved, cols] = await env.DB.batch<{ ok?: number; collection_id?: number }>([
    env.DB.prepare("SELECT 1 AS ok FROM saved_papers WHERE user_id = ? AND arxiv_id = ?").bind(userId, arxivId),
    env.DB.prepare("SELECT collection_id FROM collection_papers WHERE user_id = ? AND arxiv_id = ?").bind(userId, arxivId),
  ]);
  return { saved: saved!.results.length > 0, collection_ids: cols!.results.map((r) => r.collection_id!) };
}

/**
 * Saves a paper (idempotent). When `collectionIds` is given, the paper ends up in exactly
 * those collections; otherwise its collections are left as they are.
 */
export async function savePaper(env: Env, userId: string, arxivId: string, collectionIds?: number[]): Promise<void> {
  const existing = await env.DB.prepare("SELECT 1 FROM saved_papers WHERE user_id = ? AND arxiv_id = ?").bind(userId, arxivId).first();
  if (!existing) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM saved_papers WHERE user_id = ?").bind(userId).first<number>("n");
    if ((n ?? 0) >= MAX_SAVED) throw new HTTPException(400, { message: `You can save up to ${MAX_SAVED} papers. Remove some to save more.` });
  }
  const stmts = [env.DB.prepare("INSERT OR IGNORE INTO saved_papers (user_id, arxiv_id, created_at) VALUES (?, ?, ?)").bind(userId, arxivId, Date.now())];
  if (collectionIds) {
    const ids = [...new Set(collectionIds.map(Number).filter(Number.isInteger))];
    if (ids.length) {
      const own = await env.DB.prepare(`SELECT COUNT(*) AS n FROM collections WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
        .bind(userId, ...ids)
        .first<number>("n");
      if (own !== ids.length) throw new HTTPException(404, { message: "Collection not found" });
    }
    stmts.push(
      env.DB.prepare(
        `DELETE FROM collection_papers WHERE user_id = ? AND arxiv_id = ?${ids.length ? ` AND collection_id NOT IN (${ids.map(() => "?").join(",")})` : ""}`,
      ).bind(userId, arxivId, ...ids),
      ...ids.map((cid) => env.DB.prepare("INSERT OR IGNORE INTO collection_papers (collection_id, user_id, arxiv_id) VALUES (?, ?, ?)").bind(cid, userId, arxivId)),
    );
  }
  await env.DB.batch(stmts);
}

export async function unsavePaper(env: Env, userId: string, arxivId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM collection_papers WHERE user_id = ? AND arxiv_id = ?").bind(userId, arxivId),
    env.DB.prepare("DELETE FROM saved_papers WHERE user_id = ? AND arxiv_id = ?").bind(userId, arxivId),
  ]);
}

const isDuplicate = (err: unknown) => /UNIQUE/i.test(String(err));

export async function createCollection(env: Env, userId: string, rawName: unknown): Promise<Collection> {
  const name = normalizeCollectionName(rawName);
  if (!name) throw new HTTPException(400, { message: "Name the collection" });
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM collections WHERE user_id = ?").bind(userId).first<number>("n");
  if ((n ?? 0) >= MAX_COLLECTIONS) throw new HTTPException(400, { message: `You can have up to ${MAX_COLLECTIONS} collections` });
  try {
    const row = await env.DB.prepare("INSERT INTO collections (user_id, name, created_at) VALUES (?, ?, ?) RETURNING id")
      .bind(userId, name, Date.now())
      .first<{ id: number }>();
    return { id: row!.id, name, paper_count: 0 };
  } catch (err) {
    if (isDuplicate(err)) throw new HTTPException(409, { message: `You already have a collection called “${name}”` });
    throw err;
  }
}

export async function renameCollection(env: Env, userId: string, id: number, rawName: unknown): Promise<void> {
  const name = normalizeCollectionName(rawName);
  if (!name) throw new HTTPException(400, { message: "Name the collection" });
  try {
    const res = await env.DB.prepare("UPDATE collections SET name = ? WHERE id = ? AND user_id = ?").bind(name, id, userId).run();
    if (!res.meta?.changes) throw new HTTPException(404, { message: "Collection not found" });
  } catch (err) {
    if (isDuplicate(err)) throw new HTTPException(409, { message: `You already have a collection called “${name}”` });
    throw err;
  }
}

/** Deletes the collection; its papers stay saved. */
export async function deleteCollection(env: Env, userId: string, id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM collection_papers WHERE collection_id = ? AND user_id = ?").bind(id, userId),
    env.DB.prepare("DELETE FROM collections WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
}

// ---------------------------------------------------------------- popular

export const POPULAR_DAYS = 30;
/** A paper is listed only once this many different people saved it or discussed it, so no one's reading is singled out. */
export const POPULAR_MIN_READERS = 2;

export interface PopularPaper {
  arxiv_id: string;
  title: string;
  authors: string[];
  categories: string[];
  published: string | null;
  readers: number;
}

/** Papers the most people saved or started a conversation about recently. Aggregate counts only. */
export async function popularPapers(env: Env, limit = 10): Promise<PopularPaper[]> {
  const since = Date.now() - POPULAR_DAYS * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT p.arxiv_id, p.title, p.authors, p.categories, p.published, COUNT(*) AS readers
       FROM (SELECT user_id, arxiv_id FROM saved_papers WHERE created_at > ?1
             UNION
             SELECT user_id, arxiv_id FROM chat_sessions WHERE created_at > ?1) a
       JOIN papers p ON p.arxiv_id = a.arxiv_id
      GROUP BY p.arxiv_id
     HAVING readers >= ?2
      ORDER BY readers DESC, p.published DESC
      LIMIT ?3`,
  )
    .bind(since, POPULAR_MIN_READERS, limit)
    .all<{ arxiv_id: string; title: string; authors: string; categories: string; published: string | null; readers: number }>();
  return results.map((r) => ({ ...r, authors: JSON.parse(r.authors), categories: JSON.parse(r.categories) }));
}
