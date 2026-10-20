import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { Message, ProviderConfig } from "@moikapy/lich";
import { clientIp, endSession, loadUser, currentUser, rateLimit, requireUser, sameOrigin, startSession } from "./auth";
import { getPaper, getPaperLicense, getPaperWithBody, isOpenLicense, licenseLabel, parseArxivId, purgeExpiredBodies, searchArxiv, type Paper } from "./arxiv";
import { hashPassword, verifyPassword } from "./crypto";
import { isPro, PROVIDERS, type AppEnv, type ChatProvider, type Ctx, type Env, type ProviderId, type User } from "./env";
import { createCollection, deleteCollection, listCollections, listSaved, popularPapers, renameCollection, savedStatus, savePaper, unsavePaper } from "./library";
import { addKnowledge, assertCanAddNote, autoTagNote, listKnowledge, NoteLimitError, searchKnowledge } from "./knowledge";
import { checkGrounding, decisionConfig, DECISION_MODELS, DECISIONS_OFF, rerank, routeQuestion, routingHint, serverDecisionConfig, userDecisionModel } from "./decide";
import { outline } from "./paper-text";
import { decisionPlugin } from "./decision-plugin";
import { recordFallbackUse } from "./workers-ai";
import { figureLoader, paperTools, runChat, type UsageCounter, safeProviderMessage, summarize, systemPrompt, type Budget } from "./agent";
import { applyComp, loadProKey, proAllowance, revokeProKey, proCapUsd, stripe, syncSubscription, verifyStripeSignature, type StripeSubscription } from "./billing";
import {
  exchangeOpenRouterCode,
  freeUsageRemaining,
  listModels,
  loadKeys,
  openRouterCredits,
  adjustFreeUsage,
  reserveFreeUsage,
  resolveChain,
  billedTo,
  PRO_PROVIDER,
  SHARED_PROVIDER,
  trialLimit,
  saveKey,
  isOllamaCloud,
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
const isChatProvider = (p: unknown): p is ChatProvider => p === "pro" || isProvider(p);

/** "Build on" sessions per new conversation. */
const BUILDS_ON_LIMIT = { free: 1, pro: 5 } as const;

const billingEnabled = (env: Env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.OPENROUTER_PROVISIONING_KEY);

function arxivIdParam(raw: string): string {
  const id = parseArxivId(raw);
  if (!id) throw new HTTPException(400, { message: "Not a valid arXiv id" });
  return id;
}

function collectionIdParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(404, { message: "Collection not found" });
  return id;
}

// ---------------------------------------------------------------- auth

app.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  // Complimentary Pro (COMP_PRO_USER_IDS) is applied here, on app load. Failures never block sign-in.
  if (c.env.COMP_PRO_USER_IDS || user.plan === "pro") {
    try {
      const plan = await applyComp(c.env, user);
      if (plan !== user.plan) {
        const fresh = await c.env.DB.prepare("SELECT id, email, default_provider, default_model, plan FROM users WHERE id = ?").bind(user.id).first<User>();
        return c.json({ user: fresh ?? user });
      }
    } catch (err) {
      console.error("comp check failed", err);
    }
  }
  return c.json({ user });
});

/** Bump when the Terms or Privacy Policy change materially; recorded per user at signup. */
const TERMS_VERSION = "2026-10-12";

/** Public site details the legal pages render. */
app.get("/site", (c) =>
  c.json({
    app_name: c.env.APP_NAME,
    operator: c.env.OPERATOR_NAME || null,
    contact_email: c.env.CONTACT_EMAIL || null,
    governing_law: c.env.GOVERNING_LAW || null,
    terms_version: TERMS_VERSION,
    price_cents: Number(c.env.PRO_PRICE_CENTS ?? 1000),
    monthly_cap_usd: proCapUsd(c.env),
  }),
);

