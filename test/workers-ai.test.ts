import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@moikapy/lich";
import { runChat, type UsageCounter } from "../src/worker/agent";
import { fallbackProvider, toChatCompletion, workersAiFetch, WORKERS_AI_PROVIDER } from "../src/worker/workers-ai";

/** Fake AI binding that records inputs and replays outputs. */
function fakeAi(outputs: unknown[]) {
  const calls: { model: string; input: any }[] = [];
  return {
    calls,
    ai: {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        const o = outputs.shift();
        if (o instanceof Error) throw o;
        return o;
      },
    } as any,
  };
}

/** D1 stand-in for free_usage lookups. */
function fakeDb(used: number) {
  const writes: unknown[][] = [];
  return {
    writes,
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => (sql.startsWith("SELECT") ? { requests: used } : null),
          run: async () => (writes.push(args), { meta: { changes: 1 } }),
        }),
      }),
    },
  };
}

describe("toChatCompletion", () => {
  it("passes an OpenAI-shaped result through", () => {
    const r = { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1 } };
    expect(toChatCompletion(r, "m")).toMatchObject({ model: "m", choices: r.choices });
  });
  it("converts the older { response, tool_calls } shape", () => {
    expect(toChatCompletion({ response: "", tool_calls: [{ name: "search_paper", arguments: { query: "loss" } }] }, "m")).toMatchObject({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "search_paper", arguments: '{"query":"loss"}' } }] } }],
    });
    expect(toChatCompletion({ response: "Answer." }, "m")).toMatchObject({ choices: [{ finish_reason: "stop", message: { content: "Answer." } }] });
  });
});

describe("workersAiFetch", () => {
  it("sends the chat body to the binding without model/stream", async () => {
    const f = fakeAi([{ response: "ok" }]);
    const res = await workersAiFetch(f.ai, "@cf/zai-org/glm-4.7-flash")("https://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "ignored", stream: false, messages: [{ role: "user", content: "q" }], tools: [] }),
    });
    expect(res.status).toBe(200);
    expect(f.calls[0]).toEqual({ model: "@cf/zai-org/glm-4.7-flash", input: { messages: [{ role: "user", content: "q" }], tools: [] } });
  });
  it("maps capacity errors to 429 and others to 502", async () => {
    const f = fakeAi([new Error("3036: account limited, neurons exhausted"), new Error("boom")]);
    const call = () => workersAiFetch(f.ai, "m")("https://x", { method: "POST", body: "{}" });
    expect((await call()).status).toBe(429);
    expect((await call()).status).toBe(502);
  });
});

describe("fallbackProvider", () => {
  it("is offered until the user's daily cap is used", async () => {
    const env = (used: number, extra: Record<string, unknown> = {}) => ({ AI: fakeAi([]).ai, ...fakeDb(used), ...extra }) as any;
    expect(await fallbackProvider(env(0), "u")).toMatchObject({ name: WORKERS_AI_PROVIDER, model: "@cf/zai-org/glm-4.7-flash" });
    expect(await fallbackProvider(env(19), "u")).not.toBeNull();
    expect(await fallbackProvider(env(20), "u")).toBeNull();
    expect(await fallbackProvider(env(0, { FALLBACK_DAILY_MESSAGES: "0" }), "u")).toBeNull();
    expect(await fallbackProvider({ ...fakeDb(0) } as any, "u")).toBeNull();
  });
});

describe("runChat failover", () => {
  it("answers on Workers AI when OpenRouter returns 429, and counts the fallback", async () => {
    const limited: ProviderConfig = {
      kind: "openai_compat",
      name: "openrouter-free",
      model: "openrouter/free",
      base_url: "https://fake.test/v1",
      api_key: "k",
      fetch_fn: async () => Response.json({ error: { message: "Rate limit exceeded: free-models-per-day" } }, { status: 429 }),
    };
    const f = fakeAi([{ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "From the fallback." } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }]);
    const fallback = (await fallbackProvider({ AI: f.ai, ...fakeDb(0) } as any, "u"))!;
    const counter: UsageCounter = { sharedCalls: 0 };
    const r = await runChat({ providers: [limited, fallback], system: "s", tools: [], history: [], input: "q", counter });
    expect(r.content).toBe("From the fallback.");
    expect(r.provider).toBe(WORKERS_AI_PROVIDER);
    expect(counter.fallbackCalls).toBe(1);
  });
});
