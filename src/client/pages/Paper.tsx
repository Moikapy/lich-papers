import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, chatProviders, enc, postStream, PROVIDER_LABELS, timeAgo, type ChatProvider, type ChatMessage, type Collection, type ModelInfo, type PaperMeta, type ProviderId, type SavedStatus, type Session, type ToolUse, type Grounding } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { Markdown } from "../components/Markdown";
import { SaveMenu } from "../components/SaveMenu";
import { navigate } from "../router";


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
        <div className="title-row">
          <h1>{paper.title}</h1>
          <PaperSave arxivId={paper.arxiv_id} />
        </div>
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

/** Save button in the paper header; signed-out readers get a sign-in link instead. */
function PaperSave({ arxivId }: { arxivId: string }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<SavedStatus | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);

  useEffect(() => {
    if (!user) return;
    api<SavedStatus & { collections: Collection[] }>(`/library/papers/${enc(arxivId)}`)
      .then((r) => {
        setStatus({ saved: r.saved, collection_ids: r.collection_ids });
        setCollections(r.collections);
      })
      .catch(() => setStatus(null));
  }, [user, arxivId]);

  if (!user) {
    return (
      <Link className="button small" href={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} title="Sign in to save papers">
        Save
      </Link>
    );
  }
  if (!status) return null;
  return <SaveMenu arxivId={arxivId} status={status} collections={collections} onStatus={setStatus} onCollections={setCollections} />;
}

interface ReaderText {
  open: boolean;
  license: string | null;
  license_label: string;
  abs_url: string;
  html_url: string;
  pdf_url: string;
  body?: string;
  source?: "html" | "pdf" | "abstract";
}

/**
 * The reader shows full text only when the paper's license allows it, with attribution.
 * For every other paper it shows the abstract and links to arXiv, where the PDF and HTML live.
 */
