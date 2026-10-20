import type { ProviderConfig } from "@moikapy/lich";
import type { Env } from "./env";

/**
 * Last-resort chat fallback on Workers AI, through the AI binding. It answers when every other
 * provider in the chain fails (most often OpenRouter's free-model limit, a 429), is billed to the
 * app's Cloudflare account, and is capped per user per day.
 */

export const WORKERS_AI_PROVIDER = "workers-ai-fallback";
/** Tool-calling model with an OpenAI-style chat schema ($0.06 / $0.40 per M input / output tokens). */
export const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";
/** Fallback answers per user per UTC day. */
export const DEFAULT_FALLBACK_DAILY = 20;

export const fallbackModel = (env: Env) => env.FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
export const fallbackDailyLimit = (env: Env) => {
  const n = Number(env.FALLBACK_DAILY_MESSAGES ?? DEFAULT_FALLBACK_DAILY);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_FALLBACK_DAILY;
};

/** free_usage row key for a user's fallback messages today (UTC). */
const dayKey = (now = Date.now()) => `fallback:${new Date(now).toISOString().slice(0, 10)}`;

export async function fallbackUsedToday(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT requests FROM free_usage WHERE user_id = ? AND day = ?").bind(userId, dayKey()).first<{ requests: number }>();
  return row?.requests ?? 0;
}

/** Counts one fallback message for today. */
export async function recordFallbackUse(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO free_usage (user_id, day, requests) VALUES (?, ?, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1`,
  )
    .bind(userId, dayKey())
    .run();
}

/**
 * The fallback provider for a user, or null when the AI binding is missing, the fallback is turned
 * off (FALLBACK_DAILY_MESSAGES=0) or the user has used today's fallback messages.
 */
export async function fallbackProvider(env: Env, userId: string): Promise<ProviderConfig | null> {
  const limit = fallbackDailyLimit(env);
  if (!env.AI || limit <= 0) return null;
  if ((await fallbackUsedToday(env, userId)) >= limit) return null;
  const model = fallbackModel(env);
  return {
    kind: "openai_compat",
    name: WORKERS_AI_PROVIDER,
    model,
    // Not a real endpoint: workersAiFetch answers every request through the binding.
    base_url: "https://workers-ai.binding/v1",
    fetch_fn: workersAiFetch(env.AI, model),
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
