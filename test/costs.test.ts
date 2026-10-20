import { describe, expect, it } from "vitest";
import { costUsd, isAdmin, priceFor } from "../src/worker/costs";

const openRouter = new Map([["google/gemini-3.5-flash", { input: 0.3, output: 2.5 }]]);
const row = (billed_to: string, provider: string, model: string) => ({ billed_to, provider, model });

describe("priceFor", () => {
  it("charges the app nothing for users' own keys", () => {
    expect(priceFor(row("user", "openai", "gpt-5"), openRouter)).toEqual({ price: null, basis: "user" });
  });
  it("uses OpenRouter list prices for Pro, and $0 for free models", () => {
    expect(priceFor(row("pro", "pro", "google/gemini-3.5-flash"), openRouter)).toEqual({ price: { input: 0.3, output: 2.5 }, basis: "list" });
    expect(priceFor(row("trial", "openrouter-free-shared", "meta-llama/llama-4:free"), openRouter).basis).toBe("free");
    expect(priceFor(row("pro", "pro-free", "openrouter/free"), openRouter).basis).toBe("free");
  });
  it("uses Workers AI prices for the fallback and Clef, and treats Ollama as a flat plan", () => {
    expect(priceFor(row("fallback", "workers-ai-fallback", "@cf/zai-org/glm-4.7-flash"), openRouter)).toEqual({ price: { input: 0.0605, output: 0.4 }, basis: "list" });
    expect(priceFor(row("decision", "workers-ai-decision", "clef"), openRouter).price).toEqual({ input: 0.24, output: 0 });
    expect(priceFor(row("fallback", "ollama-fallback", "beam"), openRouter).basis).toBe("flat");
  });
  it("flags models it can't price", () => {
    expect(priceFor(row("pro", "pro", "some/new-model"), openRouter)).toEqual({ price: null, basis: "unknown" });
  });
});

describe("costUsd", () => {
  it("prices tokens per million", () => {
    expect(costUsd({ input: 0.3, output: 2.5 }, 1_000_000, 200_000)).toBeCloseTo(0.8);
    expect(costUsd(null, 5, 5)).toBe(0);
  });
});

describe("isAdmin", () => {
  it("only matches IDs in ADMIN_USER_IDS", () => {
    const env = { ADMIN_USER_IDS: " a1, b2 " } as any;
    expect(isAdmin(env, { id: "b2" })).toBe(true);
    expect(isAdmin(env, { id: "c3" })).toBe(false);
    expect(isAdmin({} as any, { id: "a1" })).toBe(false);
    expect(isAdmin(env, null)).toBe(false);
  });
});
