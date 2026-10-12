import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, chatProviders, enc, postStream, PROVIDER_LABELS, timeAgo, type ChatProvider, type ChatMessage, type ModelInfo, type PaperMeta, type ProviderId, type Session, type ToolUse } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { Markdown } from "../components/Markdown";
import { navigate } from "../router";

type ReaderTab = "pdf" | "text";

export function PaperPage({ arxivId, sessionId }: { arxivId: string; sessionId: string | null }) {
  const [paper, setPaper] = useState<PaperMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mobilePane, setMobilePane] = useState<"read" | "chat">("read");

  useEffect(() => {
    api<{ paper: PaperMeta }>(`/papers/${enc(arxivId)}`)
      .then((r) => setPaper(r.paper))
      .catch((e) => setError((e as Error).message));
  }, [arxivId]);

  const quote = useCallback((text: string) => {
    const q = text.trim().split("\n").map((l) => `> ${l}`).join("\n");
    setDraft((d) => `${q}\n\n${d}`);
    setMobilePane("chat");
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!paper) return <p className="muted">Loading paper…</p>;

  return (
    <div className="paper">
      <div className="paper-head">
        <h1>{paper.title}</h1>
        <div className="byline">{paper.authors.join(", ")}</div>
        <div className="meta">
          <span>arXiv:{paper.arxiv_id}</span>
          {paper.published && <span>{paper.published.slice(0, 10)}</span>}
          {paper.categories.map((c) => (
            <span key={c} className="tag">
              {c}
            </span>
          ))}
          <a href={`https://arxiv.org/abs/${paper.arxiv_id}`} target="_blank" rel="noreferrer">
            arXiv page ↗
          </a>
        </div>
        <div className="mobile-switch">
          <button className={mobilePane === "read" ? "on" : ""} onClick={() => setMobilePane("read")}>
            Read
          </button>
          <button className={mobilePane === "chat" ? "on" : ""} onClick={() => setMobilePane("chat")}>
            Chat
          </button>
        </div>
      </div>
      <div className={`panes show-${mobilePane}`}>
        <Reader key={paper.arxiv_id} paper={paper} onQuote={quote} />
        <ChatPanel key={paper.arxiv_id} paper={paper} sessionId={sessionId} draft={draft} setDraft={setDraft} />
      </div>
    </div>
  );
}

/** Phones and small tablets: mobile browsers can't show a PDF inside a page frame. */
const isSmallScreen = () => typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;

