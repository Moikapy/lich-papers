import { useEffect, useMemo, useState } from "react";
import { api, enc, timeAgo, type Collection, type SavedPaper } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { SaveMenu } from "../components/SaveMenu";
import { navigate, useLocation } from "../router";
import { RequireAuth } from "./RequireAuth";

export function LibraryPage() {
  const { user } = useAuth();
  const url = useLocation();
  const selected = url.searchParams.get("c") ? Number(url.searchParams.get("c")) : null;
  const [papers, setPapers] = useState<SavedPaper[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ papers: SavedPaper[]; collections: Collection[] }>("/library")
      .then((r) => {
        setPapers(r.papers);
        setCollections(r.collections);
      })
      .catch((e) => setError((e as Error).message));
  }, [user]);

  const current = collections.find((c) => c.id === selected) ?? null;
  const select = (id: number | null) => navigate(id ? `/library?c=${id}` : "/library", true);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (papers ?? [])
      .filter((p) => !current || p.collection_ids.includes(current.id))
      .filter((p) => !f || `${p.title ?? ""} ${p.authors.join(" ")} ${p.arxiv_id}`.toLowerCase().includes(f));
  }, [papers, current, filter]);

  const fail = (e: unknown) => setError((e as Error).message);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const { collection } = await api<{ collection: Collection }>("/library/collections", { method: "POST", json: { name: newName } });
      setCollections((all) => [...all, collection].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
      setNewName("");
      select(collection.id);
    } catch (err) {
      fail(err);
    }
  };

  const rename = async (c: Collection) => {
    const name = prompt("Rename collection", c.name)?.trim();
    if (!name || name === c.name) return;
    try {
      await api(`/library/collections/${c.id}`, { method: "PATCH", json: { name } });
      setCollections((all) => all.map((x) => (x.id === c.id ? { ...x, name } : x)));
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (c: Collection) => {
    if (!confirm(`Delete the collection “${c.name}”? Its papers stay in your library.`)) return;
    try {
      await api(`/library/collections/${c.id}`, { method: "DELETE" });
      setCollections((all) => all.filter((x) => x.id !== c.id));
      setPapers((all) => all?.map((p) => ({ ...p, collection_ids: p.collection_ids.filter((id) => id !== c.id) })) ?? null);
      select(null);
    } catch (err) {
      fail(err);
    }
  };

  const names = new Map(collections.map((c) => [c.id, c.name]));

  return (
    <RequireAuth>
      <div className="list-page">
        <h1>Library</h1>
        <p className="muted">Papers you saved for later. Sort them into collections from here or from a paper's Save button.</p>
        <div className="filters">
          <button type="button" className={`chip ${!current ? "on" : ""}`} onClick={() => select(null)}>
            All {papers ? `(${papers.length})` : ""}
          </button>
          {collections.map((c) => (
            <button key={c.id} type="button" className={`chip ${current?.id === c.id ? "on" : ""}`} onClick={() => select(c.id)}>
              {c.name} ({c.paper_count})
            </button>
          ))}
        </div>
        <div className="row spread library-tools">
          <form onSubmit={create} className="row">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New collection" maxLength={60} aria-label="New collection name" />
            <button className="small" disabled={!newName.trim()}>
              Create
            </button>
          </form>
          {current && (
            <div className="row">
              <button className="small" onClick={() => rename(current)}>
                Rename
              </button>
              <button className="small danger" onClick={() => remove(current)}>
                Delete collection
              </button>
            </div>
          )}
        </div>
        <input className="filter" placeholder="Filter by title, author or id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <p className="error">{error}</p>}
        {papers && papers.length === 0 && (
          <p className="muted">
            Nothing saved yet. <Link href="/">Find a paper</Link> and press Save.
          </p>
        )}
        {papers && papers.length > 0 && shown.length === 0 && <p className="muted">No papers here yet.</p>}
        <ul className="session-list">
          {shown.map((p) => (
            <li key={p.arxiv_id} className="card">
              <div className="row spread">
                <div>
                  <Link href={`/paper/${enc(p.arxiv_id)}`} className="title">
                    {p.title ?? `arXiv:${p.arxiv_id}`}
                  </Link>
                  <div className="byline">
                    {p.authors.slice(0, 6).join(", ")}
                    {p.authors.length > 6 ? ` +${p.authors.length - 6}` : ""}
                  </div>
                  <div className="meta">
                    <span>arXiv:{p.arxiv_id}</span>
                    {p.published && <span>{p.published.slice(0, 10)}</span>}
                    <span>saved {timeAgo(p.saved_at)}</span>
                    {p.collection_ids.map((id) => names.has(id) && <span key={id} className="tag">{names.get(id)}</span>)}
                  </div>
                </div>
                <SaveMenu
                  arxivId={p.arxiv_id}
                  status={{ saved: true, collection_ids: p.collection_ids }}
                  collections={collections}
                  onCollections={setCollections}
                  onStatus={(s) =>
                    setPapers((all) =>
                      s.saved ? (all?.map((x) => (x.arxiv_id === p.arxiv_id ? { ...x, collection_ids: s.collection_ids } : x)) ?? null) : (all?.filter((x) => x.arxiv_id !== p.arxiv_id) ?? null),
                    )
                  }
                  savedLabel="Collections"
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </RequireAuth>
  );
}
