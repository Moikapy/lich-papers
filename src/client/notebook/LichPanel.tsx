import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Markdown } from "../components/Markdown";
import { runPageTool, serializePage } from "./page-tools";

interface Turn {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; args: Record<string, unknown>; ok?: boolean }[];
  model?: string | null;
}

const LABELS: Record<string, (a: Record<string, unknown>) => string> = {
  read_page: () => "Read the page",
  append_to_page: () => "Wrote on the page",
  add_cell: (a) => `Added a ${a.language} cell`,
  edit_cell: (a) => `Edited cell ${a.id}`,
  run_cell: (a) => `Ran cell ${a.id}`,
  search_arxiv: (a) => `Searched arXiv for “${a.query}”`,
  get_arxiv_paper: (a) => `Looked up arXiv:${a.arxiv_id}`,
  search_paper: (a) => `Searched arXiv:${a.arxiv_id} for “${a.query}”`,
  read_paper: (a) => `Read arXiv:${a.arxiv_id}${a.section ? ` “${a.section}”` : ""}`,
  recall_knowledge: (a) => `Recalled notes on “${a.query}”`,
};
const label = (t: { name: string; args: Record<string, unknown> }) => LABELS[t.name]?.(t.args) ?? t.name;

const STARTERS = ["Summarize this page", "Add a Python cell that plots sin(x) and cos(x)", "Find the paper “Attention Is All You Need” and explain scaled dot-product attention with a small numeric example"];

function savedModel(): { provider?: string; model?: string } {
  try {
    const c = JSON.parse(localStorage.getItem("lp_model") ?? "null");
    return c && typeof c.provider === "string" ? { provider: c.provider, model: c.model || undefined } : {};
  } catch {
    return {};
  }
}

/** Chat with Lich about the open page. Lich's page tools run here, against the editor and its code cells. */
export function LichPanel({ pageId, editor, onClose }: { pageId: string; editor: Editor | null; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ status: string; tools: NonNullable<Turn["tools"]> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => () => socket.current?.close(), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns, pending]);

  const send = (text: string) => {
    const content = text.trim();
    const ed = editorRef.current;
    if (!content || pending || !ed) return;
    setError(null);
    setDraft("");
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: "user", content }]);
    setPending({ status: "Connecting…", tools: [] });

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/pages/${pageId}/agent`);
    socket.current = ws;
    let finished = false;
    const finish = (err?: string) => {
      if (finished) return;
      finished = true;
      setPending(null);
      if (err) setError(err);
      ws.close();
    };
    ws.onopen = () => {
      setPending({ status: "Thinking…", tools: [] });
      ws.send(JSON.stringify({ type: "start", content, history, page: serializePage(ed.state.doc), ...savedModel() }));
    };
    ws.onmessage = async (e) => {
      let m: any;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "status") setPending((p) => p && { ...p, status: m.text });
      else if (m.type === "tool_start") setPending((p) => p && { status: `${label(m)}…`, tools: [...p.tools, { name: m.name, args: m.args }] });
      else if (m.type === "tool_end")
        setPending((p) => {
          if (!p) return p;
          const tools = [...p.tools];
          const i = tools.map((t) => t.name).lastIndexOf(m.name);
          if (i >= 0) tools[i] = { ...tools[i]!, ok: m.ok };
          return { ...p, tools };
        });
      else if (m.type === "provider_error") setPending((p) => p && { ...p, status: `${m.provider} failed, trying fallback…` });
      else if (m.type === "client_tool") {
        const cur = editorRef.current;
        const result = cur
          ? await runPageTool(cur, m.name, m.args ?? {}).catch((err) => ({ ok: false, output: "", error: String((err as Error)?.message ?? err) }))
          : { ok: false, output: "", error: "The page is closed." };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tool_result", id: m.id, ...result }));
      } else if (m.type === "done") {
        setTurns((t) => [...t, { role: "assistant", content: m.content, tools: m.meta?.tools, model: m.meta?.model }]);
        finish();
      } else if (m.type === "error") {
        setTurns((t) => t.slice(0, -1));
        setDraft((d) => d || content);
        finish(m.message);
      }
    };
    ws.onerror = () => finish("Couldn't reach Lich. Check your connection and try again.");
    ws.onclose = () => {
      if (!finished) {
        setTurns((t) => (t[t.length - 1]?.role === "user" ? t.slice(0, -1) : t));
        setDraft((d) => d || content);
        finish("The connection closed before Lich finished.");
      }
    };
  };

  const stop = () => {
    socket.current?.close();
  };

  return (
    <aside className="lich-panel" aria-label="Lich">
      <div className="row spread lich-head">
        <strong>
          <span className="glyph">⚱</span> Lich
        </strong>
        <span className="row">
          {turns.length > 0 && !pending && (
            <button className="linklike small" onClick={() => setTurns([])}>
              Clear
            </button>
          )}
          <button className="linklike" onClick={onClose} aria-label="Close Lich">
            ×
          </button>
        </span>
      </div>
      <div className="lich-messages" ref={scroller}>
        {turns.length === 0 && !pending && (
          <div className="starters">
            <p className="muted small">Lich can read this page, write on it, and write, run and fix code cells. Try:</p>
            {STARTERS.map((s) => (
              <button key={s} className="starter" onClick={() => send(s)} disabled={!editor}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            {t.tools?.length ? <Trail tools={t.tools} /> : null}
            {t.role === "assistant" ? <Markdown text={t.content} /> : <div className="user-text">{t.content}</div>}
            {t.model && <div className="model-tag">{t.model}</div>}
          </div>
        ))}
        {pending && (
          <div className="msg assistant pending">
            {pending.tools.length > 0 && <Trail tools={pending.tools} />}
            <div className="status">
              <span className="dot" /> {pending.status}
            </div>
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
      <form
        className="lich-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask Lich to explain, compute, plot, or write…"
          rows={2}
          aria-label="Message Lich"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {pending ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!draft.trim() || !editor}>
            Send
          </button>
        )}
      </form>
    </aside>
  );
}

function Trail({ tools }: { tools: NonNullable<Turn["tools"]> }) {
  return (
    <ul className="tool-trail">
      {tools.map((t, i) => (
        <li key={i} className={t.ok === false ? "failed" : ""}>
          {label(t)}
        </li>
      ))}
    </ul>
  );
}