function Reader({ paper, onQuote }: { paper: PaperMeta; onQuote: (t: string) => void }) {
  const [small] = useState(isSmallScreen);
  const [tab, setTab] = useState<ReaderTab>(small ? "text" : "pdf");
  const textRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<{ body: string; source: string } | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Touch devices adjust the selection with handles after touchend, so follow selectionchange.
  useEffect(() => {
    const on = () => {
      const sel = window.getSelection();
      if (sel && textRef.current && sel.anchorNode && textRef.current.contains(sel.anchorNode)) setSelection(sel.toString().trim());
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);

  // Reader is keyed by arxiv id, so text/textError start fresh for each paper. `attempt` drives Retry.
  useEffect(() => {
    if (tab !== "text" || text || textError) return;
    let cancelled = false;
    setLoadingText(true);
    setTextError(null);
    api<{ body: string; source: string }>(`/papers/${enc(paper.arxiv_id)}/text`)
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && setTextError((e as Error).message))
      .finally(() => !cancelled && setLoadingText(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, paper.arxiv_id, attempt]);

  const captureSelection = () => setSelection(window.getSelection()?.toString().trim() ?? "");

  return (
    <section className="reader">
      <div className="toolbar">
        <div className="tabs">
          <button className={tab === "pdf" ? "on" : ""} onClick={() => setTab("pdf")}>
            PDF
          </button>
          <button className={tab === "text" ? "on" : ""} onClick={() => setTab("text")}>
            Text
          </button>
        </div>
        {tab === "text" && selection && (
          <button className="small" onClick={() => (onQuote(selection), setSelection(""))}>
            Ask about selection
          </button>
        )}
        {tab === "pdf" && (
          <a className="small" href={`/api/papers/${enc(paper.arxiv_id)}/pdf`} target="_blank" rel="noreferrer">
            Open PDF ↗
          </a>
        )}
      </div>
      {tab === "pdf" ? (
        small ? (
          <div className="pdf-mobile">
            <p>Your browser opens PDFs in its own viewer.</p>
            <a className="button primary" href={`/api/papers/${enc(paper.arxiv_id)}/pdf`} target="_blank" rel="noreferrer">
              Open the PDF
            </a>
            <p className="muted small">Or use the Text tab to read here and select passages to ask about.</p>
          </div>
        ) : (
          <iframe className="pdf" title={paper.title} src={`/api/papers/${enc(paper.arxiv_id)}/pdf#view=FitH`} />
        )
      ) : (
        <div className="paper-text" ref={textRef} onMouseUp={captureSelection}>
          {loadingText && <p className="muted">Extracting full text (first time can take a few seconds)…</p>}
          {textError && (
            <p className="error">
              {textError}{" "}
              <button
                className="small"
                onClick={() => {
                  setTextError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            </p>
          )}
          {text && (
            <>
              <p className="muted small">
                Extracted from {text.source === "html" ? "arXiv's HTML rendering" : text.source === "pdf" ? "the PDF" : "the abstract only"}. Select text
                and click “Ask about selection”.
              </p>
              {text.source === "html" ? <Markdown text={text.body} /> : <pre className="plain">{text.body}</pre>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const STARTERS = [
  "Give me a 5-minute overview of this paper.",
  "What problem does this solve, and why does it matter?",
  "Walk me through the method step by step.",
  "What background do I need to understand this?",
  "What are the main results and limitations?",
];

const TOOL_LABELS: Record<string, (a: Record<string, unknown>) => string> = {
  paper_outline: () => "Read the outline",
  search_paper: (a) => `Searched the paper for “${a.query}”`,
  read_paper: (a) => (a.section ? `Read section “${a.section}”` : `Read text at ${a.offset ?? 0}`),
  recall_knowledge: (a) => `Recalled notes on “${a.query}”`,
  save_knowledge: () => "Saved a note to your knowledge",
  search_arxiv: (a) => `Searched arXiv for “${a.query}”`,
  get_arxiv_paper: (a) => `Looked up arXiv:${a.arxiv_id}`,
};
const toolLabel = (t: { name: string; args: Record<string, unknown> }) => (TOOL_LABELS[t.name]?.(t.args) ?? t.name);

interface ModelChoice {
  provider: ChatProvider;
  model: string;
}

function useModelChoice(): [ModelChoice | null, (c: ModelChoice) => void, Partial<Record<ProviderId, { connected: boolean }>>] {
  const { user } = useAuth();
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [providers, setProviders] = useState<Partial<Record<ProviderId, { connected: boolean }>>>({});
  useEffect(() => {
    if (!user) return;
    api<{ providers: Record<ProviderId, { connected: boolean }> }>("/settings")
      .then((s) => {
        setProviders(s.providers);
        // A saved choice for a provider that is no longer connected falls back to OpenRouter.
        setChoice((c) => (c && !chatProviders(user, s.providers).includes(c.provider) ? { provider: "openrouter", model: "" } : c));
      })
      .catch(() => {});
    let saved: ModelChoice | null = null;
    try {
      saved = JSON.parse(localStorage.getItem("lp_model") ?? "null");
    } catch {}
    setChoice(saved ?? { provider: user.default_provider, model: user.default_model ?? "" });
  }, [user]);
  const set = (c: ModelChoice) => {
    setChoice(c);
    try {
      localStorage.setItem("lp_model", JSON.stringify(c));
    } catch {}
  };
  return [choice, set, providers];
}

function ModelPicker({ choice, onChange, providers }: { choice: ModelChoice; onChange: (c: ModelChoice) => void; providers: Partial<Record<ProviderId, { connected: boolean }>> }) {
  const { user } = useAuth();
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    setModels([]);
    api<{ models: ModelInfo[] }>(`/models/${choice.provider}`)
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, [choice.provider]);
  const allowed = chatProviders(user, providers);
  const available = allowed.includes(choice.provider) ? allowed : [...allowed, choice.provider];
  const listId = `models-${choice.provider}`;
  return (
    <div className="model-picker">
      <select value={choice.provider} onChange={(e) => onChange({ provider: e.target.value as ChatProvider, model: "" })} aria-label="Provider">
        {available.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABELS[p]}
            {allowed.includes(p) ? "" : " (not connected)"}
          </option>
        ))}
      </select>
      <input
        list={listId}
        value={choice.model}
        placeholder={choice.provider === "openrouter" ? "openrouter/free" : choice.provider === "pro" ? "default Pro model" : "model id"}
        onChange={(e) => onChange({ ...choice, model: e.target.value })}
        aria-label="Model"
      />
      <datalist id={listId}>
        {models.slice(0, 400).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.free ? " (free)" : ""}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function ChatPanel({ paper, sessionId, draft, setDraft }: { paper: PaperMeta; sessionId: string | null; draft: string; setDraft: (s: string | ((d: string) => string)) => void }) {
  const { user, loading } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<{ status: string; tools: { name: string; args: Record<string, unknown>; ok?: boolean }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [choice, setChoice, providers] = useModelChoice();
  const [loadingSession, setLoadingSession] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const activeId = useRef<string | null>(sessionId);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(() => {
    if (!user) return Promise.resolve([] as Session[]);
    return api<{ sessions: Session[] }>(`/sessions?arxiv_id=${enc(paper.arxiv_id)}`).then((r) => {
      setSessions(r.sessions);
      return r.sessions;
    });
  }, [user, paper.arxiv_id]);

  useEffect(() => {
    refreshSessions().catch(() => {});
  }, [refreshSessions]);

  useEffect(() => {
    activeId.current = sessionId;
    abort.current?.abort();
    setSession(null);
    setMessages([]);
    setError(null);
    if (!user || !sessionId) {
      setLoadingSession(false);
      return;
    }
    let cancelled = false;
    setLoadingSession(true);
    api<{ session: Session; messages: ChatMessage[] }>(`/sessions/${sessionId}`)
      .then((r) => {
        if (cancelled) return;
        setSession(r.session);
        setMessages(r.messages);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoadingSession(false));
    return () => {
      cancelled = true;
    };
  }, [user, sessionId]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages, pending]);

  const openSession = (id: string | null) => {
    abort.current?.abort();
    activeId.current = id;
    if (!id) {
      setSession(null);
      setMessages([]);
    }
    navigate(`/paper/${enc(paper.arxiv_id)}${id ? `?session=${id}` : ""}`, true);
  };

  const send = async (text: string, fromDraft = false) => {
    const content = text.trim();
    if (!content || pending || sending.current || loadingSession) return;
    sending.current = true;
    setError(null);
    setPending({ status: "Sending…", tools: [] });
    try {
      let s = session;
      if (!s) {
        const startId = activeId.current;
        try {
          s = (await api<{ session: Session }>("/sessions", { method: "POST", json: { arxiv_id: paper.arxiv_id } })).session;
        } catch (e) {
          setError((e as Error).message);
          setPending(null);
          return;
        }
        if (activeId.current !== startId) {
          setPending(null);
          return;
        }
        activeId.current = s.id;
        setSession(s);
        history.replaceState(null, "", `/paper/${enc(paper.arxiv_id)}?session=${s.id}`);
      }
      const sid = s.id;
      const live = () => activeId.current === sid;
      const userMsg: ChatMessage = { id: `local-${Date.now()}`, role: "user", content, meta: null, created_at: Date.now() };
      setMessages((m) => [...m, userMsg]);
      if (fromDraft) setDraft("");
      const ac = new AbortController();
      abort.current = ac;
      let finished = false;
      try {
        await postStream(
          `/sessions/${sid}/messages`,
          { content, provider: choice?.provider, model: choice?.model || undefined },
          (event, data) => {
            if (!live()) return;
            if (event === "status") setPending((p) => p && { ...p, status: data.text });
            else if (event === "tool_start") setPending((p) => p && { ...p, status: `${toolLabel(data)}…`, tools: [...p.tools, { name: data.name, args: data.args }] });
            else if (event === "tool_end")
              setPending((p) => {
                if (!p) return p;
                const tools = [...p.tools];
                const i = tools.map((t) => t.name).lastIndexOf(data.name);
                if (i >= 0) tools[i] = { ...tools[i]!, ok: data.ok };
                return { ...p, tools };
              });
            else if (event === "provider_error") setPending((p) => p && { ...p, status: `${data.provider} failed, trying fallback…` });
            else if (event === "done") {
              finished = true;
              setMessages((m) => [...m, { id: `local-${Date.now()}-a`, role: "assistant", content: data.content, meta: data.meta, created_at: Date.now() }]);
            } else if (event === "error") {
              finished = true;
              throw new Error(data.message);
            }
          },
          ac.signal,
        );
        if (!finished && !ac.signal.aborted) throw new Error("The connection closed before an answer arrived.");
      } catch (e) {
        // Server persists nothing on failure or abort; drop the optimistic message and restore the draft.
        setMessages((m) => m.filter((x) => x !== userMsg));
        if (live()) {
          if (!ac.signal.aborted) setError((e as Error).message);
          if (fromDraft) setDraft((d) => d || content);
        }
      }
    } finally {
      sending.current = false;
      setPending(null);
      abort.current = null;
      refreshSessions().catch(() => {});
    }
  };

  const summarize = async () => {
    if (!session) return;
    setNotice("Summarizing this session into your knowledge base…");
    try {
      await api(`/sessions/${session.id}/summarize`, { method: "POST" });
      setNotice("Saved a summary to your knowledge base. New sessions will be able to build on it.");
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    }
  };

  if (loading) return <section className="chat" />;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <section className="chat empty-chat">
        <h2>Chat with this paper</h2>
        <p className="muted">Ask questions, get explanations at your level, and keep your notes across sessions. Free to start.</p>
        <div className="row">
          <Link className="button primary" href={`/signup?next=${next}`}>
            Create account
          </Link>
          <Link className="button" href={`/login?next=${next}`}>
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="chat">
      <div className="toolbar">
        <select value={session?.id ?? ""} onChange={(e) => openSession(e.target.value || null)} aria-label="Session" disabled={!!pending || loadingSession}>
          <option value="">{session ? "— new conversation —" : "New conversation"}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · {timeAgo(s.updated_at)}
            </option>
          ))}
        </select>
        <button className="small" onClick={() => setShowNew(true)} disabled={!!pending || loadingSession} title="Start a new conversation, optionally building on earlier ones">
          + New
        </button>
        {session && messages.length > 1 && (
          <button className="small" onClick={summarize} title="Summarize what you learned into your knowledge base">
            Save to knowledge
          </button>
        )}
      </div>
      {choice && <ModelPicker choice={choice} onChange={setChoice} providers={providers} />}
      {showNew && (
        <NewSessionDialog
          paper={paper}
          onClose={() => setShowNew(false)}
          onCreated={(s) => {
            setShowNew(false);
            openSession(s.id);
            refreshSessions().catch(() => {});
          }}
        />
      )}
      {session && session.builds_on.length > 0 && <p className="muted small builds">Builds on {session.builds_on.length} earlier session(s).</p>}
      {notice && (
        <p className="notice" role="button" tabIndex={0} onClick={() => setNotice(null)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setNotice(null)}>
          {notice}
        </p>
      )}

      <div className="messages" aria-live="polite">
        {messages.length === 0 && !pending && !loadingSession && (
          <div className="starters">
            <p className="muted">Ask anything about this paper. Some ideas:</p>
            {STARTERS.map((s) => (
              <button key={s} className="starter" onClick={() => send(s)} disabled={!!pending || loadingSession}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.meta?.tools?.length ? <ToolTrail tools={m.meta.tools} /> : null}
            {m.role === "assistant" ? <Markdown text={m.content} /> : <div className="user-text">{m.content}</div>}
            {m.role === "assistant" && m.meta?.model && <div className="model-tag">{m.meta.model}</div>}
          </div>
        ))}
        {pending && (
          <div className="msg assistant pending">
            {pending.tools.length > 0 && <ToolTrail tools={pending.tools} />}
            <div className="status">
              <span className="dot" /> {pending.status}
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft, true);
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft, true);
            }
          }}
          placeholder="Ask about this paper… (Shift+Enter for a new line)"
          rows={2}
        />
        {pending ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}

function ToolTrail({ tools }: { tools: (Pick<ToolUse, "name" | "args"> & { ok?: boolean })[] }) {
  return (
    <ul className="tool-trail">
      {tools.map((t, i) => (
        <li key={i} className={t.ok === false ? "failed" : ""}>
          {toolLabel(t)}
        </li>
      ))}
    </ul>
  );
}

function NewSessionDialog({ paper, onClose, onCreated }: { paper: PaperMeta; onClose: () => void; onCreated: (s: Session) => void }) {
  const { user } = useAuth();
  const maxParents = user?.plan === "pro" ? 5 : 1;
  const [all, setAll] = useState<Session[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ sessions: Session[] }>("/sessions")
      .then((r) => setAll(r.sessions.filter((s) => (s.message_count ?? 0) > 0)))
      .catch((e) => setError((e as Error).message));
  }, []);

  const sorted = useMemo(
    () => (all ?? []).slice().sort((a, b) => Number(b.arxiv_id === paper.arxiv_id) - Number(a.arxiv_id === paper.arxiv_id) || b.updated_at - a.updated_at),
    [all, paper.arxiv_id],
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ session: Session }>("/sessions", { method: "POST", json: { arxiv_id: paper.arxiv_id, builds_on: [...picked] } });
      onCreated(r.session);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog">
      <h3>New conversation</h3>
      <p className="muted small">
        Optionally build on earlier sessions (up to {maxParents}
        {maxParents === 1 ? (
          <>
            {" "}
            on the free plan; <Link href="/settings">Pro</Link> allows 5
          </>
        ) : null}
        ). Their summaries are given to the tutor so you can pick up where you left off. Your saved
        notes are always searchable.
      </p>
      {!all && !error && <p className="muted small">Loading your sessions…</p>}
      {all && all.length === 0 && <p className="muted small">No earlier sessions yet.</p>}
      <ul className="pick-list">
        {sorted.map((s) => (
          <li key={s.id}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(s.id)}
                disabled={!picked.has(s.id) && picked.size >= maxParents}
                onChange={(e) => {
                  const next = new Set(picked);
                  e.target.checked ? next.add(s.id) : next.delete(s.id);
                  setPicked(next);
                }}
              />
              <span>
                <strong>{s.title}</strong>
                <span className="muted small">
                  {" "}
                  · {s.arxiv_id === paper.arxiv_id ? "this paper" : (s.paper_title ?? s.arxiv_id)} · {timeAgo(s.updated_at)}
                  {s.summary ? " · summarized" : ""}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" onClick={create} disabled={busy}>
          {busy ? (picked.size ? "Summarizing earlier sessions…" : "Creating…") : "Start"}
        </button>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
