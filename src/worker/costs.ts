import type { Env, User } from "./env";
import { OPENROUTER_BASE } from "./providers";
import { monthKey } from "./workers-ai";
import { compUserIds } from "./billing";

/**
 * Admin cost view: what the app pays for AI, estimated from usage_events token counts and list prices.
 * Replies on users' own keys cost the app nothing and are shown as tokens only.
 */

export const isAdmin = (env: Env, user: Pick<User, "id"> | null) =>
  !!user && (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(user.id);

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
}

/** Workers AI list prices (developers.cloudflare.com/workers-ai/models). */
const WORKERS_AI_PRICES: Record<string, Price> = {
  "@cf/zai-org/glm-4.7-flash": { input: 0.0605, output: 0.4 },
  clef: { input: 0.24, output: 0 },
  "clef-flash": { input: 0.09, output: 0 },
};

/** OpenRouter's public model prices, cached for a day. */
async function openRouterPrices(fetchFn: typeof fetch = fetch): Promise<Map<string, Price>> {
  const cache = (globalThis as { caches?: { default: Cache } }).caches?.default;
  const url = `${OPENROUTER_BASE}/models`;
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetchFn(url);
    if (!res.ok) return new Map();
    if (cache) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set("cache-control", "public, max-age=86400");
      await cache.put(url, copy);
    }
  }
  const data = (await res.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  const prices = new Map<string, Price>();
  for (const m of data.data ?? []) {
    const input = Number(m.pricing?.prompt) * 1e6;
    const output = Number(m.pricing?.completion) * 1e6;
    if (Number.isFinite(input) && Number.isFinite(output)) prices.set(m.id, { input, output });
  }
  return prices;
}

export type CostBasis = "user" | "list" | "flat" | "free" | "unknown";

/** Price for one usage row, from who paid and which provider/model answered. */
export function priceFor(row: { billed_to: string; provider: string | null; model: string | null }, openRouter: Map<string, Price>): { price: Price | null; basis: CostBasis } {
  if (row.billed_to === "user") return { price: null, basis: "user" };
  const provider = row.provider ?? "";
  const model = row.model ?? "";
  // Ollama Cloud is a flat monthly plan: no per-token cost.
  if (provider.startsWith("ollama")) return { price: null, basis: "flat" };
  if (provider.startsWith("workers-ai")) {
    const p = WORKERS_AI_PRICES[model];
    return p ? { price: p, basis: "list" } : { price: null, basis: "unknown" };
  }
  // OpenRouter (Pro key, trial key): free models cost nothing.
  if (model === "openrouter/free" || model.endsWith(":free")) return { price: { input: 0, output: 0 }, basis: "free" };
  const p = openRouter.get(model);
  return p ? { price: p, basis: "list" } : { price: null, basis: "unknown" };
}

export const costUsd = (p: Price | null, inTok: number, outTok: number) => (p ? (inTok * p.input + outTok * p.output) / 1e6 : 0);

