import type { Plugin, Tool, ToolResult } from "@moikapy/lich";
import { fetchFigureImage, type Figure, type Paper } from "./arxiv";
import { inspectFigure, type DecisionConfig } from "./decide";
import type { Ctx, Env } from "./env";
import { autoTagNote } from "./knowledge";
import type { SavedNote } from "./agent";

const ok = (output: string): ToolResult => ({ ok: true, output });
const fail = (error: string): ToolResult => ({ ok: false, output: "", error });

export interface DecisionPluginOptions {
  env: Env;
  paper: Paper;
  decision: DecisionConfig;
  figures: () => Promise<Figure[]>;
  ctx?: Ctx;
}

/**
 * The lich plugin for a decision model (Clef / Clef Flash on Ollama). It gives the tutor eyes on
 * figures (`inspect_figure`) and tags notes after `save_knowledge` succeeds. Pass its
 * `onNoteSaved` to paperTools so the hook knows which note was just stored.
 */
export function decisionPlugin(opts: DecisionPluginOptions): Plugin & { onNoteSaved: (note: SavedNote) => void } {
  const { env, paper, decision, figures, ctx } = opts;
  const unsaved: SavedNote[] = [];
  const tools: Tool[] = [];

  if (paper.body_source === "html") {
    tools.push({
      name: "inspect_figure",
      description:
        "Look at a figure's image with a vision decision model. Returns what kind of figure it is (plot, diagram, table, example, math, other) and, if you pass `question`, the probability that the answer is yes. Use it to check things the caption doesn't say, e.g. 'Does the plot show the proposed method's curve above all baselines?'. It only answers yes/no questions.",
      parameters: {
        type: "object",
        properties: {
          figure: { type: "number", description: "Figure number from paper_figures, i.e. the [n] in its list" },
          question: { type: "string", description: "Optional yes/no question about the image" },
        },
        required: ["figure"],
      },
      async execute(args) {
        const n = Number(args.figure);
        const fig = (await figures()).find((f) => f.n === n);
        if (!fig) return fail(`No figure ${String(args.figure)}. Call paper_figures for the list.`);
        const image = await fetchFigureImage(env, fig).catch(() => null);
        if (!image) return fail("Couldn't load that figure's image (it may be a vector graphic). Rely on its caption.");
        const question = typeof args.question === "string" && args.question.trim() ? args.question.trim().slice(0, 500) : undefined;
        const r = await inspectFigure(decision, fig.caption, image, question);
        if (!r) return fail("The decision model couldn't inspect the figure right now. Rely on its caption.");
        const lines = [`${fig.label}: ${fig.caption || "(no caption)"}`];
        if (r.kind) lines.push(`Kind: ${r.kind}${r.kind_p !== undefined ? ` (${Math.round(r.kind_p * 100)}% likely)` : ""}`);
        if (question && r.answer_p !== undefined) {
          const pct = Math.round(r.answer_p * 100);
          lines.push(`"${question}": ${pct >= 70 ? "likely yes" : pct <= 30 ? "likely no" : "unclear"} (P(yes) = ${pct}%)`);
        }
        return ok(lines.join("\n"));
      },
    });
  }

  return {
    name: "lich-papers-decisions",
    tools,
    onNoteSaved: (note) => void unsaved.push(note),
    hooks: {
      async after_tool_call(info) {
        if (info.tool_name !== "save_knowledge" || !info.ok) return;
        const note = unsaved.shift();
        if (!note) return;
        const tag = autoTagNote(env, decision, note.id, note.title, note.content, note.tags);
        ctx ? ctx.waitUntil(tag) : await tag;
      },
    },
  };
}
