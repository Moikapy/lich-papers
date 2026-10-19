import type { Env, User } from "./env";
import { isOllamaCloud, loadKeys, ollamaModelName, OLLAMA_CLOUD_BASE } from "./providers";

/**
 * Decision models (Clef, Clef Flash, …) served by Ollama's /v1/systemone endpoint or by Workers AI
 * (`env.AI`, same System One request and response). They don't chat:
 * they take a `state` (text, plus optional images) and a set of typed questions, and return one
 * decision per question. Every caller treats them as optional: on any failure they get null and
 * carry on as if no decision model were configured.
 */

export const DECISION_MODELS = [
  { id: "clef-flash", name: "Clef Flash (9B, fast)" },
  { id: "clef", name: "Clef (27B, more accurate)" },
] as const;
export const DEFAULT_DECISION_MODEL = "clef-flash";
/** Stored in users.decision_model to switch decisions off even when the server offers them. */
export const DECISIONS_OFF = "off";

export type DecisionConfig =
  | {
      kind?: "ollama";
      base_url: string;
      api_key?: string;
      model: string;
      /** Who pays: the user's own Ollama key, or the server's. */
      source: "user" | "server";
    }
  | {
      kind: "workers_ai";
      ai: Pick<Ai, "run">;
      model: WorkersAiModel;
      /** Workers AI is always billed to the app's Cloudflare account. */
      source: "server";
    };

/** Clef models on Workers AI, by their System One model selector. */
export const WORKERS_AI_MODELS = { clef: "@cf/cloudflare/clef", "clef-flash": "@cf/cloudflare/clef-flash" } as const;
export type WorkersAiModel = keyof typeof WORKERS_AI_MODELS;
const isWorkersAiModel = (m: string): m is WorkersAiModel => m in WORKERS_AI_MODELS;

/** An image for a vision decision model: raw base64 plus its media type. */
export interface DecisionImage {
  base64: string;
  type: string;
}

export type Question =
  /** Yes/no, answered with P(true). `yes`/`no` describe when each holds. */
  | { type: "noul"; question: string; yes?: string; no?: string }
  /** One of 2–26 labels, each with a description of when it applies. */
  | { type: "choice"; question: string; options: Record<string, string> }
  /** An ordinal scale of 2–10 anchored levels, lowest first. */
  | { type: "score"; question: string; levels: string[] };

