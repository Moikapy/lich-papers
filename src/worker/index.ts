import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { Message, ProviderConfig } from "@moikapy/lich";
import { clientIp, endSession, loadUser, currentUser, rateLimit, requireUser, sameOrigin, startSession } from "./auth";
import { getPaper, getPaperWithBody, parseArxivId, searchArxiv, type Paper } from "./arxiv";
import { hashPassword, verifyPassword } from "./crypto";
import { PROVIDERS, type AppEnv, type Ctx, type Env, type ProviderId, type User } from "./env";
import { addKnowledge, listKnowledge, searchKnowledge } from "./knowledge";
import { paperTools, runChat, safeProviderMessage, summarize, systemPrompt } from "./agent";
import {
  exchangeOpenRouterCode,
  freeUsageRemaining,
  listModels,
  loadKeys,
  openRouterCredits,
  adjustFreeUsage,
  reserveFreeUsage,
  resolveChain,
  SHARED_PROVIDER,
  saveKey,
  validateBaseUrl,
} from "./providers";

const app = new Hono<AppEnv>().basePath("/api");

/** Well-formed PBKDF2 hash nobody knows the password for; keeps login timing uniform. */
const DUMMY_HASH = `pbkdf2$100000$${"A".repeat(22)}==$${"A".repeat(43)}=`;

app.use("*", sameOrigin, loadUser);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

const json = async <T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> => {
  try {
    return ((await c.req.json()) ?? {}) as Partial<T>;
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON body" });
  }
};

const isProvider = (p: unknown): p is ProviderId => PROVIDERS.includes(p as ProviderId);

function arxivIdParam(raw: string): string {
  const id = parseArxivId(raw);
  if (!id) throw new HTTPException(400, { message: "Not a valid arXiv id" });
  return id;
}

// ---------------------------------------------------------------- auth

app.get("/me", (c) => c.json({ user: c.get("user") }));

app.post("/auth/signup", async (c) => {
  const { email, password } = await json<{ email: string; password: string }>(c);
  const mail = String(email ?? "").trim().toLowerCase();
  if (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new HTTPException(400, { message: "Enter a valid email" });
  if (String(password ?? "").length < 8) throw new HTTPException(400, { message: "Password must be at least 8 characters" });
  await rateLimit(c, `signup:${clientIp(c)}`, 10, 60 * 60_000);
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(mail).first();
  if (exists) throw new HTTPException(409, { message: "An account with that email already exists" });
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, mail, await hashPassword(String(password)), Date.now())
      .run();
  } catch (err) {
    // Lost the SELECT-then-INSERT race against the UNIQUE(email) constraint.
    if (/UNIQUE/i.test(String(err))) throw new HTTPException(409, { message: "An account with that email already exists" });
    throw err;
  }
  await startSession(c, id);
  return c.json({ user: { id, email: mail, default_provider: "openrouter", default_model: null } satisfies User });
});

app.post("/auth/login", async (c) => {
  const { email, password } = await json<{ email: string; password: string }>(c);
  const mail = String(email ?? "").trim().toLowerCase();
  await rateLimit(c, `login:${clientIp(c)}`, 30, 15 * 60_000);
  await rateLimit(c, `login:${clientIp(c)}:${mail.slice(0, 254)}`, 8, 15 * 60_000);
  const row = await c.env.DB.prepare("SELECT id, email, password_hash, default_provider, default_model FROM users WHERE email = ?")
    .bind(mail)
    .first<User & { password_hash: string }>();
  // Always run PBKDF2 (against a dummy hash when the account is missing) so timing doesn't reveal existence.
  const valid = await verifyPassword(String(password ?? ""), row?.password_hash ?? DUMMY_HASH);
  if (!row || !valid) {
    throw new HTTPException(401, { message: "Wrong email or password" });
  }
  await startSession(c, row.id);
  const { password_hash: _, ...user } = row;
  return c.json({ user });
});

