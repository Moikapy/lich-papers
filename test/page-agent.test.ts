import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@moikapy/lich";
import { runChat } from "../src/worker/agent";
import { pageSystemPrompt, pageTools, type ClientBridge } from "../src/worker/page-agent";

function recorder(reply: (name: string, args: Record<string, unknown>) => string = () => "ok") {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const bridge: ClientBridge = async (name, args) => (calls.push({ name, args }), { ok: true, output: reply(name, args) });
  return { calls, bridge };
}
const tool = (bridge: ClientBridge, name: string) => pageTools(bridge).find((t) => t.name === name)!;
const ctx = {} as never;

describe("pageTools", () => {
  it("forwards valid calls to the browser", async () => {
    const r = recorder();
    await tool(r.bridge, "add_cell").execute({ language: "Python", code: "print(1)" }, ctx);
    await tool(r.bridge, "edit_cell").execute({ id: "c1", code: "x = 2", run: false }, ctx);
    expect(r.calls).toEqual([
      { name: "add_cell", args: { language: "python", code: "print(1)", run: true } },
      { name: "edit_cell", args: { id: "c1", code: "x = 2", run: false } },
    ]);
  });
  it("rejects bad arguments without bothering the browser", async () => {
    const r = recorder();
    expect((await tool(r.bridge, "add_cell").execute({ language: "rust", code: "fn main(){}" }, ctx)).ok).toBe(false);
    expect((await tool(r.bridge, "add_cell").execute({ language: "python", code: "  " }, ctx)).ok).toBe(false);
    expect((await tool(r.bridge, "run_cell").execute({}, ctx)).ok).toBe(false);
    expect((await tool(r.bridge, "append_to_page").execute({ markdown: "" }, ctx)).ok).toBe(false);
    expect(r.calls).toHaveLength(0);
  });
});

describe("pageSystemPrompt", () => {
  it("wraps the page as untrusted data and truncates long pages", () => {
    const p = pageSystemPrompt("Notes", "x".repeat(20_000));
    expect(p).toContain('page "Notes"');
    expect(p).toContain("<untrusted_page>");
    expect(p).toContain("call read_page for the rest");
    expect(pageSystemPrompt("", "")).toContain("(empty)");
  });
});

describe("page agent loop", () => {
  it("runs page tools through the bridge and feeds results back to the model", async () => {
    const requests: any[] = [];
    const replies = [
      { tool: { name: "add_cell", args: { language: "python", code: "print(6*7)" } } },
      { content: "It printed 42." },
    ];
    const provider: ProviderConfig = {
      kind: "openai_compat",
      name: "p",
      model: "m",
      base_url: "https://fake.test/v1",
      api_key: "k",
      fetch_fn: async (_u, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const r = replies.shift()!;
        const message = "tool" in r ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: r.tool!.name, arguments: JSON.stringify(r.tool!.args) } }] } : { role: "assistant", content: r.content };
        return Response.json({ id: "x", model: "m", choices: [{ index: 0, finish_reason: "tool" in r ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      },
    };
    const r = recorder(() => "Added cell c9 ran:\n42");
    const result = await runChat({ providers: [provider], system: pageSystemPrompt("T", ""), tools: pageTools(r.bridge), history: [], input: "compute", maxTurns: 6 });
    expect(result.content).toBe("It printed 42.");
    expect(r.calls).toEqual([{ name: "add_cell", args: { language: "python", code: "print(6*7)", run: true } }]);
    expect(requests[1].messages.find((m: any) => m.role === "tool").content).toContain("42");
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["read_page", "append_to_page", "add_cell", "edit_cell", "run_cell"]));
  });
});
