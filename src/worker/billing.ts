import { HTTPException } from "hono/http-exception";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Env } from "./env";
import { OPENROUTER_BASE } from "./providers";

// ---------------------------------------------------------------- Stripe (REST, no SDK)

/** Encodes nested params the way Stripe's form API expects: a[b][0][c]=v. */
export function stripeForm(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return parts.join("&");
}

export async function stripe<T = any>(env: Env, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPException(503, { message: "Billing is not configured yet" });
  const base = env.STRIPE_API_BASE ?? "https://api.stripe.com";
  const body = params ? stripeForm(params) : undefined;
  const url = method === "GET" && body ? `${base}/v1/${path}?${body}` : `${base}/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  // Deleting something Stripe has already deleted is a no-op for us.
  if (method === "DELETE" && res.status === 404) return {} as T;
  if (!res.ok) {
    console.error("stripe error", path, res.status, data?.error?.message);
    throw new HTTPException(502, { message: "The billing provider returned an error. Try again shortly." });
  }
  return data as T;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a Stripe-Signature header (t=…,v1=…) against the raw body.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export async function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, nowSeconds: number, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const fields = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = fields.find(([k]) => k === "t")?.[1];
  const sigs = fields.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  return sigs.some((s) => safeEqual(s, expected));
}

/** Subscription statuses that keep Pro access (past_due: Stripe is still retrying the card). */
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
}

/** Period end moved onto subscription items in newer Stripe API versions; accept both. */
export function periodEnd(sub: StripeSubscription): number | null {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return s ? s * 1000 : null;
}

// ---------------------------------------------------------------- OpenRouter key provisioning

const mgmtBase = (env: Env) => env.OPENROUTER_MGMT_BASE ?? OPENROUTER_BASE;

async function openRouterMgmt(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  if (!env.OPENROUTER_PROVISIONING_KEY) throw new Error("OPENROUTER_PROVISIONING_KEY is not set");
  const res = await fetch(`${mgmtBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`OpenRouter ${method} ${path} failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const proCapUsd = (env: Env) => Number(env.PRO_MONTHLY_CAP_USD ?? 4);

/**
 * Ensures the user has an enabled OpenRouter key capped at the monthly Pro allowance.
 * The limit resets on the 1st of each month (UTC), so worst-case model spend per subscriber is the cap.
 */
export async function ensureProKey(env: Env, userId: string): Promise<void> {
  const existing = await env.DB.prepare("SELECT key_hash FROM pro_keys WHERE user_id = ?").bind(userId).first<{ key_hash: string }>();
  if (existing) {
    await openRouterMgmt(env, "PATCH", `/keys/${existing.key_hash}`, { disabled: false, limit: proCapUsd(env) });
    return;
  }
  const created = await openRouterMgmt(env, "POST", "/keys", {
    name: `lich-papers pro ${userId}`,
    limit: proCapUsd(env),
    limit_reset: "monthly",
    include_byok_in_limit: true,
  });
  const hash = created?.data?.hash;
  const key = created?.key;
  if (!hash || !key) throw new Error("OpenRouter did not return a key");
  await env.DB.prepare("INSERT OR REPLACE INTO pro_keys (user_id, key_hash, api_key, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, hash, await encryptSecret(key, env.ENCRYPTION_KEY), Date.now())
    .run();
}

/** Deletes the user's Pro key at OpenRouter and locally. */
export async function revokeProKey(env: Env, userId: string): Promise<void> {
  const existing = await env.DB.prepare("SELECT key_hash FROM pro_keys WHERE user_id = ?").bind(userId).first<{ key_hash: string }>();
  if (!existing) return;
  await openRouterMgmt(env, "DELETE", `/keys/${existing.key_hash}`);
  await env.DB.prepare("DELETE FROM pro_keys WHERE user_id = ?").bind(userId).run();
}

export async function loadProKey(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT api_key FROM pro_keys WHERE user_id = ?").bind(userId).first<{ api_key: string }>();
  return row ? decryptSecret(row.api_key, env.ENCRYPTION_KEY) : null;
}

/** Remaining allowance on a Pro key this month (from OpenRouter's own accounting). */
export async function proAllowance(apiKey: string): Promise<{ limit: number | null; remaining: number | null; usage: number | null } | null> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const { data } = (await res.json()) as { data?: { limit?: number | null; limit_remaining?: number | null; usage?: number | null } };
    return data ? { limit: data.limit ?? null, remaining: data.limit_remaining ?? null, usage: data.usage ?? null } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Subscription sync

/**
 * Applies the current state of a Stripe subscription to the user: plan flags, and the Pro key.
 * Always called with a freshly fetched subscription, so out-of-order webhooks converge.
 */
export async function syncSubscription(env: Env, sub: StripeSubscription): Promise<void> {
  let userId = sub.metadata?.user_id ?? null;
  if (!userId) {
    const row = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(sub.customer).first<{ id: string }>();
    userId = row?.id ?? null;
  }
  if (!userId) {
    console.warn("stripe subscription for unknown user", sub.id);
    return;
  }
  const user = await env.DB.prepare("SELECT stripe_subscription_id, default_provider FROM users WHERE id = ?")
    .bind(userId)
    .first<{ stripe_subscription_id: string | null; default_provider: string }>();
  if (!user) return;
  const active = ACTIVE_STATUSES.has(sub.status);
  // A stale event for an old subscription must not downgrade a user who has since re-subscribed.
  if (!active && user.stripe_subscription_id && user.stripe_subscription_id !== sub.id) return;

  if (active) {
    await ensureProKey(env, userId);
    await env.DB.prepare(
      `UPDATE users SET plan = 'pro', plan_status = ?, plan_renews_at = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
         default_provider = CASE WHEN default_provider = 'openrouter' AND default_model IS NULL THEN 'pro' ELSE default_provider END
       WHERE id = ?`,
    )
      .bind(sub.status, periodEnd(sub), sub.customer, sub.id, userId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE users SET plan = 'free', plan_status = ?, plan_renews_at = NULL,
         default_provider = CASE WHEN default_provider = 'pro' THEN 'openrouter' ELSE default_provider END,
         default_model = CASE WHEN default_provider = 'pro' THEN NULL ELSE default_model END
       WHERE id = ?`,
    )
      .bind(sub.status, userId)
      .run();
    await revokeProKey(env, userId);
  }
}

