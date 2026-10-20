/** Cell outputs: pure helpers, shared by the kernel and the cell view (no DOM, so they unit-test anywhere). */

export type CellOutput =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | { type: "result"; text: string }
  | { type: "image"; mime: string; data: string }
  | { type: "error"; ename: string; evalue: string; traceback: string };

/** Keeps saved outputs small enough to fit in the page. */
export const OUTPUT_LIMITS = { textChars: 50_000, images: 4, imageChars: 600_000 } as const;

export function appendOutput(outputs: CellOutput[], o: CellOutput): CellOutput[] {
  const textSoFar = outputs.reduce((n, x) => n + (x.type === "image" ? 0 : x.type === "error" ? x.evalue.length + x.traceback.length : x.text.length), 0);
  if (o.type === "image") {
    if (outputs.filter((x) => x.type === "image").length >= OUTPUT_LIMITS.images || o.data.length > OUTPUT_LIMITS.imageChars) {
      return appendOutput(outputs, { type: "stream", name: "stderr", text: "[image not kept: too large or too many images]\n" });
    }
    return [...outputs, o];
  }
  if (textSoFar >= OUTPUT_LIMITS.textChars) return outputs;
  const room = OUTPUT_LIMITS.textChars - textSoFar;
  if (o.type === "stream") {
    const text = o.text.length > room ? `${o.text.slice(0, room)}\n[output truncated]\n` : o.text;
    const last = outputs[outputs.length - 1];
    // Merge consecutive writes to the same stream, as Jupyter does.
    if (last?.type === "stream" && last.name === o.name) return [...outputs.slice(0, -1), { ...last, text: last.text + text }];
    return [...outputs, { ...o, text }];
  }
  if (o.type === "result") return [...outputs, { ...o, text: o.text.length > room ? `${o.text.slice(0, room)}…` : o.text }];
  return [...outputs, { ...o, traceback: o.traceback.slice(0, Math.max(0, room - o.evalue.length)) }];
}

/** "Name: message", then the traceback without the line that repeats it. */
export function errorText(o: Extract<CellOutput, { type: "error" }>): string {
  const head = `${o.ename}: ${o.evalue}`.trim();
  const rest = o.traceback
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== head && l.trim() !== o.evalue.trim())
    .join("\n");
  return rest ? `${head}\n${rest}` : head;
}
