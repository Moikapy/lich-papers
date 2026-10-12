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
      await api("/knowledge", { method: "POST", json: { content: note, tags } });
      setNote("");
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
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Something worth remembering…" />
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" />
            <button className="primary">Save note</button>
          </form>
        </details>
        {error && <p className="error">{error}</p>}
        {entries && entries.length === 0 && <p className="muted">Nothing here yet.</p>}
        <ul className="session-list">
          {entries?.map((k) => (
            <li key={k.id} className="card">
              <div className="row spread">
                <div className="muted small">
                  <span className={`tag ${k.kind}`}>{k.kind}</span> #{k.id} · {timeAgo(k.created_at)}
                  {k.arxiv_id && (
                    <>
                      {" "}
                      · <Link href={`/paper/${enc(k.arxiv_id)}${k.session_id ? `?session=${k.session_id}` : ""}`}>arXiv:{k.arxiv_id}</Link>
                    </>
                  )}
                  {k.tags && ` · ${k.tags}`}
                </div>
                <button className="small danger" onClick={() => remove(k.id)}>
                  Delete
                </button>
              </div>
              <Markdown text={k.content} />
            </li>
          ))}
        </ul>
      </div>
    </RequireAuth>
  );
}