// ---------------------------------------------------------------- Complimentary Pro

export function compUserIds(env: Env): Set<string> {
  return new Set((env.COMP_PRO_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Grants or removes complimentary Pro for IDs in COMP_PRO_USER_IDS. Returns the user's plan after
 * the check. Writes only when something changes. Paid subscriptions are left alone.
 */
export async function applyComp(env: Env, user: { id: string; plan: string }): Promise<"free" | "pro"> {
  const listed = compUserIds(env).has(user.id);
  const row = await env.DB.prepare("SELECT plan, plan_status FROM users WHERE id = ?").bind(user.id).first<{ plan: string; plan_status: string | null }>();
  if (!row) return "free";
  if (listed && row.plan !== "pro") {
    await ensureProKey(env, user.id);
    await env.DB.prepare(
      `UPDATE users SET plan = 'pro', plan_status = 'comp',
         default_provider = CASE WHEN default_provider = 'openrouter' AND default_model IS NULL THEN 'pro' ELSE default_provider END
       WHERE id = ?`,
    )
      .bind(user.id)
      .run();
    return "pro";
  }
  if (!listed && row.plan_status === "comp") {
    await env.DB.prepare(
      `UPDATE users SET plan = 'free', plan_status = NULL,
         default_provider = CASE WHEN default_provider = 'pro' THEN 'openrouter' ELSE default_provider END,
         default_model = CASE WHEN default_provider = 'pro' THEN NULL ELSE default_model END
       WHERE id = ?`,
    )
      .bind(user.id)
      .run();
    await revokeProKey(env, user.id);
    return "free";
  }
  return row.plan === "pro" ? "pro" : "free";
}
