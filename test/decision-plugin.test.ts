import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@moikapy/lich";
import { paperTools, runChat } from "../src/worker/agent";
import type { Paper } from "../src/worker/arxiv";
import { decisionPlugin } from "../src/worker/decision-plugin";

const paper: Paper & { body: string } = {
  arxiv_id: "1706.03762",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani"],
  abstract: "Transformers.",
  categories: ["cs.CL"],
  published: "2017-06-12T00:00:00Z",
  updated: null,
  body_source: "html",
  body: "## 3.2 Attention\n\nScaled dot-product attention divides by the square root of the key dimension.",
};

/** D1 stand-in that records SQL and hands out note ids. */
function fakeDb() {
  const sql: { query: string; args: unknown[] }[] = [];
  const DB = {
    prepare(query: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => (sql.push({ query, args }), { id: 7 }),
          run: async () => (sql.push({ query, args }), { meta: { changes: 1 } }),
        }),
      };
    },
  };
  return { env: { DB } as any, sql };
}

function scripted(replies: ({ content: string } | { tool: { name: string; args: unknown } })[]): ProviderConfig {
  const fetch_fn: typeof fetch = async () => {
    const r = replies.shift()!;
    const message =
      "tool" in r
        ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
        : { role: "assistant", content: r.content };
    return Response.json({ id: "x", model: "m", choices: [{ index: 0, finish_reason: "tool" in r ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  return { kind: "openai_compat", name: "p", model: "m", base_url: "https://fake.test/v1", api_key: "k", fetch_fn };
}

afterEach(() => vi.unstubAllGlobals());

describe("decision plugin", () => {
  it("tags a note the tutor saved, through lich's after_tool_call hook", async () => {
    const decisions: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      decisions.push(body);
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: k === "math" ? 0.9 : 0.1 }])) });
    });
    const { env, sql } = fakeDb();
    const decision = { base_url: "https://ollama.test", model: "clef-flash", source: "user" as const };
    const plugin = decisionPlugin({ env, paper, decision, figures: async () => [] });
    const r = await runChat({
      providers: [scripted([{ tool: { name: "save_knowledge", args: { title: "Scaling", content: "Divide by √d_k.", tags: "attention" } } }, { content: "Saved, and here's why…" }])],
      system: "s",
      tools: paperTools({ env, user: { id: "u", plan: "pro" } as any, paper, sessionId: "s", onNoteSaved: plugin.onNoteSaved }),
      plugins: [plugin],
      history: [],
      input: "save this",
    });
    expect(r.tools).toEqual([expect.objectContaining({ name: "save_knowledge", ok: true })]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].state).toEqual({ title: "Scaling", note: "Divide by √d_k." });
    expect(sql.find((s) => s.query.startsWith("UPDATE knowledge SET tags"))?.args).toEqual(["attention, math", 7]);
  });

  it("offers inspect_figure alongside the paper tools, and captures passages read", async () => {
    const offered: string[] = [];
    const provider = scripted([{ tool: { name: "search_paper", args: { query: "square root key dimension" } } }, { content: "Done." }]);
    const inner = provider.fetch_fn!;
    provider.fetch_fn = async (url, init) => {
      if (!offered.length) offered.push(...JSON.parse(String(init?.body)).tools.map((t: any) => t.function.name));
      return inner(url, init);
    };
    const { env } = fakeDb();
    const plugin = decisionPlugin({ env, paper, decision: { base_url: "https://o.test", model: "clef", source: "user" }, figures: async () => [] });
    const r = await runChat({ providers: [provider], system: "s", tools: paperTools({ env, user: { id: "u" } as any, paper, sessionId: "s" }), plugins: [plugin], history: [], input: "q" });
    expect(offered).toEqual(expect.arrayContaining(["inspect_figure", "paper_figures", "search_paper"]));
    expect(r.passages.join()).toContain("square root of the key dimension");
  });
});