app.post("/auth/signup", async (c) => {
  const { email, password, accept_terms } = await json<{ email: string; password: string; accept_terms: boolean }>(c);
  if (accept_terms !== true) throw new HTTPException(400, { message: "Please accept the Terms of Service and Privacy Policy" });
  const mail = String(email ?? "").trim().toLowerCase();
  if (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new HTTPException(400, { message: "Enter a valid email" });
  if (String(password ?? "").length < 8) throw new HTTPException(400, { message: "Password must be at least 8 characters" });
  await rateLimit(c, `signup:${clientIp(c)}`, 10, 60 * 60_000);
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(mail).first();
  if (exists) throw new HTTPException(409, { message: "An account with that email already exists" });
  const id = crypto.randomUUID();
  try {
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at, terms_accepted_at, terms_version) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, mail, await hashPassword(String(password)), now, now, TERMS_VERSION)
      .run();
  } catch (err) {
    // Lost the SELECT-then-INSERT race against the UNIQUE(email) constraint.
    if (/UNIQUE/i.test(String(err))) throw new HTTPException(409, { message: "An account with that email already exists" });
    throw err;
  }
  await startSession(c, id);
  return c.json({ user: { id, email: mail, default_provider: "openrouter", default_model: null, plan: "free" } satisfies User });
});

app.post("/auth/login", async (c) => {
  const { email, password } = await json<{ email: string; password: string }>(c);
  const mail = String(email ?? "").trim().toLowerCase();
  await rateLimit(c, `login:${clientIp(c)}`, 30, 15 * 60_000);
  await rateLimit(c, `login:${clientIp(c)}:${mail.slice(0, 254)}`, 8, 15 * 60_000);
  const row = await c.env.DB.prepare("SELECT id, email, password_hash, default_provider, default_model, plan FROM users WHERE email = ?")
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
    c.env,
    {
      q,
      category,
      start: Math.max(0, Math.floor(Number(c.req.query("start") ?? 0)) || 0),
      max: Math.min(50, Math.max(1, Math.floor(Number(c.req.query("max") ?? 20)) || 20)),
      sort: sort === "submittedDate" || sort === "lastUpdatedDate" ? sort : "relevance",
    },
    c.executionCtx,
  );
  // Optional: re-rank a relevance-sorted free-text search with the decision model.
  const user = c.get("user");
  if (c.req.query("rerank") === "1" && user && q && !parseArxivId(q) && sort !== "submittedDate" && sort !== "lastUpdatedDate") {
    const cfg = await decisionConfig(c.env, user);
    const ranked = cfg ? await rerank(cfg, q, result.papers) : null;
    if (ranked) return c.json({ ...result, papers: ranked, reranked: true });
  }
  return c.json(result);
});

app.get("/papers/:id", async (c) => {
  const paper = await getPaper(c.env, arxivIdParam(c.req.param("id")), c.executionCtx);
  if (!paper) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  const { body: _, ...meta } = paper;
  return c.json({ paper: meta });
});

/**
 * Full text for the reader. Shown only when the paper's license allows it (CC BY, CC BY-SA, CC0 /
 * public domain), with attribution. Every other paper gets its abstract and links to arXiv; the
 * tutor can still read those papers to answer questions, but the app doesn't republish them.
 */
