import type { ProviderConfig } from "@moikapy/lich";
import type { Env } from "./env";
// Circular with providers.ts, which is fine: these are only used inside functions.
import { OLLAMA_CLOUD_BASE, ollamaModelName } from "./providers";

/**
 * Last-resort chat fallback, paid for by the app. It answers when every other provider in the chain
 * fails (most often OpenRouter's free-model limit, a 429) and is capped per user per month (by plan). It runs on
 * the app's Ollama Cloud account when FALLBACK_OLLAMA_KEY is set (model FALLBACK_OLLAMA_MODEL,
 * default "beam"), otherwise on Workers AI through the AI binding.
 */

export const WORKERS_AI_PROVIDER = "workers-ai-fallback";
export const OLLAMA_FALLBACK_PROVIDER = "ollama-fallback";
export const FALLBACK_PROVIDERS: ReadonlySet<string> = new Set([WORKERS_AI_PROVIDER, OLLAMA_FALLBACK_PROVIDER]);
export const DEFAULT_OLLAMA_FALLBACK_MODEL = "beam";
/** Tool-calling model with an OpenAI-style chat schema ($0.06 / $0.40 per M input / output tokens). */
export const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";
/** Fallback answers per user per UTC calendar month, by plan. */
export const DEFAULT_FALLBACK_MONTHLY = { free: 20, pro: 300 } as const;

export const fallbackModel = (env: Env) => env.FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
const count = (raw: string | undefined, fallback: number) => {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};
/** FALLBACK_MONTHLY_MESSAGES (free) / FALLBACK_PRO_MONTHLY_MESSAGES (Pro); 0 turns the fallback off for that plan. */
export const fallbackMonthlyLimit = (env: Env, plan: "free" | "pro") =>
  plan === "pro" ? count(env.FALLBACK_PRO_MONTHLY_MESSAGES, DEFAULT_FALLBACK_MONTHLY.pro) : count(env.FALLBACK_MONTHLY_MESSAGES, DEFAULT_FALLBACK_MONTHLY.free);

/** free_usage row key for a user's fallback messages this month (UTC), e.g. "fallback:2026-10". */
export const monthKey = (now = Date.now()) => `fallback:${new Date(now).toISOString().slice(0, 7)}`;

export async function fallbackUsedThisMonth(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT requests FROM free_usage WHERE user_id = ? AND day = ?").bind(userId, monthKey()).first<{ requests: number }>();
  return row?.requests ?? 0;
}

/** Counts one fallback message for this month. */
export async function recordFallbackUse(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO free_usage (user_id, day, requests) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1`,
  )
    .bind(userId, monthKey())
    .run();
}

/**
 * The fallback provider for a user, or null when none is configured, the fallback is turned off
 * for the user's plan, or the user has used this month's fallback messages.
 */
export async function fallbackProvider(env: Env, user: { id: string; plan: "free" | "pro" }): Promise<ProviderConfig | null> {
  const limit = fallbackMonthlyLimit(env, user.plan);
  const ollamaKey = env.FALLBACK_OLLAMA_KEY?.trim();
  if ((!ollamaKey && !env.AI) || limit <= 0) return null;
  if ((await fallbackUsedThisMonth(env, user.id)) >= limit) return null;
  if (ollamaKey) {
    return {
      kind: "ollama",
      name: OLLAMA_FALLBACK_PROVIDER,
      model: ollamaModelName(env.FALLBACK_OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_FALLBACK_MODEL, OLLAMA_CLOUD_BASE),
      base_url: OLLAMA_CLOUD_BASE,
      api_key: ollamaKey,
      timeout_ms: 90_000,
    };
  }
  const model = fallbackModel(env);
  return {
    kind: "openai_compat",
    name: WORKERS_AI_PROVIDER,
    model,
    // Not a real endpoint: workersAiFetch answers every request through the binding.
    base_url: "https://workers-ai.binding/v1",
    fetch_fn: workersAiFetch(env.AI!, model),
    timeout_ms: 90_000,
  };
}

/**
 * A fetch that runs an OpenAI chat-completions request on Workers AI and answers in the same
 * format, so lich's OpenAI-compatible provider can use the binding.
 */
export function workersAiFetch(ai: Pick<Ai, "run">, model: string): typeof fetch {
  return async (_input, init) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return Response.json({ error: "bad request body" }, { status: 400 });
    }
    const { model: _model, stream: _stream, ...input } = body;
    try {
      const result = await ai.run(model as Parameters<Ai["run"]>[0], input as never, init?.signal ? ({ signal: init.signal } as never) : undefined);
      return Response.json(toChatCompletion(result, model));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Workers AI reports quota and capacity problems as errors; surface them as a 429 so lich treats them as such.
      const status = /\b(429|rate|capacity|quota|neuron)/i.test(message) ? 429 : 502;
      return Response.json({ error: message.slice(0, 500) }, { status });
    }
  };
}

/** Normalises a Workers AI text-generation result into an OpenAI chat completion. */
export function toChatCompletion(result: unknown, model: string): unknown {
  const r = (result ?? {}) as Record<string, any>;
  if (Array.isArray(r.choices)) return { model, ...r };
  // Older Workers AI shape: { response, tool_calls: [{ name, arguments }], usage }.
  const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
  const tool_calls = calls.map((c: any, i: number) => ({
    id: c.id ?? `call_${i}`,
    type: "function",
    function: {
      name: c.function?.name ?? c.name,
      arguments: typeof (c.function?.arguments ?? c.arguments) === "string" ? (c.function?.arguments ?? c.arguments) : JSON.stringify(c.function?.arguments ?? c.arguments ?? {}),
    },
  }));
  return {
    model,
    choices: [
      {
        index: 0,
        finish_reason: tool_calls.length ? "tool_calls" : "stop",
        message: { role: "assistant", content: typeof r.response === "string" ? r.response : "", ...(tool_calls.length ? { tool_calls } : {}) },
      },
    ],
    usage: r.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
