/**
 * Runs code cells in the sandbox (/sandbox.html), an iframe with an opaque origin: cell code can't reach the
 * app's cookies, API or DOM. One kernel per open page, so cells on a page share variables per language.
 */

import type { CellOutput } from "./outputs";

export type { CellOutput } from "./outputs";
export { appendOutput, OUTPUT_LIMITS } from "./outputs";

export type CellLanguage = "python" | "javascript" | "typescript";

type Message = { id?: string; type: string; [k: string]: unknown };

/** Runtime a language runs on: TypeScript is transpiled and shares the JavaScript runtime. */
const runtimeOf = (lang: CellLanguage) => (lang === "python" ? "python" : "javascript");

async function toJavaScript(lang: CellLanguage, code: string): Promise<string> {
  if (lang !== "typescript") return code;
  const { transform } = await import("sucrase");
  return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
}

export class Kernel {
  /** Run counter shared by the page's cells, like Jupyter's execution count. */
  private executions = 0;
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private runs = new Map<string, { onOutput: (o: CellOutput) => void; onStatus: (s: string) => void; done: () => void }>();
  private readonly onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data as Message;
    if (m.type === "ready") return this.resolveReady?.();
    const run = m.id ? this.runs.get(m.id) : undefined;
    if (!run) return;
    switch (m.type) {
      case "stream":
        return run.onOutput({ type: "stream", name: m.name === "stderr" ? "stderr" : "stdout", text: String(m.text ?? "") });
      case "result":
        return run.onOutput({ type: "result", text: String(m.text ?? "") });
      case "image":
        return run.onOutput({ type: "image", mime: String(m.mime ?? "image/png"), data: String(m.data ?? "") });
      case "error":
        return run.onOutput({ type: "error", ename: String(m.ename ?? "Error"), evalue: String(m.evalue ?? ""), traceback: String(m.traceback ?? "") });
      case "status":
        return run.onStatus(String(m.text ?? ""));
      case "done":
        this.runs.delete(m.id!);
        return run.done();
    }
  };
  private resolveReady: (() => void) | null = null;

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
    const frame = document.createElement("iframe");
    // allow-scripts without allow-same-origin: an opaque origin.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "Code runtime";
    frame.src = "/sandbox.html";
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    window.addEventListener("message", this.onMessage);
    document.body.appendChild(frame);
    this.frame = frame;
    return this.ready;
  }

  /** Runs one cell. Resolves with its execution count when it finishes, fails, or is stopped. */
  async run(lang: CellLanguage, code: string, onOutput: (o: CellOutput) => void, onStatus: (s: string) => void = () => {}): Promise<number> {
    const count = ++this.executions;
    let js: string;
    try {
      js = await toJavaScript(lang, code);
    } catch (err) {
      onOutput({ type: "error", ename: "SyntaxError", evalue: (err as Error).message, traceback: "" });
      return count;
    }
    await this.start();
    const id = crypto.randomUUID();
    return new Promise<number>((resolve) => {
      this.runs.set(id, { onOutput, onStatus, done: () => resolve(count) });
      this.frame!.contentWindow!.postMessage({ type: "run", id, lang: runtimeOf(lang), code: js }, "*");
    });
  }

  /** Stops what's running in a language and clears its variables. */
  restart(lang?: CellLanguage): void {
    if (!this.frame) return;
    this.frame.contentWindow?.postMessage({ type: "restart", lang: lang ? runtimeOf(lang) : undefined }, "*");
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    for (const r of this.runs.values()) r.done();
    this.runs.clear();
  }
}
