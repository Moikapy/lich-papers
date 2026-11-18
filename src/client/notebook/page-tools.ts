import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { noteToHtml } from "../../shared/note-html";
import { cellRunners, newCellId } from "./CodeCell";
import type { CellOutput } from "./outputs";
import { errorText } from "./outputs";

/**
 * The browser's side of Lich's page tools: the agent (on the server) asks for one of these by name and gets
 * the result back. They only read or change the open page and run its code cells in the sandbox.
 */

export interface ToolOutcome {
  ok: boolean;
  output: string;
  error?: string;
}

const OUTPUT_CHARS = 6000;

/** A cell's outputs as text for the model (images are only counted). */
export function outputsToText(outputs: CellOutput[]): string {
  const parts: string[] = [];
  let images = 0;
  for (const o of outputs) {
    if (o.type === "image") images++;
    else if (o.type === "error") parts.push(errorText(o));
    else parts.push(o.type === "stream" && o.name === "stderr" ? `[stderr] ${o.text}` : o.text);
  }
  if (images) parts.push(`[${images} plot${images === 1 ? "" : "s"} shown on the page]`);
  const text = parts.join("\n").trim() || "(no output)";
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n[output truncated]` : text;
}

/** The page as text for the model: headings, text, math, papers, and cells with ids and outputs. */
export function serializePage(doc: PMNode, maxChars = 40_000): string {
  const out: string[] = [];
  doc.forEach((node) => {
    const t = node.type.name;
    if (t === "codeCell") {
      const a = node.attrs as { id: string | null; language: string; source: string; outputs: CellOutput[]; executionCount: number | null };
      const ran = a.executionCount ? `\nOutput:\n${outputsToText(a.outputs ?? [])}` : "\n(not run yet)";
      out.push(`[cell id=${a.id ?? "?"} language=${a.language}]\n\`\`\`\n${a.source}\n\`\`\`${ran}`);
    } else if (t === "paperEmbed") {
      out.push(`[paper arXiv:${node.attrs.arxivId}${node.attrs.title ? ` — ${node.attrs.title}` : ""}]`);
    } else if (t === "heading") {
      out.push(`${"#".repeat(node.attrs.level ?? 1)} ${node.textContent}`);
    } else if (t === "blockMath") {
      out.push(`$$${node.attrs.latex}$$`);
    } else if (t === "codeBlock") {
      out.push(`\`\`\`\n${node.textContent}\n\`\`\``);
    } else if (t === "horizontalRule") {
      out.push("---");
    } else {
      const text = node.textBetween(0, node.content.size, "\n", (leaf) => (leaf.type.name === "inlineMath" ? `$${leaf.attrs.latex}$` : "")).trim();
      if (text) out.push(text);
    }
  });
  const text = out.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[page truncated]` : text;
}

function findCell(editor: Editor, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === "codeCell" && node.attrs.id === id) found = { pos, node };
    return !found;
  });
  return found;
}

/** Waits for a cell's view to mount and register its runner, then runs it. */
async function runCell(editor: Editor, id: string): Promise<ToolOutcome> {
  const runners = cellRunners(editor);
  for (let i = 0; i < 40 && !runners.has(id); i++) await new Promise((r) => setTimeout(r, 50));
  const run = runners.get(id);
  if (!run) return { ok: false, output: "", error: `No cell with id ${id}. Call read_page for the current cells.` };
  const outputs = await run();
  const failed = outputs.some((o) => o.type === "error");
  const text = outputsToText(outputs);
  // A failed cell is still a successful tool call: the model needs the error to fix the code.
  return { ok: true, output: `cell ${id} ${failed ? "FAILED" : "ran"}:\n${text}` };
}

export async function runPageTool(editor: Editor, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const end = () => editor.state.doc.content.size;
  switch (name) {
    case "read_page":
      return { ok: true, output: serializePage(editor.state.doc) || "(the page is empty)" };
    case "append_to_page": {
      const done = editor.commands.insertContentAt(end(), noteToHtml(String(args.markdown ?? "")));
      return done ? { ok: true, output: "Added to the end of the page." } : { ok: false, output: "", error: "Couldn't add that to the page." };
    }
    case "add_cell": {
      const id = newCellId();
      const done = editor.commands.insertContentAt(end(), { type: "codeCell", attrs: { id, language: String(args.language), source: String(args.code ?? "") } });
      if (!done) return { ok: false, output: "", error: "Couldn't add the cell." };
      if (args.run === false) return { ok: true, output: `Added cell ${id} (not run).` };
      const r = await runCell(editor, id);
      return r.ok ? { ok: true, output: `Added ${r.output}` } : r;
    }
    case "edit_cell": {
      const id = String(args.id);
      const cell = findCell(editor, id);
      if (!cell) return { ok: false, output: "", error: `No cell with id ${id}. Call read_page for the current cells.` };
      editor.view.dispatch(editor.state.tr.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, source: String(args.code ?? "") }));
      if (args.run === false) return { ok: true, output: `Updated cell ${id} (not run).` };
      return runCell(editor, id);
    }
    case "run_cell":
      return runCell(editor, String(args.id));
    default:
      return { ok: false, output: "", error: `Unknown tool ${name}` };
  }
}
