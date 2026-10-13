import { useEffect, useState } from "react";
import { api, enc, timeAgo, type KnowledgeEntry } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { Markdown } from "../components/Markdown";
import { RequireAuth } from "./RequireAuth";

export function KnowledgePage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = (query = q) =>
    api<{ entries: KnowledgeEntry[] }>(`/knowledge${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    if (user) load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api("/knowledge", { method: "POST", json: { title: noteTitle, content: note, tags } });
      setNote("");
      setNoteTitle("");
      setTags("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await api(`/knowledge/${id}`, { method: "DELETE" });
      setEntries((all) => all?.filter((x) => x.id !== id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <RequireAuth>
      <div className="list-page">
        <div className="row spread">
          <h1>Knowledge base</h1>
          {user?.plan === "pro" ? (
            <a className="button small" href="/api/knowledge/export" download>
              Export Markdown
            </a>
          ) : (
            <Link className="button small" href="/settings" title="Exporting is a Pro feature">
              Export (Pro)
            </Link>
          )}
        </div>
        <p className="muted">
          Notes the tutor saved for you and summaries of past sessions. Every new conversation can search these, so what you learn on one paper
          carries over to the next.{user?.plan !== "pro" && " The free plan keeps up to 100 notes."}
        </p>
        <form
          className="searchbar"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <input placeholder="Search your knowledge…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button>Search</button>
        </form>
        <details className="card">
          <summary>Add a note</summary>
          <form onSubmit={add} className="stack">
            <input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Title" aria-label="Note title" />
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Something worth remembering… (Markdown works)" aria-label="Note" />
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" />
            <button className="primary">Save note</button>
          </form>
        </details>
        {error && <p className="error">{error}</p>}
        {entries && entries.length === 0 && <p className="muted">Nothing here yet.</p>}
        <ul className="session-list">
          {entries?.map((k) => (
            <NoteCard key={k.id} note={k} onDelete={() => remove(k.id)} />
          ))}
        </ul>
      </div>
    </RequireAuth>
  );
}

const LONG_NOTE = 700;

function NoteCard({ note: k, onDelete }: { note: KnowledgeEntry; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const long = k.content.length > LONG_NOTE;
  const title = k.title || (k.kind === "summary" ? "Session summary" : firstLine(k.content));
  const tags = k.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return (
    <li className="card note-card">
      <div className="row spread">
        <h3 className="note-title">{title}</h3>
        <button className="small danger" onClick={onDelete} aria-label={`Delete “${title}”`}>
          Delete
        </button>
      </div>
      <div className="note-meta muted small">
        <span className={`tag ${k.kind}`}>{k.kind === "summary" ? "Session summary" : "Note"}</span>
        <span>{timeAgo(k.created_at)}</span>
        {k.arxiv_id && (
          <Link href={`/paper/${enc(k.arxiv_id)}${k.session_id ? `?session=${k.session_id}` : ""}`}>{k.paper_title ?? `arXiv:${k.arxiv_id}`}</Link>
        )}
      </div>
      <div className={`note-body${long && !expanded ? " clamped" : ""}`}>
        <Markdown text={k.content} />
      </div>
      {long && (
        <button className="linklike small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {tags.length > 0 && (
        <div className="note-tags">
          {tags.map((t) => (
            <span key={t} className="chip static">
              {t}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/** Title fallback for older untitled notes: the first line, without Markdown markers. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "Note";
  const clean = line.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim();
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean || "Note";
}
