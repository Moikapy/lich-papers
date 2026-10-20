import { useEffect, useRef, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { appendOutput, type CellLanguage, type CellOutput, type Kernel } from "./kernel";
import { errorText } from "./outputs";

export const LANGUAGES: { id: CellLanguage; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
];

export interface CodeCellOptions {
  /** The open page's kernel; cells on a page share it. */
  getKernel: () => Kernel | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    codeCell: { insertCodeCell: (attrs?: { language?: CellLanguage; source?: string }) => ReturnType };
  }
}

const parseJson = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** A runnable code cell: source, language and its last outputs, all stored in the page. */
export const CodeCell = Node.create<CodeCellOptions>({
  name: "codeCell",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ getKernel: () => null }),
  addAttributes() {
    return {
      language: { default: "python", parseHTML: (el) => el.getAttribute("data-language") ?? "python" },
      source: { default: "", parseHTML: (el) => el.getAttribute("data-source") ?? "" },
      outputs: { default: [], parseHTML: (el) => parseJson(el.getAttribute("data-outputs"), []) },
      executionCount: { default: null, parseHTML: (el) => Number(el.getAttribute("data-execution-count")) || null },
    };
  },
  parseHTML: () => [{ tag: 'div[data-type="code-cell"]' }],
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "code-cell",
        "data-language": node.attrs.language,
        "data-source": node.attrs.source,
        "data-outputs": JSON.stringify(node.attrs.outputs ?? []),
      }),
    ];
  },
  // Page text (search, the AI) includes the code.
  renderText: ({ node }) => `\n${node.attrs.source}\n`,
  addCommands() {
    return {
      insertCodeCell:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { language: attrs.language ?? "python", source: attrs.source ?? "" } }),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeCellView);
  },
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("codeCellGuard"),
        props: {
          // A selected cell (e.g. after clicking its toolbar) would be replaced by whatever is typed. Type below it instead.
          handleTextInput(view, _from, _to, text) {
            const sel = view.state.selection;
            if (!(sel instanceof NodeSelection) || sel.node.type !== type) return false;
            const after = sel.to;
            const tr = view.state.tr;
            const next = tr.doc.resolve(after).nodeAfter;
            if (!next || !next.isTextblock) tr.insert(after, view.state.schema.nodes.paragraph!.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1)).insertText(text);
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

function CodeCellView({ node, updateAttributes, deleteNode, extension, selected, editor, getPos }: NodeViewProps) {
  const { language, source, outputs, executionCount } = node.attrs as { language: CellLanguage; source: string; outputs: CellOutput[]; executionCount: number | null };
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const kernel = (extension.options as CodeCellOptions).getKernel();

  // Grow with the code.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [source]);

  // Focus a freshly inserted, empty cell.
  useEffect(() => {
    if (!source) textarea.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Leaves the cell for the page, above or below it (adding an empty line when there's none). */
  const exit = (dir: "up" | "down") => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return;
    const { state, view } = editor;
    const at = dir === "down" ? pos + node.nodeSize : pos;
    const neighbour = dir === "down" ? state.doc.resolve(at).nodeAfter : state.doc.resolve(at).nodeBefore;
    const tr = state.tr;
    let target: number;
    if (neighbour?.isTextblock) {
      target = dir === "down" ? at + 1 : at - 1;
    } else {
      tr.insert(at, state.schema.nodes.paragraph!.create());
      target = at + 1;
    }
    tr.setSelection(TextSelection.create(tr.doc, target));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const run = async () => {
    if (!kernel || running) return;
    setRunning(true);
    setStatus("");
    let out: CellOutput[] = [];
    let pending: ReturnType<typeof setTimeout> | null = null;
    // Streamed output is written to the page at most every 150 ms.
    const flush = () => {
      pending = null;
      updateAttributes({ outputs: out });
    };
    updateAttributes({ outputs: [] });
    const count = await kernel.run(
      language,
      source,
      (o) => {
        out = appendOutput(out, o);
        pending ??= setTimeout(flush, 150);
      },
      setStatus,
    );
    if (pending) clearTimeout(pending);
    updateAttributes({ outputs: out, executionCount: count });
    setStatus("");
    setRunning(false);
  };

  return (
    <NodeViewWrapper className={`code-cell${selected ? " selected" : ""}`} data-language={language}>
      <div className="cell-bar" contentEditable={false}>
        <button type="button" className="cell-run" onClick={running ? () => kernel?.restart(language) : run} title={running ? "Stop (clears variables)" : "Run (Shift+Enter)"} aria-label={running ? "Stop" : "Run cell"}>
          {running ? "■" : "▶"}
        </button>
        <span className="cell-count muted small">[{running ? "*" : (executionCount ?? " ")}]</span>
        <select value={language} onChange={(e) => updateAttributes({ language: e.target.value })} aria-label="Language">
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        {status && <span className="cell-status muted small">{status}</span>}
        <span className="cell-actions">
          {outputs.length > 0 && (
            <button type="button" className="linklike small" onClick={() => updateAttributes({ outputs: [], executionCount: null })}>
              Clear output
            </button>
          )}
          <button type="button" className="linklike small" onClick={() => kernel?.restart(language)} title="Restart the runtime: clears all variables for this language">
            Restart
          </button>
          <button type="button" className="linklike small" onClick={() => deleteNode()} aria-label="Delete cell">
            ×
          </button>
        </span>
      </div>
      <textarea
        ref={textarea}
        className="cell-source"
        value={source}
        spellCheck={false}
        rows={1}
        aria-label={`${LANGUAGES.find((l) => l.id === language)?.label ?? "Code"} cell`}
        placeholder={language === "python" ? "print('hello')" : "console.log('hello')"}
        onChange={(e) => updateAttributes({ source: e.target.value })}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void run();
          } else if (e.key === "ArrowDown" && el.selectionStart === source.length && el.selectionEnd === source.length) {
            e.preventDefault();
            exit("down");
          } else if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
            e.preventDefault();
            exit("up");
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${source.slice(0, a)}    ${source.slice(b)}`;
            updateAttributes({ source: next });
            requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
          }
        }}
      />
      {outputs.length > 0 && (
        <div className="cell-outputs" contentEditable={false}>
          {outputs.map((o, i) =>
            o.type === "image" ? (
              // Only PNG data is ever rendered, whatever the cell claimed.
              <img key={i} src={`data:image/png;base64,${o.data}`} alt="Cell output" />
            ) : o.type === "error" ? (
              <pre key={i} className="cell-error">
                {errorText(o)}
              </pre>
            ) : (
              <pre key={i} className={o.type === "stream" && o.name === "stderr" ? "cell-stderr" : o.type === "result" ? "cell-result" : undefined}>
                {o.text}
              </pre>
            ),
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}