app.post("/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- papers

app.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const category = c.req.query("category")?.trim() || undefined;
  if (!q && !category) return c.json({ total: 0, start: 0, papers: [] });
  const sort = c.req.query("sort");
  const result = await searchArxiv(
    {
      q,
      category,
      start: Math.max(0, Math.floor(Number(c.req.query("start") ?? 0)) || 0),
      max: Math.min(50, Math.max(1, Math.floor(Number(c.req.query("max") ?? 20)) || 20)),
      sort: sort === "submittedDate" || sort === "lastUpdatedDate" ? sort : "relevance",
    },
    c.executionCtx,
  );
  return c.json(result);
});

app.get("/papers/:id", async (c) => {
  const paper = await getPaper(c.env, arxivIdParam(c.req.param("id")), c.executionCtx);
  if (!paper) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  const { body: _, ...meta } = paper;
  return c.json({ paper: meta });
});

app.get("/papers/:id/text", async (c) => {
  const paper = await getPaperWithBody(c.env, arxivIdParam(c.req.param("id")), c.executionCtx);
  if (!paper) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  return c.json({ body: paper.body, source: paper.body_source });
});

/** Same-origin PDF proxy so the reader can embed it regardless of arXiv's framing headers. */
app.get("/papers/:id/pdf", async (c) => {
  const id = arxivIdParam(c.req.param("id"));
  const res = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { "user-agent": "LichPapers/0.1 (+https://github.com/moikapy/lich-papers)" },
    cf: { cacheTtlByStatus: { "200-299": 86_400, "400-599": 0 }, cacheEverything: true },
  } as RequestInit).catch(() => {
    throw new HTTPException(502, { message: "arXiv is unreachable right now" });
  });
  if (res.status === 404) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  if (!res.ok || !res.body) throw new HTTPException(502, { message: `arXiv returned ${res.status}` });
  return new Response(res.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${id.replace("/", "_")}.pdf"`,
      "cache-control": "public, max-age=86400",
    },
  });
});

// ---------------------------------------------------------------- settings / BYOK

app.get("/settings", requireUser, async (c) => {
  const user = currentUser(c);
  const keys = await loadKeys(c.env, user.id);
  const providers = Object.fromEntries(
    PROVIDERS.map((p) => {
      const k = keys.get(p);
      return [
        p,
        k
          ? { connected: true, source: k.source, base_url: k.base_url, key_hint: k.api_key ? `…${k.api_key.slice(-4)}` : null }
          : { connected: false },
      ];
    }),
  );
  const orKey = keys.get("openrouter")?.api_key;
  return c.json({
    default_provider: user.default_provider,
    default_model: user.default_model,
    providers,
    openrouter_credits: orKey ? await openRouterCredits(orKey) : null,
    shared_free: c.env.OPENROUTER_API_KEY
      ? { remaining_today: Math.max(0, await freeUsageRemaining(c.env, user.id)), limit: Number(c.env.FREE_DAILY_LIMIT ?? 50) }
      : null,
  });
});

app.put("/settings/keys/:provider", requireUser, async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HTTPException(404, { message: "Unknown provider" });
  const { api_key, base_url } = await json<{ api_key: string; base_url: string }>(c);
  const key = String(api_key ?? "").trim() || null;
  const base = validateBaseUrl(c.env, String(base_url ?? "").trim() || null);
  if (!key && !(provider === "ollama" && base)) throw new HTTPException(400, { message: "Enter an API key" });
  await saveKey(c.env, currentUser(c).id, provider, key, base);
  return c.json({ ok: true });
});

app.delete("/settings/keys/:provider", requireUser, async (c) => {
  await c.env.DB.prepare("DELETE FROM provider_keys WHERE user_id = ? AND provider = ?").bind(currentUser(c).id, c.req.param("provider")).run();
  return c.json({ ok: true });
});

app.post("/settings/openrouter/exchange", requireUser, async (c) => {
  const { code, verifier } = await json<{ code: string; verifier: string }>(c);
  if (!code || !verifier) throw new HTTPException(400, { message: "Missing code or verifier" });
  const key = await exchangeOpenRouterCode(String(code), String(verifier));
  await saveKey(c.env, currentUser(c).id, "openrouter", key, null, "oauth");
  return c.json({ ok: true });
});