export type Answer =
  | { type: "noul"; p: number }
  /** `confidence` is how concentrated the distribution is, not calibrated correctness. */
  | { type: "choice"; label: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is the probability-weighted level index, 0 … levels-1 (not rounded). */
  | { type: "score"; score: number; confidence: number };

/** The user's choice of decision model; null means "default" (the server's, if it has one). */
export async function userDecisionModel(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT decision_model FROM users WHERE id = ?").bind(userId).first<{ decision_model: string | null }>();
  return row?.decision_model ?? null;
}

/**
 * Which decision model to use for a user, if any:
 *   1. the model they picked, on their own Ollama key (cloud or self-hosted);
 *   2. otherwise the app's shared one: Workers AI (the `AI` binding) when DECISION_BACKEND is
 *      "workers-ai", or Ollama when DECISION_OLLAMA_KEY / a self-hosted DECISION_OLLAMA_BASE is set;
 *   3. otherwise none.
 */
export async function decisionConfig(env: Env, user: Pick<User, "id"> | null): Promise<DecisionConfig | null> {
  const choice = user ? await userDecisionModel(env, user.id) : null;
  if (choice === DECISIONS_OFF) return null;
  if (user && choice) {
    const k = (await loadKeys(env, user.id)).get("ollama");
    if (k && (k.api_key || !isOllamaCloud(k.base_url))) {
      return {
        base_url: k.base_url ?? OLLAMA_CLOUD_BASE,
        ...(k.api_key ? { api_key: k.api_key } : {}),
        model: ollamaModelName(choice, k.base_url),
        source: "user",
      };
    }
  }
  return serverDecisionConfig(env);
}

/** The app's shared decision model, if the server has one configured. */
export function serverDecisionConfig(env: Env): DecisionConfig | null {
  if (env.DECISION_BACKEND === "workers-ai") {
    const model = (env.DECISION_MODEL ?? DEFAULT_DECISION_MODEL).trim();
    if (!env.AI || !isWorkersAiModel(model)) {
      console.warn("DECISION_BACKEND=workers-ai needs the AI binding and DECISION_MODEL of clef or clef-flash");
      return null;
    }
    return { kind: "workers_ai", ai: env.AI, model, source: "server" };
  }
  if (env.DECISION_OLLAMA_KEY || (env.DECISION_OLLAMA_BASE && !isOllamaCloud(env.DECISION_OLLAMA_BASE))) {
    const base = env.DECISION_OLLAMA_BASE ?? OLLAMA_CLOUD_BASE;
    return {
      base_url: base,
      ...(env.DECISION_OLLAMA_KEY ? { api_key: env.DECISION_OLLAMA_KEY } : {}),
      model: ollamaModelName(env.DECISION_MODEL ?? DEFAULT_DECISION_MODEL, base),
      source: "server",
    };
  }
  return null;
}

/**
 * System One request body (ollama/ollama docs/capabilities/decision.mdx; Workers AI's Clef schema).
 * Ollama takes images as bare base64; Workers AI as data URLs.
 */
export function toWire(model: string, state: string | object, questions: Record<string, Question>, images?: string[]): unknown {
  const qs: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    switch (q.type) {
      case "noul":
        qs[name] = { type: "noul", instructions: q.question, ...(q.yes && q.no ? { criteria: { false: q.no, true: q.yes } } : {}) };
        break;
      case "choice":
        qs[name] = { type: "choice", instructions: q.question, criteria: q.options };
        break;
      case "score":
        qs[name] = { type: "score", instructions: q.question, criteria: q.levels };
        break;
    }
  }
  return { model, state, questions: qs, ...(images?.length ? { images } : {}) };
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads one question's decision out of a /v1/systemone response (`answers` keyed by question name). */
export function readAnswer(body: unknown, name: string, q: Question): Answer | null {
  const raw = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers?.[name];
  if (!raw || typeof raw !== "object") return null;
  switch (q.type) {
    case "noul": {
      const p = asNum(raw.noul);
      return p === null ? null : { type: "noul", p: Math.min(1, Math.max(0, p)) };
    }
    case "choice": {
      const label = typeof raw.choice === "string" && raw.choice in q.options ? raw.choice : null;
      if (!label) return null;
      const probabilities: Record<string, number> = {};
      for (const [k, v] of Object.entries((raw.probabilities as Record<string, unknown>) ?? {})) {
        const n = asNum(v);
        if (n !== null) probabilities[k] = n;
      }
      return { type: "choice", label, probabilities, confidence: asNum(raw.confidence) ?? 0 };
    }
    case "score": {
      const score = asNum(raw.score);
      return score === null ? null : { type: "score", score: Math.min(q.levels.length - 1, Math.max(0, score)), confidence: asNum(raw.confidence) ?? 0 };
    }
  }
}

/** Gap between the two most likely labels of a choice answer. */
export function choiceMargin(a: Extract<Answer, { type: "choice" }>): number {
  const ps = Object.values(a.probabilities).sort((x, y) => y - x);
  return ps.length < 2 ? 1 : ps[0]! - ps[1]!;
}

/**
 * Asks the decision model several questions about one state in a single request (1–64 questions;
 * each is answered independently). Returns the answers it could read, or null if the call failed.
 */
export async function decide<Q extends Record<string, Question>>(
  cfg: DecisionConfig,
  state: string | object,
  questions: Q,
  opts: { images?: DecisionImage[]; timeoutMs?: number; fetch_fn?: typeof fetch } = {},
): Promise<Partial<Record<keyof Q, Answer>> | null> {
  try {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let body: unknown;
    if (cfg.kind === "workers_ai") {
      const images = opts.images?.map((i) => `data:${i.type};base64,${i.base64}`);
      const run = cfg.ai.run(WORKERS_AI_MODELS[cfg.model] as Parameters<Ai["run"]>[0], toWire(cfg.model, state, questions, images) as never);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Workers AI decision timed out")), timeoutMs)));
      const result = (await Promise.race([run, timeout]).finally(() => clearTimeout(timer))) as { answers?: unknown; result?: unknown };
      // Workers AI returns the model output directly; the REST API wraps it in `result`.
      body = result?.answers ? result : result?.result;
    } else {
      const res = await (opts.fetch_fn ?? fetch)(`${cfg.base_url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}) },
        body: JSON.stringify(toWire(cfg.model, state, questions, opts.images?.map((i) => i.base64))),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        console.warn("decision model failed", res.status, err?.error ?? "");
        return null;
      }
      body = await res.json();
    }
    const out: Partial<Record<keyof Q, Answer>> = {};
    for (const [name, q] of Object.entries(questions)) {
      const a = readAnswer(body, name, q);
      if (a) out[name as keyof Q] = a;
    }
    return out;
  } catch (err) {
    console.warn("decision model error", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Caps text so a request stays under the 64 KiB text + schema limit (allowing for multi-byte chars). */
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------- 1. search re-ranking

export interface Rankable {
  arxiv_id: string;
  title: string;
  abstract: string;
}

export const RELEVANCE_LEVELS = [
  "Irrelevant: a different topic from the query",
  "Related: same general area, but not what the query asks for",
  "Partly answers: covers part of what the query asks for",
  "Direct match: exactly what the query asks for",
];

/**
 * Re-orders search results by relevance to the query. Each paper is scored on its own (pointwise,
 * as in Jev-as-a-judge IR reranking), so its position in the list can't bias the score. Sorts by
 * expected relevance level; ties and unscored papers keep arXiv's order. Null when nothing scored.
 */
export async function rerank<T extends Rankable>(cfg: DecisionConfig, query: string, papers: T[], opts: { limit?: number; fetch_fn?: typeof fetch } = {}): Promise<T[] | null> {
  const n = Math.min(papers.length, opts.limit ?? 20);
  if (n < 2) return null;
  const top = papers.slice(0, n);
  const scores = await pool(top, 5, async (p) => {
    const a = await decide(
      cfg,
      { query: cap(query, 500), title: cap(p.title, 300), abstract: cap(p.abstract, 2000) },
      { relevance: { type: "score", question: "How relevant is the paper (`title`, `abstract`) to the search `query`?", levels: RELEVANCE_LEVELS } },
      { timeoutMs: 10_000, fetch_fn: opts.fetch_fn },
    );
    const r = a?.relevance;
    return r?.type === "score" ? r.score : null;
  });
  if (scores.every((s) => s === null)) return null;
  const order = top.map((p, i) => ({ p, i, s: scores[i] ?? -1 }));
  order.sort((a, b) => b.s - a.s || a.i - b.i);
  return [...order.map((x) => x.p), ...papers.slice(n)];
}

// ---------------------------------------------------------------- 2. question routing

export const ROUTES = {
  paper: "Needs details from the paper's full text (methods, results, numbers, equations, figures, specific sections).",
  related: "Is about other papers: related work, prior methods, citations, or comparisons with other research.",
  knowledge: "Refers to the user's own earlier sessions or saved notes (\"last time\", \"my notes\", \"what did I learn\").",
  general: "Is general background or a concept explanation the paper doesn't need to be searched for, or small talk.",
  other: "None of the above, or a mix of several.",
} as const;
export type Route = keyof typeof ROUTES;

export interface Routing {
  route: Route;
  p?: number;
}

/**
 * Decides what kind of lookup a question needs. Acts only on a confident, clear-cut routing
 * (confidence ≥ 0.6 and a 0.15 lead over the runner-up); otherwise the tutor decides for itself.
 */
export async function routeQuestion(cfg: DecisionConfig, paperTitle: string, outline: string[], question: string, opts: { fetch_fn?: typeof fetch } = {}): Promise<Routing | null> {
  const answers = await decide(
    cfg,
    { paper_title: cap(paperTitle, 300), sections: outline.slice(0, 40).map((h) => cap(h, 120)), question: cap(question, 4000) },
    { route: { type: "choice", question: "What does answering the user's `question` about this paper need?", options: ROUTES } },
    { timeoutMs: 6000, fetch_fn: opts.fetch_fn },
  );
  const a = answers?.route;
  if (a?.type !== "choice" || a.confidence < 0.6 || choiceMargin(a) < 0.15) return null;
  return { route: a.label as Route, p: a.probabilities[a.label] };
}

/** One line for the system prompt that points the tutor at the right tools. */
export function routingHint(r: Routing): string | null {
  switch (r.route) {
    case "paper":
      return "This question needs the paper's details: look them up with search_paper or read_paper before answering.";
    case "related":
      return "This question is about other work: use search_arxiv / get_arxiv_paper, and relate it back to this paper.";
    case "knowledge":
      return "This question refers to the user's earlier work: start with recall_knowledge.";
    case "general":
      return "This looks like general background: answer directly and concisely, and only search the paper if you need to tie it back.";
    case "other":
      return null;
  }
}

// ---------------------------------------------------------------- 3. note tagging

export const NOTE_TAGS = {
  definition: "Defines a term or concept.",
  method: "Explains how a method, model, algorithm or architecture works.",
  result: "Reports experimental results, numbers, benchmarks or findings.",
  intuition: "Gives intuition, an analogy, or a simple example.",
  math: "Works through equations, derivations or proofs.",
  critique: "Discusses limitations, weaknesses, assumptions or open problems.",
  comparison: "Compares approaches, papers or methods.",
  question: "Records an open question or something to follow up on.",
} as const;

/** Picks note-type tags (each judged independently, kept above `threshold`). */
export async function tagNote(cfg: DecisionConfig, title: string, content: string, opts: { threshold?: number; fetch_fn?: typeof fetch } = {}): Promise<string[] | null> {
  const questions: Record<string, Question> = {};
  for (const [tag, desc] of Object.entries(NOTE_TAGS)) {
    questions[tag] = { type: "noul", question: `Is a substantial part of this note of type "${tag}"?`, yes: desc, no: `It doesn't: ${desc.toLowerCase()}` };
  }
  const answers = await decide(cfg, { title: cap(title, 300), note: cap(content, 8000) }, questions, { timeoutMs: 15_000, fetch_fn: opts.fetch_fn });
  if (!answers) return null;
  const threshold = opts.threshold ?? 0.6;
  return Object.entries(answers)
    .filter(([, a]) => a?.type === "noul" && a.p >= threshold)
    .sort((a, b) => (b[1] as { p: number }).p - (a[1] as { p: number }).p)
    .slice(0, 3)
    .map(([tag]) => tag);
}

/** Adds auto tags to existing ones without duplicates. */
export function mergeTags(existing: string, auto: string[]): string {
  const have = existing.split(",").map((t) => t.trim()).filter(Boolean);
  const lower = new Set(have.map((t) => t.toLowerCase()));
  return [...have, ...auto.filter((t) => !lower.has(t))].join(", ");
}

// ---------------------------------------------------------------- 4. grounding check

export interface Grounding {
  /** Probability every claim about the paper is supported by the passages the tutor read. */
  p: number;
  verdict: "grounded" | "partly" | "unsupported";
  /** How much evidence the check had: the passages the tutor read, or only the opening excerpt. */
  evidence: "passages" | "excerpt";
}

/**
 * Checks whether an answer's claims about the paper are supported by the passages the tutor read.
 * Two independent yes/no questions (support and contradiction) make the verdict less sensitive to
 * how one question is worded. Judges like this are weak on math and derivations, so the verdict is
 * a hint shown to the user, never a reason to hide an answer.
 */
export async function checkGrounding(
  cfg: DecisionConfig,
  question: string,
  answer: string,
  passages: string[],
  excerpt: string,
  opts: { fetch_fn?: typeof fetch } = {},
): Promise<Grounding | null> {
  const evidence = passages.length ? "passages" : "excerpt";
  // Most recent passages first: they're what the final answer most likely drew on.
  const evidenceText: string[] = [];
  let budget = 16_000;
  for (const p of passages.length ? [...passages].reverse() : [excerpt]) {
    if (budget <= 0) break;
    evidenceText.push(cap(p, budget));
    budget -= p.length;
  }
  const answers = await decide(
    cfg,
    { question: cap(question, 2000), answer: cap(answer, 6000), evidence: evidenceText },
    {
      supported: {
        type: "noul",
        question: "Is every specific claim `answer` makes about the paper supported by `evidence`?",
        yes: "All claims about the paper (methods, numbers, results, section contents) appear in or follow directly from the passages. General background clearly labelled as such doesn't count against it.",
        no: "At least one claim about the paper is not in the passages, or goes beyond what they say.",
      },
      contradicts: {
        type: "noul",
        question: "Does `answer` contradict `evidence` anywhere?",
        yes: "Some statement in the answer conflicts with what the evidence says.",
        no: "Nothing in the answer conflicts with the evidence.",
      },
    },
    { timeoutMs: 15_000, fetch_fn: opts.fetch_fn },
  );
  const s = answers?.supported;
  if (s?.type !== "noul") return null;
  const c = answers?.contradicts;
  const p = c?.type === "noul" ? s.p * (1 - c.p) : s.p;
  // Strict cut-offs: wrongly calling an answer grounded is the costly mistake.
  return { p, verdict: p >= 0.8 ? "grounded" : p >= 0.4 ? "partly" : "unsupported", evidence };
}

// ---------------------------------------------------------------- 5. figures

export const FIGURE_KINDS = {
  plot: "A chart or plot of data: line, bar, scatter, histogram, heatmap, curves.",
  diagram: "A diagram: model architecture, pipeline, flowchart, system overview, schematic.",
  table: "A table of numbers or text rendered as an image.",
  example: "Example inputs or outputs: photos, generated images, samples, screenshots, qualitative results.",
  math: "Equations, an algorithm listing or pseudo-code.",
  other: "Anything else.",
} as const;

/** Classifies a figure image and, optionally, answers a yes/no question about it. */
export async function inspectFigure(
  cfg: DecisionConfig,
  caption: string,
  image: DecisionImage,
  question?: string,
  opts: { fetch_fn?: typeof fetch } = {},
): Promise<{ kind?: string; kind_p?: number; answer_p?: number } | null> {
  const questions: Record<string, Question> = { kind: { type: "choice", question: "What kind of figure is the image?", options: FIGURE_KINDS } };
  if (question) questions.ask = { type: "noul", question: `About the image: ${question}` };
  const answers = await decide(cfg, { caption: cap(caption, 2000) }, questions, { images: [image], timeoutMs: 20_000, fetch_fn: opts.fetch_fn });
  if (!answers) return null;
  const k = answers.kind;
  const a = answers.ask;
  return {
    ...(k?.type === "choice" ? { kind: k.label, kind_p: k.probabilities[k.label] ?? k.confidence } : {}),
    ...(a?.type === "noul" ? { answer_p: a.p } : {}),
  };
}
