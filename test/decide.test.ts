import { describe, expect, it } from "vitest";
import {
  checkGrounding,
  choiceMargin,
  decide,
  mergeTags,
  readAnswer,
  rerank,
  routeQuestion,
  tagNote,
  toWire,
  type DecisionConfig,
} from "../src/worker/decide";
import { ollamaModelName } from "../src/worker/providers";

const cfg: DecisionConfig = { base_url: "https://ollama.test", api_key: "k", model: "clef-flash", source: "user" };

/** Fake /v1/systemone that answers with `respond(body)` and records requests. */
function fakeOllama(respond: (body: any) => unknown, status = 200) {
  const requests: any[] = [];
  const fetch_fn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), headers: init?.headers, body });
    return Response.json(respond(body), { status });
  };
  return { fetch_fn, requests };
}

describe("toWire", () => {
  it("matches the /v1/systemone question schema", () => {
    expect(
      toWire("clef-flash", { ticket: "x" }, {
        refund: { type: "noul", question: "Refund?", yes: "Refund requested", no: "No refund" },
        app: { type: "choice", question: "Which app?", options: { vscode: "VS Code", other: "Anything else" } },
        urgency: { type: "score", question: "How urgent?", levels: ["Routine", "Soon", "Immediate"] },
      }),
    ).toEqual({
      model: "clef-flash",
      state: { ticket: "x" },
      questions: {
        refund: { type: "noul", instructions: "Refund?", criteria: { false: "No refund", true: "Refund requested" } },
        app: { type: "choice", instructions: "Which app?", criteria: { vscode: "VS Code", other: "Anything else" } },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["Routine", "Soon", "Immediate"] },
      },
    });
  });
  it("adds images only when given", () => {
    expect(toWire("clef", "s", { a: { type: "noul", question: "q" } }, ["aGk="])).toMatchObject({ images: ["aGk="] });
    expect(toWire("clef", "s", { a: { type: "noul", question: "q" } }, [])).not.toHaveProperty("images");
  });
});

describe("readAnswer", () => {
  // Verbatim from ollama/ollama docs/capabilities/decision.mdx.
  const body = {
    model: "clef-flash",
    answers: {
      has_ollama: { type: "noul", noul: 0.959 },
      app: { type: "choice", choice: "vscode", probabilities: { vscode: 0.966, other: 0.017, browser: 0.01, terminal: 0.007 }, confidence: 0.868 },
      urgency: { type: "score", score: 0.8308, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.3, "1": 0.5, "2": 0.2 }, confidence: 0.4 },
    },
    usage: { input_tokens: 677, output_tokens: 0 },
  };
  const options = { vscode: "", other: "", browser: "", terminal: "" };

  it("reads noul as P(true)", () => {
    expect(readAnswer(body, "has_ollama", { type: "noul", question: "" })).toEqual({ type: "noul", p: 0.959 });
  });
  it("reads choice with its distribution and confidence", () => {
    const a = readAnswer(body, "app", { type: "choice", question: "", options });
    expect(a).toMatchObject({ type: "choice", label: "vscode", confidence: 0.868 });
    expect(choiceMargin(a as any)).toBeCloseTo(0.949);
  });
  it("reads score as the expected level index", () => {
    expect(readAnswer(body, "urgency", { type: "score", question: "", levels: ["a", "b", "c"] })).toEqual({ type: "score", score: 0.8308, confidence: 0.4 });
  });
  it("rejects missing answers and labels that weren't offered", () => {
    expect(readAnswer(body, "nope", { type: "noul", question: "" })).toBeNull();
    expect(readAnswer(body, "app", { type: "choice", question: "", options: { a: "", b: "" } })).toBeNull();
    expect(readAnswer(null, "app", { type: "noul", question: "" })).toBeNull();
  });
});

describe("decide", () => {
  it("posts to /v1/systemone with the bearer key", async () => {
    const o = fakeOllama(() => ({ answers: { x: { type: "noul", noul: 0.2 } } }));
    expect(await decide(cfg, "s", { x: { type: "noul", question: "q" } }, { fetch_fn: o.fetch_fn })).toEqual({ x: { type: "noul", p: 0.2 } });
    expect(o.requests[0].url).toBe("https://ollama.test/v1/systemone");
    expect(o.requests[0].headers.authorization).toBe("Bearer k");
  });
  it("fails open on HTTP errors", async () => {
    const o = fakeOllama(() => ({ error: "text and schema must not exceed 64 KiB" }), 413);
    expect(await decide(cfg, "s", { x: { type: "noul", question: "q" } }, { fetch_fn: o.fetch_fn })).toBeNull();
  });
});

