import { useEffect, useMemo, useState } from "react";
import { api, enc, timeAgo, type Session } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { Markdown } from "../components/Markdown";
import { RequireAuth } from "./RequireAuth";

export function SessionsPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ sessions: Session[] }>("/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError((e as Error).message));
  }, [user]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (sessions ?? []).filter((s) => !f || `${s.title} ${s.paper_title ?? ""} ${s.arxiv_id}`.toLowerCase().includes(f));
  }, [sessions, filter]);

  const remove = async (s: Session) => {
    if (!confirm(`Delete “${s.title}”? Notes saved to your knowledge base are kept.`)) return;
    try {
      await api(`/sessions/${s.id}`, { method: "DELETE" });
      setSessions((all) => all?.filter((x) => x.id !== s.id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <RequireAuth>
      <div className="list-page">
        <h1>Conversation history</h1>
        <input className="filter" placeholder="Filter by title or paper…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <p className="error">{error}</p>}
        {sessions && sessions.length === 0 && (
          <p className="muted">
            No conversations yet. <Link href="/">Find a paper</Link> and ask it something.
          </p>
        )}
        <ul className="session-list">
          {shown.map((s) => (
            <li key={s.id} className="card">
              <div className="row spread">
                <div>
                  <Link href={`/paper/${enc(s.arxiv_id)}?session=${s.id}`} className="title">
                    {s.title}
                  </Link>
                  <div className="muted small">
                    {s.paper_title ?? `arXiv:${s.arxiv_id}`} · {s.message_count ?? 0} messages · {timeAgo(s.updated_at)}
                    {s.builds_on.length > 0 && ` · builds on ${s.builds_on.length}`}
                  </div>
                </div>
                <div className="row">
                  {s.summary && (
                    <button className="small" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      {open === s.id ? "Hide summary" : "Summary"}
                    </button>
                  )}
                  <button className="small danger" onClick={() => remove(s)}>
                    Delete
                  </button>
                </div>
              </div>
              {open === s.id && s.summary && <Markdown text={s.summary} className="summary" />}
            </li>
          ))}
        </ul>
      </div>
    </RequireAuth>
  );
}