app.get("/papers/:id/text", async (c) => {
  const id = arxivIdParam(c.req.param("id"));
  const meta = await getPaper(c.env, id, c.executionCtx);
  if (!meta) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  const license = await getPaperLicense(c.env, id);
  const links = {
    abs_url: `https://arxiv.org/abs/${id}`,
    html_url: `https://arxiv.org/html/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
  };
  const licenseInfo = { license, license_label: licenseLabel(license) };
  if (!isOpenLicense(license)) return c.json({ open: false, ...licenseInfo, ...links });
  const paper = await getPaperWithBody(c.env, id, c.executionCtx);
  return c.json({ open: true, body: paper!.body, source: paper!.body_source, ...licenseInfo, ...links });
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
  const plan = await c.env.DB.prepare("SELECT plan, plan_status, plan_renews_at, stripe_customer_id FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ plan: string; plan_status: string | null; plan_renews_at: number | null; stripe_customer_id: string | null }>();
  const proKey = isPro(user) ? await loadProKey(c.env, user.id) : null;
  const decisionModel = await userDecisionModel(c.env, user.id);
  const serverDecisions = !!serverDecisionConfig(c.env);
  return c.json({
    default_provider: user.default_provider,
    default_model: user.default_model,
    decision: {
      model: decisionModel,
      server_available: serverDecisions,
      active: !!(await decisionConfig(c.env, user)),
      models: DECISION_MODELS,
    },
    providers,
    openrouter_credits: orKey ? await openRouterCredits(orKey) : null,
    trial: c.env.OPENROUTER_API_KEY && !orKey && !isPro(user)
      ? { remaining: Math.max(0, await freeUsageRemaining(c.env, user.id)), limit: trialLimit(c.env) }
      : null,
    plan: {
      plan: plan?.plan ?? "free",
      status: plan?.plan_status ?? null,
      renews_at: plan?.plan_renews_at ?? null,
      has_billing_account: !!plan?.stripe_customer_id,
      price_cents: Number(c.env.PRO_PRICE_CENTS ?? 1000),
      monthly_cap_usd: proCapUsd(c.env),
      allowance: proKey ? await proAllowance(proKey) : null,
      billing_enabled: billingEnabled(c.env),
    },
  });
});

app.put("/settings/keys/:provider", requireUser, async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) throw new HTTPException(404, { message: "Unknown provider" });
  const { api_key, base_url } = await json<{ api_key: string; base_url: string }>(c);
  const key = String(api_key ?? "").trim() || null;
  const base = validateBaseUrl(c.env, String(base_url ?? "").trim() || null);
  if (provider === "ollama") {
    if (isOllamaCloud(base) && !key) throw new HTTPException(400, { message: "Ollama Cloud needs an API key (ollama.com → Settings → Keys)" });
  } else if (!key) {
    throw new HTTPException(400, { message: "Enter an API key" });
  }
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
  if (!isChatProvider(provider)) throw new HTTPException(400, { message: "Unknown provider" });
  if (provider === "pro" && !isPro(currentUser(c))) throw new HTTPException(402, { message: "Lich Pro models need an active Pro plan." });
  await c.env.DB.prepare("UPDATE users SET default_provider = ?, default_model = ? WHERE id = ?")
    .bind(provider, String(model ?? "").trim() || null, currentUser(c).id)
    .run();
  return c.json({ ok: true });
});

app.get("/settings/decision", requireUser, async (c) => c.json({ active: !!(await decisionConfig(c.env, currentUser(c))) }));

app.put("/settings/decision", requireUser, async (c) => {
  const { model } = await json<{ model: string | null }>(c);
  const value = model === null || model === undefined || String(model).trim() === "" ? null : String(model).trim().slice(0, 100);
  if (value && value !== DECISIONS_OFF && !/^[\w.:/-]+$/.test(value)) throw new HTTPException(400, { message: "Not a valid model name" });
  await c.env.DB.prepare("UPDATE users SET decision_model = ? WHERE id = ?").bind(value, currentUser(c).id).run();
  return c.json({ ok: true, active: !!(await decisionConfig(c.env, currentUser(c))) });
});

app.get("/models/:provider", requireUser, async (c) => {
  const provider = c.req.param("provider");
  if (!isChatProvider(provider)) throw new HTTPException(404, { message: "Unknown provider" });
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
  run: (providers: ProviderConfig[], counter: UsageCounter) => Promise<T>,
): Promise<T> {
  const usesShared = providers.some((p) => p.name === SHARED_PROVIDER);
  const reserved = usesShared && (await reserveFreeUsage(env, userId));
  let usable = providers;
  if (usesShared && !reserved) {
    usable = providers.filter((p) => p.name !== SHARED_PROVIDER);
    if (!usable.length) {
      throw new HTTPException(429, {
        message: "You've used your free trial messages. Connect your own OpenRouter account (free) or upgrade to Pro in Settings to keep going.",
      });
    }
  }
  const counter: UsageCounter = { sharedCalls: 0 };
  try {
    return await run(usable, counter);
  } finally {
    // The trial counts messages: keep the reserved unit only if the shared key actually answered.
    if (reserved && counter.sharedCalls === 0) await adjustFreeUsage(env, userId, -1).catch((e) => console.warn("usage settle failed", e));
    // The fallback cap counts messages it answered (any number of calls within one message).
    if (counter.fallbackCalls) await recordFallbackUse(env, userId).catch((e) => console.warn("fallback usage failed", e));
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
    title: `Session summary: ${s.title}`,
    content: text,
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

  const requestedParents = Array.isArray(builds_on) ? builds_on : [];
  const parentLimit = BUILDS_ON_LIMIT[user.plan];
  if (requestedParents.length > parentLimit) {
    throw new HTTPException(402, {
      message: isPro(user)
        ? `You can build on up to ${parentLimit} earlier sessions.`
        : `The free plan can build on ${parentLimit} earlier session at a time. Upgrade to Pro to combine up to ${BUILDS_ON_LIMIT.pro}.`,
    });
  }
  const parents: string[] = [];
  for (const pid of requestedParents) {
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
    provider: isChatProvider(body.provider) ? body.provider : undefined,
    model: body.model ? String(body.model) : undefined,
  });
  // Spend fewer tokens when the app, not the user, pays for the model.
  const primary = chain.providers[0]!.name;
  const budget: Budget = primary === PRO_PROVIDER || primary === SHARED_PROVIDER ? "lean" : "full";

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

      const decision = await decisionConfig(c.env, user);
      const routing = decision ? await routeQuestion(decision, paper.title, outline(paper.body), input) : null;
      const hint = routing ? routingHint(routing) : null;
      const figures = figureLoader(c.env, paper, c.executionCtx);
      const plugin = decision ? decisionPlugin({ env: c.env, paper, decision, figures, ctx: c.executionCtx }) : null;

      const result = await metered(c.env, user.id, chain.providers, (providers, counter) => runChat({
        providers,
        counter,
        budget,
        system: systemPrompt(paper, related.filter((r) => r.session_id !== s.id), buildsOn, budget, hint),
        tools: paperTools({ env: c.env, user, paper, sessionId: s.id, ctx: c.executionCtx, figures, onNoteSaved: plugin?.onNoteSaved }),
        plugins: plugin ? [plugin] : [],
        history,
        input,
        signal: c.req.raw.signal,
        onEvent: (e) => void send(e.type, e),
      }));
      if (result.stopped === "aborted") return;

      const now = Date.now();
      const meta: Record<string, unknown> = {
        provider: result.provider,
        model: result.model,
        tools: result.tools,
        usage: result.usage,
        ...(routing ? { routing: routing.route } : {}),
      };
      const stmts = [
        c.env.DB.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)").bind(s.id, input, now),
        c.env.DB.prepare("INSERT INTO chat_messages (session_id, role, content, meta, created_at) VALUES (?, 'assistant', ?, ?, ?)").bind(
          s.id,
          result.content,
          JSON.stringify(meta),
          now + 1,
        ),
        c.env.DB.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").bind(now, s.id),
        c.env.DB.prepare(
          "INSERT INTO usage_events (user_id, billed_to, provider, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(user.id, billedTo(result.provider), result.provider, result.model, result.usage.prompt_tokens, result.usage.completion_tokens, now),
      ];
      if (past.length === 0) {
        stmts.push(c.env.DB.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").bind(input.replace(/\s+/g, " ").slice(0, 80), s.id));
      }
      const saved = await c.env.DB.batch(stmts);
      await send("done", { content: result.content, meta });

      // After the answer is shown: check it against the passages the tutor read.
      // The answer is already saved and shown, so a failure here must not surface as an error.
      if (decision && result.stopped === "final" && paper.body_source !== "abstract") {
        try {
          await send("status", { text: "Checking the answer against the paper…" });
          const excerpt = paper.body.slice(0, 8000);
          const grounding = await checkGrounding(decision, input, result.content, result.passages, excerpt);
          if (grounding) {
            const messageId = saved[1]?.meta?.last_row_id;
            if (messageId) {
              await c.env.DB.prepare("UPDATE chat_messages SET meta = ? WHERE id = ?").bind(JSON.stringify({ ...meta, grounding }), messageId).run();
            }
            await send("grounding", grounding);
          }
        } catch (err) {
          console.warn("grounding check failed", err);
        }
      }
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
  const { content, title, tags, arxiv_id, session_id } = await json<{ content: string; title: string; tags: string; arxiv_id: string; session_id: string }>(c);
  const text = String(content ?? "").trim();
  if (!text) throw new HTTPException(400, { message: "Note is empty" });
  // A note saved from a chat answer links back to its conversation (only the user's own).
  const sessionId = session_id ? (await ownSession(c.env, currentUser(c).id, String(session_id))).id : null;
  try {
    await assertCanAddNote(c.env, currentUser(c));
  } catch (e) {
    if (e instanceof NoteLimitError) throw new HTTPException(402, { message: e.message });
    throw e;
  }
  const id = await addKnowledge(c.env, currentUser(c).id, {
    title: title ? String(title) : null,
    content: text,
    session_id: sessionId,
    tags: String(tags ?? ""),
    arxiv_id: arxiv_id ? parseArxivId(String(arxiv_id)) : null,
  });
  const decision = await decisionConfig(c.env, currentUser(c));
  if (decision) c.executionCtx.waitUntil(autoTagNote(c.env, decision, id, title ? String(title) : "", text, String(tags ?? "")));
  return c.json({ id });
});

/** Pro: download the whole knowledge base as Markdown (Obsidian/Notion friendly). */
app.get("/knowledge/export", requireUser, async (c) => {
  const user = currentUser(c);
  if (!isPro(user)) throw new HTTPException(402, { message: "Exporting your knowledge base is a Pro feature." });
  const { results } = await c.env.DB.prepare(
    `SELECT k.kind, k.title, k.content, k.tags, k.arxiv_id, k.created_at, p.title AS paper_title
       FROM knowledge k LEFT JOIN papers p ON p.arxiv_id = k.arxiv_id
      WHERE k.user_id = ? ORDER BY k.created_at`,
  )
    .bind(user.id)
    .all<{ kind: string; title: string | null; content: string; tags: string; arxiv_id: string | null; created_at: number; paper_title: string | null }>();
  const md = [
    "# Lich Papers knowledge base",
    "",
    ...results.map((k) => {
      const heading = k.title ?? (k.kind === "summary" ? "Session summary" : "Note");
      const lines = [`## ${heading} — ${new Date(k.created_at).toISOString().slice(0, 10)}`];
      if (k.arxiv_id) lines.push(`Source: [${k.paper_title ?? `arXiv:${k.arxiv_id}`}](https://arxiv.org/abs/${k.arxiv_id})`);
      if (k.tags) lines.push(`Tags: ${k.tags}`);
      lines.push("", k.content, "");
      return lines.join("\n");
    }),
  ].join("\n");
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="lich-papers-knowledge.md"`,
    },
  });
});

app.delete("/knowledge/:id", requireUser, async (c) => {
  await c.env.DB.prepare("DELETE FROM knowledge WHERE id = ? AND user_id = ?").bind(Number(c.req.param("id")), currentUser(c).id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- library (saved papers & collections)

app.get("/library", requireUser, async (c) => {
  const user = currentUser(c);
  const [papers, collections] = await Promise.all([listSaved(c.env, user.id), listCollections(c.env, user.id)]);
  return c.json({ papers, collections });
});

/** Just the saved ids, so search results can mark saved papers. */
app.get("/library/ids", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT arxiv_id FROM saved_papers WHERE user_id = ?").bind(currentUser(c).id).all<{ arxiv_id: string }>();
  return c.json({ ids: results.map((r) => r.arxiv_id) });
});

app.get("/library/papers/:id", requireUser, async (c) => {
  const user = currentUser(c);
  const id = arxivIdParam(c.req.param("id"));
  const [status, collections] = await Promise.all([savedStatus(c.env, user.id, id), listCollections(c.env, user.id)]);
  return c.json({ ...status, collections });
});

/** Saves a paper. With `collection_ids`, sets exactly which collections it's in. */
app.put("/library/papers/:id", requireUser, async (c) => {
  const user = currentUser(c);
  const id = arxivIdParam(c.req.param("id"));
  const { collection_ids } = await json<{ collection_ids: number[] }>(c);
  // Caches the paper's metadata so the library can list its title.
  if (!(await getPaper(c.env, id, c.executionCtx))) throw new HTTPException(404, { message: "Paper not found on arXiv" });
  await savePaper(c.env, user.id, id, Array.isArray(collection_ids) ? collection_ids : undefined);
  return c.json(await savedStatus(c.env, user.id, id));
});

app.delete("/library/papers/:id", requireUser, async (c) => {
  await unsavePaper(c.env, currentUser(c).id, arxivIdParam(c.req.param("id")));
  return c.json({ ok: true });
});

app.post("/library/collections", requireUser, async (c) => {
  const { name } = await json<{ name: string }>(c);
  return c.json({ collection: await createCollection(c.env, currentUser(c).id, name) });
});

app.patch("/library/collections/:id", requireUser, async (c) => {
  const { name } = await json<{ name: string }>(c);
  await renameCollection(c.env, currentUser(c).id, collectionIdParam(c.req.param("id")), name);
  return c.json({ ok: true });
});

app.delete("/library/collections/:id", requireUser, async (c) => {
  await deleteCollection(c.env, currentUser(c).id, collectionIdParam(c.req.param("id")));
  return c.json({ ok: true });
});

/** Public: papers the most people saved or discussed in the last 30 days (aggregate counts only). */
app.get("/popular", async (c) => {
  const papers = await popularPapers(c.env);
  return c.json({ papers }, 200, { "cache-control": "public, max-age=300" });
});

// ---------------------------------------------------------------- account: export & deletion

/** Everything stored about the user, as JSON (data portability). API keys are listed, never included. */
app.get("/account/export", requireUser, async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const [account, sessions, messages, knowledge, keys, usage, saved, collections, collectionPapers] = await Promise.all([
    db.prepare("SELECT id, email, plan, plan_status, plan_renews_at, default_provider, default_model, created_at, terms_accepted_at, terms_version FROM users WHERE id = ?").bind(user.id).first(),
    db.prepare("SELECT id, arxiv_id, title, summary, builds_on, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY created_at").bind(user.id).all(),
    db.prepare(
      "SELECT m.session_id, m.role, m.content, m.meta, m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.user_id = ? ORDER BY m.id",
    ).bind(user.id).all(),
    db.prepare("SELECT id, session_id, arxiv_id, kind, title, content, tags, created_at FROM knowledge WHERE user_id = ? ORDER BY created_at").bind(user.id).all(),
    db.prepare("SELECT provider, base_url, source, updated_at FROM provider_keys WHERE user_id = ?").bind(user.id).all(),
    db.prepare("SELECT billed_to, provider, model, prompt_tokens, completion_tokens, created_at FROM usage_events WHERE user_id = ? ORDER BY created_at").bind(user.id).all(),
    db.prepare("SELECT arxiv_id, created_at FROM saved_papers WHERE user_id = ? ORDER BY created_at").bind(user.id).all(),
    db.prepare("SELECT id, name, created_at FROM collections WHERE user_id = ? ORDER BY created_at").bind(user.id).all(),
    db.prepare("SELECT collection_id, arxiv_id FROM collection_papers WHERE user_id = ?").bind(user.id).all(),
  ]);
  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      account,
      chat_sessions: sessions.results,
      chat_messages: messages.results,
      knowledge: knowledge.results,
      connected_providers: keys.results,
      usage: usage.results,
      saved_papers: saved.results,
      collections: collections.results,
      collection_papers: collectionPapers.results,
    },
    null,
    2,
  );
  return new Response(body, {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="lich-papers-export.json"` },
  });
});