app.put("/settings/default", requireUser, async (c) => {
  const { provider, model } = await json<{ provider: string; model: string }>(c);
  if (!isProvider(provider)) throw new HTTPException(400, { message: "Unknown provider" });
  await c.env.DB.prepare("UPDATE users SET default_provider = ?, default_model = ? WHERE id = ?")
    .bind(provider, String(model ?? "").trim() || null, currentUser(c).id)
    .run();
  return c.json({ ok: true });
});

app.get("/models/:provider", requireUser, async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HTTPException(404, { message: "Unknown provider" });
  return c.json({ models: await listModels(c.env, currentUser(c).id, provider) });
});

// ---------------------------------------------------------------- chat sessions

interface SessionRow {
  id: string;
  user_id: string;
  arxiv_id: string;
  title: string;
  summary: string | null;
  builds_on: string;
  created_at: number;
  updated_at: number;
}

async function ownSession(env: Env, userId: string, id: string): Promise<SessionRow> {
  const s = await env.DB.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?").bind(id, userId).first<SessionRow>();
  if (!s) throw new HTTPException(404, { message: "Session not found" });
  return s;
}

async function transcript(env: Env, sessionId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { results } = await env.DB.prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id")
    .bind(sessionId)
    .all<{ role: "user" | "assistant"; content: string }>();
  return results;
}

/**
 * Runs `run` with the shared-key quota reserved atomically up front, then settles the real
 * number of shared calls afterwards, even when the run throws or is aborted.
 */
async function metered<T>(
  env: Env,
  userId: string,
  providers: ProviderConfig[],
  run: (providers: ProviderConfig[], counter: { sharedCalls: number }) => Promise<T>,
): Promise<T> {
  const usesShared = providers.some((p) => p.name === SHARED_PROVIDER);
  const reserved = usesShared && (await reserveFreeUsage(env, userId));
  let usable = providers;
  if (usesShared && !reserved) {
    usable = providers.filter((p) => p.name !== SHARED_PROVIDER);
    if (!usable.length) {
      throw new HTTPException(429, {
        message: "You've used today's shared free messages. Connect your own OpenRouter account (free) in Settings to keep going.",
      });
    }
  }
  const counter = { sharedCalls: 0 };
  try {
    return await run(usable, counter);
  } finally {
    if (reserved) await adjustFreeUsage(env, userId, counter.sharedCalls - 1).catch((e) => console.warn("usage settle failed", e));
  }
}

/** Summarizes a session into the knowledge base (used for "build on" and the explicit button). */
async function summarizeSession(c: { env: Env; executionCtx: Ctx; req: { url: string } }, user: User, s: SessionRow): Promise<string | null> {
  const msgs = await transcript(c.env, s.id);
  if (!msgs.length) return null;
  const chain = await resolveChain(c.env, user, new URL(c.req.url).origin, {});
  const paper = await getPaper(c.env, s.arxiv_id, c.executionCtx);
  const { text } = await metered(c.env, user.id, chain.providers, (providers, counter) =>
    summarize(providers, paper?.title ?? s.arxiv_id, msgs, counter),
  );
  // Insert the replacement first, then drop older summaries, so a failure never loses the only copy.
  const newId = await addKnowledge(c.env, user.id, {
    content: `Session "${s.title}" on ${paper?.title ?? s.arxiv_id}:\n${text}`,
    kind: "summary",
    session_id: s.id,
    arxiv_id: s.arxiv_id,
    tags: paper?.categories.join(", ") ?? "",
  });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE chat_sessions SET summary = ? WHERE id = ?").bind(text, s.id),
    c.env.DB.prepare("DELETE FROM knowledge WHERE session_id = ? AND kind = 'summary' AND id != ?").bind(s.id, newId),
  ]);
  return text;
}