describe("rerank", () => {
  const papers = [
    { arxiv_id: "a", title: "Cooking with lasers", abstract: "Food." },
    { arxiv_id: "b", title: "Diffusion models", abstract: "Exactly about diffusion." },
    { arxiv_id: "c", title: "Score matching", abstract: "Related." },
  ];
  it("scores each paper on its own and sorts by expected relevance", async () => {
    const scores: Record<string, number> = { a: 0.1, b: 2.9, c: 1.6 };
    const o = fakeOllama((body) => ({ answers: { relevance: { type: "score", score: scores[body.state.title === "Diffusion models" ? "b" : body.state.title === "Score matching" ? "c" : "a"], confidence: 0.5 } } }));
    const r = await rerank(cfg, "diffusion", papers, { fetch_fn: o.fetch_fn });
    expect(r?.map((p) => p.arxiv_id)).toEqual(["b", "c", "a"]);
    expect(o.requests).toHaveLength(3);
    expect(o.requests[0].body.state).toEqual({ query: "diffusion", title: "Cooking with lasers", abstract: "Food." });
  });
  it("keeps arXiv's order on ties and returns null when nothing scored", async () => {
    const tie = fakeOllama(() => ({ answers: { relevance: { type: "score", score: 1, confidence: 0 } } }));
    expect((await rerank(cfg, "q", papers, { fetch_fn: tie.fetch_fn }))?.map((p) => p.arxiv_id)).toEqual(["a", "b", "c"]);
    const down = fakeOllama(() => ({ error: "x" }), 500);
    expect(await rerank(cfg, "q", papers, { fetch_fn: down.fetch_fn })).toBeNull();
  });
});

describe("routeQuestion", () => {
  const choice = (probabilities: Record<string, number>, confidence: number) =>
    fakeOllama(() => ({ answers: { route: { type: "choice", choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], probabilities, confidence } } }));
  it("routes on a confident, clear-cut answer", async () => {
    const o = choice({ paper: 0.9, related: 0.05, knowledge: 0.03, general: 0.01, other: 0.01 }, 0.8);
    expect(await routeQuestion(cfg, "T", ["Intro"], "What is the loss?", { fetch_fn: o.fetch_fn })).toEqual({ route: "paper", p: 0.9 });
  });
  it("defers to the tutor when unsure or when two routes are close", async () => {
    const unsure = choice({ paper: 0.5, related: 0.2, knowledge: 0.1, general: 0.1, other: 0.1 }, 0.3);
    expect(await routeQuestion(cfg, "T", [], "q", { fetch_fn: unsure.fetch_fn })).toBeNull();
    const close = choice({ paper: 0.48, related: 0.44, knowledge: 0.04, general: 0.02, other: 0.02 }, 0.65);
    expect(await routeQuestion(cfg, "T", [], "q", { fetch_fn: close.fetch_fn })).toBeNull();
  });
});

describe("tagNote", () => {
  it("keeps up to three tags above the threshold, most likely first", async () => {
    const ps: Record<string, number> = { definition: 0.2, method: 0.95, result: 0.7, intuition: 0.65, math: 0.62, critique: 0.1, comparison: 0.3, question: 0.05 };
    const o = fakeOllama((body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: ps[k] }])) }));
    expect(await tagNote(cfg, "t", "c", { fetch_fn: o.fetch_fn })).toEqual(["method", "result", "intuition"]);
    expect(Object.keys(o.requests[0].body.questions)).toHaveLength(8);
  });
  it("merges with existing tags without duplicates", () => {
    expect(mergeTags("diffusion, Method", ["method", "result"])).toBe("diffusion, Method, result");
    expect(mergeTags("", ["math"])).toBe("math");
  });
});

describe("checkGrounding", () => {
  const ground = (supported: number, contradicts: number) =>
    fakeOllama(() => ({ answers: { supported: { type: "noul", noul: supported }, contradicts: { type: "noul", noul: contradicts } } }));
  it("combines support and contradiction", async () => {
    expect(await checkGrounding(cfg, "q", "a", ["p1"], "ex", { fetch_fn: ground(0.95, 0.02).fetch_fn })).toMatchObject({ verdict: "grounded", evidence: "passages" });
    expect(await checkGrounding(cfg, "q", "a", ["p1"], "ex", { fetch_fn: ground(0.9, 0.6).fetch_fn })).toMatchObject({ verdict: "unsupported" });
    expect(await checkGrounding(cfg, "q", "a", [], "ex", { fetch_fn: ground(0.6, 0).fetch_fn })).toMatchObject({ verdict: "partly", evidence: "excerpt" });
  });
  it("sends the most recent passages first as structured evidence", async () => {
    const o = ground(0.9, 0);
    await checkGrounding(cfg, "q", "a", ["old", "new"], "ex", { fetch_fn: o.fetch_fn });
    expect(o.requests[0].body.state).toEqual({ question: "q", answer: "a", evidence: ["new", "old"] });
  });
});

describe("ollamaModelName", () => {
  it("drops a :cloud tag for the cloud API", () => {
    expect(ollamaModelName("clef:cloud", "https://ollama.com")).toBe("clef");
    expect(ollamaModelName("clef:27b-cloud", null)).toBe("clef:27b");
  });
});
