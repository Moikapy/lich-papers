import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@moikapy/lich";
import { paperTools, runChat, systemPrompt } from "../src/worker/agent";
import type { Paper } from "../src/worker/arxiv";

const paper: Paper & { body: string } = {
  arxiv_id: "1706.03762",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani"],
  abstract: "The dominant sequence transduction models are based on recurrent networks.",
  categories: ["cs.CL"],
  published: "2017-06-12T00:00:00Z",
  updated: null,
  body_source: "html",
  body: "## Abstract\n\nThe dominant sequence transduction models are based on recurrent networks.\n\n## 3.2 Attention\n\nScaled dot-product attention divides by the square root of the key dimension.",
};

type Reply = { content?: string; tool?: { name: string; args: unknown } };

/** OpenAI-compatible fake that replays scripted replies and records requests. */
function fakeProvider(name: string, replies: (Reply | number)[]): { cfg: ProviderConfig; requests: any[] } {
  const requests: any[] = [];
  const fetch_fn: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const r = replies.shift();
    if (typeof r === "number") return new Response("{}", { status: r });
    const message = r?.tool
      ? { role: "assistant", content: "", tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
      : { role: "assistant", content: r?.content ?? "" };
    return Response.json({
      id: "x",
      model: `${name}-model`,
      choices: [{ index: 0, finish_reason: r?.tool ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  };
  return { cfg: { kind: "openai_compat", name, model: `${name}-model`, base_url: "https://fake.test/v1", api_key: "k", fetch_fn }, requests };
}

const tools = paperTools({ env: {} as any, user: { id: "u" } as any, paper, sessionId: "s" });

describe("runChat", () => {
  it("runs the lich tool loop against the paper and reports tool use", async () => {
    const p = fakeProvider("primary", [{ tool: { name: "search_paper", args: { query: "scaled attention dimension" } } }, { content: "It divides by √d_k." }]);
    const events: string[] = [];
    const r = await runChat({
      providers: [p.cfg],
      system: systemPrompt(paper, [], []),
      tools,
      history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      input: "Why scale attention?",
      onEvent: (e) => events.push(e.type),
    });
    expect(r.content).toBe("It divides by √d_k.");
    expect(r.tools).toEqual([{ name: "search_paper", args: { query: "scaled attention dimension" }, ok: true }]);
    expect(r.model).toBe("primary-model");
    expect(events).toContain("tool_start");
    // The tool result fed back to the model contains the matching passage.
    const toolMsg = p.requests[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("square root of the key dimension");
    // Only our tools are offered (lich's git_commit is hidden).
    const offered = p.requests[0].tools.map((t: any) => t.function.name);
    expect(offered).not.toContain("git_commit");
    expect(offered).toContain("read_paper");
    // System prompt and history are passed through.
    expect(p.requests[0].messages[0].content).toContain("Attention Is All You Need");
    expect(p.requests[0].messages.slice(1, 3).map((m: any) => m.content)).toEqual(["hi", "hello"]);
  });

  it("fails over to the next provider and counts shared free-router calls", async () => {
    const bad = fakeProvider("primary", [401]);
    const shared = fakeProvider("openrouter-free-shared", [{ content: "fallback answer" }]);
    const r = await runChat({ providers: [bad.cfg, shared.cfg], system: "s", tools, history: [], input: "q" });
    expect(r.content).toBe("fallback answer");
    expect(r.provider).toBe("openrouter-free-shared");
    expect(r.sharedCalls).toBe(1);
  });
});

describe("systemPrompt", () => {
  it("includes builds-on summaries and knowledge notes", () => {
    const s = systemPrompt(paper, [{ id: 3, session_id: "x", arxiv_id: "2001.1", kind: "note", content: "Softmax saturates", tags: "", created_at: 0 }], [
      { title: "Earlier chat", summary: "- learned about RNNs" },
    ]);
    expect(s).toContain("### Earlier chat");
    expect(s).toContain("#3 note (arXiv:2001.1): Softmax saturates");
    expect(s).toContain("- 3.2 Attention");
  });
});