app.get("/sessions", requireUser, async (c) => {
  const user = currentUser(c);
  const arxiv = c.req.query("arxiv_id");
  const stmt = arxiv
    ? c.env.DB.prepare(
        `SELECT s.id, s.arxiv_id, s.title, s.summary, s.builds_on, s.created_at, s.updated_at, p.title AS paper_title,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
           FROM chat_sessions s LEFT JOIN papers p ON p.arxiv_id = s.arxiv_id
          WHERE s.user_id = ? AND s.arxiv_id = ? ORDER BY s.updated_at DESC`,
      ).bind(user.id, parseArxivId(arxiv) ?? arxiv)
    : c.env.DB.prepare(
        `SELECT s.id, s.arxiv_id, s.title, s.summary, s.builds_on, s.created_at, s.updated_at, p.title AS paper_title,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
           FROM chat_sessions s LEFT JOIN papers p ON p.arxiv_id = s.arxiv_id
          WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT 200`,
      ).bind(user.id);
  const { results } = await stmt.all();
  return c.json({ sessions: results.map((r: any) => ({ ...r, builds_on: JSON.parse(r.builds_on) })) });
});

app.post("/sessions", requireUser, async (c) => {
  const user = currentUser(c);
  const { arxiv_id, builds_on } = await json<{ arxiv_id: string; builds_on: string[] }>(c);
  const id = parseArxivId(String(arxiv_id ?? ""));
  if (!id) throw new HTTPException(400, { message: "Not a valid arXiv id" });
  const paper = await getPaper(c.env, id, c.executionCtx);
  if (!paper) throw new HTTPException(404, { message: "Paper not found on arXiv" });

  const parents: string[] = [];
  for (const pid of (Array.isArray(builds_on) ? builds_on : []).slice(0, 5)) {
    const parent = await ownSession(c.env, user.id, String(pid));
    if (!parent.summary) await summarizeSession(c, user, parent).catch((e) => console.warn("summary failed", e));
    parents.push(parent.id);
  }
  const sid = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO chat_sessions (id, user_id, arxiv_id, title, builds_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(sid, user.id, id, "New conversation", JSON.stringify(parents), now, now)
    .run();
  return c.json({ session: { id: sid, arxiv_id: id, title: "New conversation", summary: null, builds_on: parents, created_at: now, updated_at: now } });
});

app.get("/sessions/:id", requireUser, async (c) => {
  const user = currentUser(c);
  const s = await ownSession(c.env, user.id, c.req.param("id"));
  const { results } = await c.env.DB.prepare("SELECT id, role, content, meta, created_at FROM chat_messages WHERE session_id = ? ORDER BY id")
    .bind(s.id)
    .all<{ id: number; role: string; content: string; meta: string | null; created_at: number }>();
  const { user_id: _, ...session } = s;
  return c.json({
    session: { ...session, builds_on: JSON.parse(s.builds_on) },
    messages: results.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })),
  });
});

app.patch("/sessions/:id", requireUser, async (c) => {
  const user = currentUser(c);
  const s = await ownSession(c.env, user.id, c.req.param("id"));
  const { title } = await json<{ title: string }>(c);
  const t = String(title ?? "").trim().slice(0, 200);
  if (!t) throw new HTTPException(400, { message: "Title is empty" });
  await c.env.DB.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").bind(t, s.id).run();
  return c.json({ ok: true });
});

app.delete("/sessions/:id", requireUser, async (c) => {
  const user = currentUser(c);
  const s = await ownSession(c.env, user.id, c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM chat_messages WHERE session_id = ?").bind(s.id),
    c.env.DB.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(s.id),
  ]);
  return c.json({ ok: true });
});

app.post("/sessions/:id/summarize", requireUser, async (c) => {
  const user = currentUser(c);
  const s = await ownSession(c.env, user.id, c.req.param("id"));
  const summary = await summarizeSession(c, user, s);
  if (!summary) throw new HTTPException(400, { message: "Nothing to summarize yet" });
  return c.json({ summary });
});