function Reader({ paper, onQuote }: { paper: PaperMeta; onQuote: (t: string) => void }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<ReaderText | null>(null);
  const [loadingText, setLoadingText] = useState(true);
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

  // Reader is keyed by arxiv id, so state starts fresh for each paper. `attempt` drives Retry.
  useEffect(() => {
    let cancelled = false;
    setLoadingText(true);
    setTextError(null);
    api<ReaderText>(`/papers/${enc(paper.arxiv_id)}/text`)
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && setTextError((e as Error).message))
      .finally(() => !cancelled && setLoadingText(false));
    return () => {
      cancelled = true;
    };
  }, [paper.arxiv_id, attempt]);

  const captureSelection = () => setSelection(window.getSelection()?.toString().trim() ?? "");
  const abs = `https://arxiv.org/abs/${paper.arxiv_id}`;

  return (
    <section className="reader">
      <div className="toolbar">
        <span className="license-tag" title={text?.license ?? undefined}>
          {text ? text.license_label : "Paper"}
        </span>
        {selection && text?.open && (
          <button className="small" onClick={() => (onQuote(selection), setSelection(""))}>
            Ask about selection
          </button>
        )}
        <a className="small" href={text?.pdf_url ?? `https://arxiv.org/pdf/${paper.arxiv_id}`} target="_blank" rel="noreferrer">
          PDF on arXiv ↗
        </a>
      </div>
      <div className="paper-text" ref={textRef} onMouseUp={captureSelection}>
        {loadingText && <p className="muted">Loading the paper…</p>}
        {textError && (
          <p className="error">
            {textError}{" "}
            <button className="small" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </p>
        )}
        {text && !loadingText && text.open && text.body && (
          <>
            <p className="attribution small">
              “{paper.title}” by {paper.authors.slice(0, 3).join(", ")}
              {paper.authors.length > 3 ? " et al." : ""}, from{" "}
              <a href={text.abs_url} target="_blank" rel="noreferrer">
                arXiv:{paper.arxiv_id}
              </a>
              , licensed under{" "}
              {text.license ? (
                <a href={text.license} target="_blank" rel="noreferrer license">
                  {text.license_label}
                </a>
              ) : (
                text.license_label
              )}
              . Text extracted from {text.source === "html" ? "arXiv's HTML version" : "the PDF"} and reformatted for reading. Select text and
              click “Ask about selection”.
            </p>
            {text.source === "html" ? <Markdown text={text.body} variant="document" /> : <pre className="plain">{text.body}</pre>}
          </>
        )}
        {text && !loadingText && !text.open && (
          <div className="restricted">
            <h2>Abstract</h2>
            <p>{paper.abstract}</p>
            <div className="row">
              <a className="button primary" href={text.html_url} target="_blank" rel="noreferrer">
                Read on arXiv ↗
              </a>
              <a className="button" href={text.pdf_url} target="_blank" rel="noreferrer">
                PDF ↗
              </a>
            </div>
            <p className="muted small">
              This paper's license ({text.license_label}) doesn't allow us to show its full text here, so read it on arXiv. The tutor can still
              read it to answer your questions in the chat. To ask about a passage, paste it into the chat.
            </p>
          </div>
        )}
        {text && !loadingText && text.open && !text.body && (
          <p className="muted">
            Couldn't load the full text right now. <a href={abs}>Read it on arXiv ↗</a>
          </p>
        )}
      </div>
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
  save_knowledge: (a) => (typeof a.title === "string" && a.title ? `Saved “${a.title}” to your notes` : "Saved a note to your notes"),
  search_arxiv: (a) => `Searched arXiv for “${a.query}”`,
  get_arxiv_paper: (a) => `Looked up arXiv:${a.arxiv_id}`,
  paper_figures: () => "Listed the figures",
  inspect_figure: (a) => `Looked at figure ${a.figure}`,
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
        placeholder={choice.provider === "openrouter" ? "openrouter/free" : choice.provider === "pro" ? "default Pro model" : choice.provider === "ollama" ? "e.g. gpt-oss:120b" : "model id"}
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
            } else if (event === "grounding") {
              setMessages((m) => {
                const i = m.length - 1;
                const last = m[i];
                if (!last || last.role !== "assistant" || !last.meta) return m;
                return [...m.slice(0, i), { ...last, meta: { ...last.meta, grounding: data } }];
              });
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
        {messages.map((m, i) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.meta?.tools?.length ? <ToolTrail tools={m.meta.tools} /> : null}
            {m.role === "assistant" ? <Markdown text={m.content} /> : <div className="user-text">{m.content}</div>}
            {m.role === "assistant" && (
              <div className="msg-footer">
                {m.meta?.model && <span className="model-tag">{m.meta.model}</span>}
                {m.meta?.grounding && <GroundingBadge g={m.meta.grounding} />}
                <SaveNoteButton
                  content={m.content}
                  question={messages[i - 1]?.role === "user" ? messages[i - 1]!.content : ""}
                  arxivId={paper.arxiv_id}
                  sessionId={session?.id ?? null}
                />
              </div>
            )}
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

/** Saves an answer to the knowledge base, titled after the question it answered. */
function SaveNoteButton({ content, question, arxivId, sessionId }: { content: string; question: string; arxivId: string; sessionId: string | null }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const title = question.replace(/\s+/g, " ").trim().slice(0, 100) || "Saved answer";
  const save = async () => {
    setState("saving");
    try {
      await api("/knowledge", { method: "POST", json: { title, content, arxiv_id: arxivId, session_id: sessionId } });
      setState("saved");
    } catch (e) {
      setMessage((e as Error).message);
      setState("error");
    }
  };
  if (state === "saved")
    return (
      <Link className="small save-note done" href="/knowledge">
        ✓ Saved to notes
      </Link>
    );
  return (
    <button className="linklike small save-note" onClick={save} disabled={state === "saving"} title={message ?? "Save this answer to your knowledge base"}>
      {state === "saving" ? "Saving…" : state === "error" ? "Couldn't save, retry" : "Save to notes"}
    </button>
  );
}

const GROUNDING_TEXT: Record<Grounding["verdict"], string> = {
  grounded: "Supported by the paper",
  partly: "Partly supported",
  unsupported: "Not supported by what it read",
};

/** The decision model's verdict on whether an answer's claims appear in the passages the tutor read. */
function GroundingBadge({ g }: { g: Grounding }) {
  const pct = Math.round(g.p * 100);
  const basis = g.evidence === "passages" ? "the passages the tutor read" : "the paper's opening excerpt (the tutor didn't look anything up)";
  return (
    <span className={`grounding ${g.verdict}`} title={`Checked against ${basis}: ${pct}% likely every claim about the paper is supported. A hint, not a guarantee; it's weaker on math.`}>
      {GROUNDING_TEXT[g.verdict]}
    </span>
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