interface Row {
  billed_to: string;
  provider: string | null;
  model: string | null;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CostReport {
  since: number;
  days: number;
  totals: { app_cost_usd: number; app_calls: number; user_paid_calls: number; user_paid_tokens: number };
  by_day: { day: string; app_cost_usd: number; calls: number }[];
  by_source: (Row & { cost_usd: number; basis: CostBasis })[];
  top_users: { id: string; email: string; plan: string; calls: number; app_cost_usd: number }[];
  /** Paying Pro subscribers, complimentary Pro accounts (COMP_PRO_USER_IDS), and free accounts. */
  plans: { free: number; pro: number; comp: number };
  pro_revenue_usd_month: number;
  fallback_this_month: { users: number; messages: number };
  unpriced_models: string[];
}

export async function costReport(env: Env, days: number, fetchFn?: typeof fetch): Promise<CostReport> {
  const since = Date.now() - days * 86_400_000;
  const db = env.DB;
  const [bySource, byDay, byUser, plans, fallback, openRouter] = await Promise.all([
    db
      .prepare(
        `SELECT billed_to, provider, model, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
           FROM usage_events WHERE created_at >= ? GROUP BY billed_to, provider, model ORDER BY calls DESC`,
      )
      .bind(since)
      .all<Row>(),
    db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, billed_to, provider, model, COUNT(*) AS calls,
                SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
           FROM usage_events WHERE created_at >= ? AND billed_to != 'user' GROUP BY day, billed_to, provider, model ORDER BY day`,
      )
      .bind(since)
      .all<Row & { day: string }>(),
    db
      .prepare(
        `SELECT e.user_id AS id, u.email, u.plan, e.billed_to, e.provider, e.model, COUNT(*) AS calls,
                SUM(e.prompt_tokens) AS prompt_tokens, SUM(e.completion_tokens) AS completion_tokens
           FROM usage_events e JOIN users u ON u.id = e.user_id
          WHERE e.created_at >= ? AND e.billed_to != 'user' GROUP BY e.user_id, e.billed_to, e.provider, e.model`,
      )
      .bind(since)
      .all<Row & { id: string; email: string; plan: string }>(),
    db.prepare("SELECT id, plan FROM users WHERE plan = 'pro' UNION ALL SELECT NULL, 'free' FROM users WHERE plan != 'pro'").all<{ id: string | null; plan: string }>(),
    db.prepare("SELECT COUNT(*) AS users, COALESCE(SUM(requests), 0) AS messages FROM free_usage WHERE day = ?").bind(monthKey()).first<{ users: number; messages: number }>(),
    openRouterPrices(fetchFn).catch(() => new Map<string, Price>()),
  ]);

  const unpriced = new Set<string>();
  const cost = (r: Row) => {
    const { price, basis } = priceFor(r, openRouter);
    if (basis === "unknown") unpriced.add(`${r.provider ?? "?"}/${r.model ?? "?"}`);
    return { cost: costUsd(price, r.prompt_tokens ?? 0, r.completion_tokens ?? 0), basis };
  };

  const sources = bySource.results.map((r) => {
    const { cost: c, basis } = cost(r);
    return { ...r, prompt_tokens: r.prompt_tokens ?? 0, completion_tokens: r.completion_tokens ?? 0, cost_usd: c, basis };
  });

  const dayTotals = new Map<string, { app_cost_usd: number; calls: number }>();
  for (const r of byDay.results) {
    const d = dayTotals.get(r.day) ?? { app_cost_usd: 0, calls: 0 };
    d.app_cost_usd += cost(r).cost;
    d.calls += r.calls;
    dayTotals.set(r.day, d);
  }

  const users = new Map<string, { id: string; email: string; plan: string; calls: number; app_cost_usd: number }>();
  for (const r of byUser.results) {
    const u = users.get(r.id) ?? { id: r.id, email: r.email, plan: r.plan, calls: 0, app_cost_usd: 0 };
    u.calls += r.calls;
    u.app_cost_usd += cost(r).cost;
    users.set(r.id, u);
  }

  const comp = compUserIds(env);
  const planCounts = { free: 0, pro: 0, comp: 0 };
  for (const p of plans.results) {
    if (p.plan !== "pro") planCounts.free++;
    else if (p.id && comp.has(p.id)) planCounts.comp++;
    else planCounts.pro++;
  }
  const app = sources.filter((s) => s.billed_to !== "user");
  const mine = sources.filter((s) => s.billed_to === "user");

  return {
    since,
    days,
    totals: {
      app_cost_usd: app.reduce((n, s) => n + s.cost_usd, 0),
      app_calls: app.reduce((n, s) => n + s.calls, 0),
      user_paid_calls: mine.reduce((n, s) => n + s.calls, 0),
      user_paid_tokens: mine.reduce((n, s) => n + s.prompt_tokens + s.completion_tokens, 0),
    },
    by_day: [...dayTotals].map(([day, v]) => ({ day, ...v })),
    by_source: sources,
    top_users: [...users.values()].sort((a, b) => b.app_cost_usd - a.app_cost_usd || b.calls - a.calls).slice(0, 25),
    plans: planCounts,
    pro_revenue_usd_month: (planCounts.pro * Number(env.PRO_PRICE_CENTS ?? 1000)) / 100,
    fallback_this_month: { users: fallback?.users ?? 0, messages: fallback?.messages ?? 0 },
    unpriced_models: [...unpriced],
  };
}