/**
 * Permanently deletes the account: cancels any Stripe subscription, deletes the Pro key and the
 * Stripe customer, then the user row (everything else cascades). Requires the password.
 */
app.post("/account/delete", requireUser, async (c) => {
  const user = currentUser(c);
  const { password } = await json<{ password: string }>(c);
  await rateLimit(c, `delete:${user.id}`, 5, 15 * 60_000);
  const row = await c.env.DB.prepare("SELECT password_hash, stripe_customer_id FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string; stripe_customer_id: string | null }>();
  if (!row || !(await verifyPassword(String(password ?? ""), row.password_hash))) {
    throw new HTTPException(401, { message: "Wrong password" });
  }
  // Deleting the Stripe customer also cancels its subscriptions immediately.
  if (row.stripe_customer_id && c.env.STRIPE_SECRET_KEY) {
    await stripe(c.env, "DELETE", `customers/${row.stripe_customer_id}`);
  }
  await revokeProKey(c.env, user.id);
  const ownSessions = "SELECT id FROM chat_sessions WHERE user_id = ?";
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM chat_messages WHERE session_id IN (${ownSessions})`).bind(user.id),
    c.env.DB.prepare("DELETE FROM knowledge WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM collection_papers WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM collections WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM saved_papers WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM chat_sessions WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM provider_keys WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM pro_keys WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM free_usage WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  await endSession(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- billing (Stripe)

app.post("/billing/checkout", requireUser, async (c) => {
  if (!billingEnabled(c.env)) throw new HTTPException(503, { message: "Pro isn't available yet." });
  const user = currentUser(c);
  if (isPro(user)) throw new HTTPException(409, { message: "You're already on Pro." });
  const origin = new URL(c.req.url).origin;
  const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(user.id).first<{ stripe_customer_id: string | null }>();
  let customer = row?.stripe_customer_id ?? null;
  if (!customer) {
    const created = await stripe<{ id: string }>(c.env, "POST", "customers", { email: user.email, metadata: { user_id: user.id } });
    customer = created.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(customer, user.id).run();
  }
  const session = await stripe<{ url: string }>(c.env, "POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Number(c.env.PRO_PRICE_CENTS ?? 1000),
          recurring: { interval: "month" },
          product_data: { name: `${c.env.APP_NAME} Pro` },
        },
      },
    ],
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: true,
    custom_text: {
      submit: {
        message: `Renews monthly until you cancel. Cancel anytime from Settings; no refunds for partial months. By subscribing you agree to the Terms at ${origin}/terms.`,
      },
    },
    success_url: `${origin}/settings?pro=success`,
    cancel_url: `${origin}/settings?pro=cancelled`,
  });
  return c.json({ url: session.url });
});

app.post("/billing/portal", requireUser, async (c) => {
  const user = currentUser(c);
  const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(user.id).first<{ stripe_customer_id: string | null }>();
  if (!row?.stripe_customer_id) throw new HTTPException(400, { message: "No billing account yet." });
  const session = await stripe<{ url: string }>(c.env, "POST", "billing_portal/sessions", {
    customer: row.stripe_customer_id,
    return_url: `${new URL(c.req.url).origin}/settings`,
  });
  return c.json({ url: session.url });
});

/** Stripe webhook. Verifies the signature, then syncs the subscription's current state. */
app.post("/billing/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HTTPException(503, { message: "Billing is not configured" });
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature"), secret, Math.floor(Date.now() / 1000)))) {
    throw new HTTPException(400, { message: "Bad signature" });
  }
  const event = JSON.parse(raw) as { id: string; type: string; data: { object: any } };
  const seen = await c.env.DB.prepare("SELECT 1 FROM stripe_events WHERE id = ?").bind(event.id).first();
  if (seen) return c.json({ received: true, duplicate: true });

  const obj = event.data.object;
  let subscriptionId: string | null = null;
  if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
    subscriptionId = obj.subscription;
    if (obj.client_reference_id && obj.customer) {
      await c.env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL")
        .bind(obj.customer, obj.client_reference_id)
        .run();
    }
  } else if (event.type.startsWith("customer.subscription.")) {
    subscriptionId = obj.id;
  } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    subscriptionId = obj.subscription ?? obj.parent?.subscription_details?.subscription ?? null;
  }

  if (subscriptionId) {
    // Re-fetch so the latest state wins regardless of event delivery order.
    const sub = await stripe<StripeSubscription>(c.env, "GET", `subscriptions/${subscriptionId}`);
    await syncSubscription(c.env, sub);
  }
  // Record only after success, so a failed sync is retried by Stripe.
  await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?, ?)").bind(event.id, Date.now()).run();
  return c.json({ received: true });
});

app.all("*", (c) => c.json({ error: "Not found" }, 404));

export default {
  fetch: app.fetch,
  /** Daily cron: drop full text past its short cache lifetime. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeExpiredBodies(env).then((n) => console.log(`purged ${n} expired paper bodies`)));
  },
} satisfies ExportedHandler<Env>;