app.post("/sessions/:id/messages", requireUser, async (c) => {
  const user = currentUser(c);
  const s = await ownSession(c.env, user.id, c.req.param("id"));
  const body = await json<{ content: string; provider: string; model: string }>(c);
  const input = String(body.content ?? "").trim();
  if (!input) throw new HTTPException(400, { message: "Message is empty" });
  if (input.length > 20_000) throw new HTTPException(400, { message: "Message is too long" });

  const chain = await resolveChain(c.env, user, new URL(c.req.url).origin, {
    provider: isProvider(body.provider) ? body.provider : undefined,
    model: body.model ? String(body.model) : undefined,
  });

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    try {
      await send("status", { text: "Loading paper…" });
      const paper = (await getPaperWithBody(c.env, s.arxiv_id, c.executionCtx)) as (Paper & { body: string }) | null;
      if (!paper) throw new HTTPException(404, { message: "Paper not found" });

      const past = await transcript(c.env, s.id);
      const history: Message[] = past.map((m) => ({ role: m.role, content: m.content }));
      const related = await searchKnowledge(c.env, user.id, `${paper.title} ${input}`, 5);
      const parentIds: string[] = JSON.parse(s.builds_on);
      const buildsOn: { title: string; summary: string }[] = [];
      for (const pid of parentIds) {
        const p = await c.env.DB.prepare("SELECT title, summary FROM chat_sessions WHERE id = ? AND user_id = ?").bind(pid, user.id).first<{ title: string; summary: string | null }>();
        if (p?.summary) buildsOn.push({ title: p.title, summary: p.summary });
      }

      const result = await metered(c.env, user.id, chain.providers, (providers, counter) => runChat({
        providers,
        counter,
        system: systemPrompt(paper, related.filter((r) => r.session_id !== s.id), buildsOn),
        tools: paperTools({ env: c.env, user, paper, sessionId: s.id, ctx: c.executionCtx }),
        history,
        input,
        signal: c.req.raw.signal,
        onEvent: (e) => void send(e.type, e),
      }));
      if (result.stopped === "aborted") return;

      const now = Date.now();
      const meta = { provider: result.provider, model: result.model, tools: result.tools, usage: result.usage };
      const stmts = [
        c.env.DB.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)").bind(s.id, input, now),
        c.env.DB.prepare("INSERT INTO chat_messages (session_id, role, content, meta, created_at) VALUES (?, 'assistant', ?, ?, ?)").bind(
          s.id,
          result.content,
          JSON.stringify(meta),
          now + 1,
        ),
        c.env.DB.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").bind(now, s.id),
      ];
      if (past.length === 0) {
        stmts.push(c.env.DB.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").bind(input.replace(/\s+/g, " ").slice(0, 80), s.id));
      }
      await c.env.DB.batch(stmts);
      await send("done", { content: result.content, meta });
    } catch (err) {
      console.error("chat failed", err);
      const message = err instanceof HTTPException ? err.message : safeProviderMessage(err);
      await send("error", { message: `The model request failed: ${message}` });
    }
  });
});

// ---------------------------------------------------------------- knowledge

app.get("/knowledge", requireUser, async (c) => {
  const user = currentUser(c);
  const q = c.req.query("q")?.trim();
  return c.json({ entries: q ? await searchKnowledge(c.env, user.id, q, 50) : await listKnowledge(c.env, user.id) });
});

app.post("/knowledge", requireUser, async (c) => {
  const { content, tags, arxiv_id } = await json<{ content: string; tags: string; arxiv_id: string }>(c);
  const text = String(content ?? "").trim();
  if (!text) throw new HTTPException(400, { message: "Note is empty" });
  const id = await addKnowledge(c.env, currentUser(c).id, {
    content: text,
    tags: String(tags ?? ""),
    arxiv_id: arxiv_id ? parseArxivId(String(arxiv_id)) : null,
  });
  return c.json({ id });
});

app.delete("/knowledge/:id", requireUser, async (c) => {
  await c.env.DB.prepare("DELETE FROM knowledge WHERE id = ? AND user_id = ?").bind(Number(c.req.param("id")), currentUser(c).id).run();
  return c.json({ ok: true });
});

app.all("*", (c) => c.json({ error: "Not found" }, 404));

export default app;
