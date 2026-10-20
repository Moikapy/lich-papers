import { useEffect, useState } from "react";
import { api, enc, type PaperMeta, type PopularPaper } from "../api";
import { useAuth } from "../auth";
import { Link } from "../components/Link";
import { BookmarkToggle } from "../components/SaveMenu";
import { navigate, useLocation } from "../router";

const CATEGORIES: [string, string][] = [
  ["cs.AI", "AI"],
  ["cs.LG", "Machine learning"],
  ["cs.CL", "NLP"],
  ["cs.CV", "Vision"],
  ["cs.RO", "Robotics"],
  ["stat.ML", "Stats ML"],
  ["math.OC", "Optimization"],
  ["quant-ph", "Quantum"],
  ["astro-ph", "Astrophysics"],
  ["q-bio", "Biology"],
  ["econ", "Economics"],
];
const PAGE = 20;

export function SearchPage() {
  const url = useLocation();
  const q = url.searchParams.get("q") ?? "";
  const cat = url.searchParams.get("cat") ?? "";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const start = Number(url.searchParams.get("start") ?? 0);
  const smart = url.searchParams.get("rerank") === "1";
  const [draft, setDraft] = useState(q);
  const [data, setData] = useState<{ total: number; papers: PaperMeta[]; reranked?: boolean } | null>(null);
  const [canRerank, setCanRerank] = useState(false);
  const useRerank = smart && canRerank && sort === "relevance";
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();
  const [savedIds, setSavedIds] = useState<Set<string> | null>(null);
  const [popular, setPopular] = useState<PopularPaper[]>([]);

  useEffect(() => setDraft(q), [q]);

  useEffect(() => {
    if (!user) return setSavedIds(null);
    api<{ ids: string[] }>("/library/ids")
      .then((r) => setSavedIds(new Set(r.ids)))
      .catch(() => setSavedIds(null));
  }, [user]);

  useEffect(() => {
    if (!user) return setCanRerank(false);
    api<{ active: boolean }>("/settings/decision")
      .then((r) => setCanRerank(r.active))
      .catch(() => setCanRerank(false));
  }, [user]);

  useEffect(() => {
    api<{ papers: PopularPaper[] }>("/popular")
      .then((r) => setPopular(r.papers))
      .catch(() => setPopular([]));
  }, []);

  const bookmark = (id: string) =>
    savedIds && (
      <BookmarkToggle
        arxivId={id}
        saved={savedIds.has(id)}
        onChange={(saved) =>
          setSavedIds((ids) => {
            const next = new Set(ids);
            if (saved) next.add(id);
            else next.delete(id);
            return next;
          })
        }
      />
    );

  useEffect(() => {
    if (!q && !cat) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ q, sort, start: String(start), max: String(PAGE) });
    if (cat) params.set("category", cat);
    if (useRerank) params.set("rerank", "1");
    setLoading(true);
    setError(null);
    api<{ total: number; papers: PaperMeta[]; reranked?: boolean }>(`/search?${params}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, cat, sort, start, useRerank]);

  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(url.search);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    if (!("start" in patch)) p.delete("start");
    navigate(`/search?${p}`);
  };

  return (
    <div className="search">
      {(q || cat) && <h1 className="sr-only">Search results{q ? ` for “${q}”` : ""}</h1>}
      {!q && !cat && (
        <section className="hero">
          <h1>Read any arXiv paper with a tutor at your side.</h1>
          <p className="muted">
            Search 2.4M+ papers, open one, and ask questions. Your conversations are saved, and what you learn carries into
            the next session.
          </p>
        </section>
      )}
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: draft.trim() || null });
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Search titles, abstracts, authors — or paste an arXiv id/URL (try: au:hinton, ti:"attention is all you need")'
        />
        <button className="primary">Search</button>
      </form>
      <div className="filters">
        {CATEGORIES.map(([id, label]) => (
          <button key={id} className={`chip ${cat === id ? "on" : ""}`} onClick={() => go({ cat: cat === id ? null : id })} type="button">
            {label}
          </button>
        ))}
        <select value={sort} onChange={(e) => go({ sort: e.target.value })} aria-label="Sort">
          <option value="relevance">Most relevant</option>
          <option value="submittedDate">Newest</option>
          <option value="lastUpdatedDate">Recently updated</option>
        </select>
        {canRerank && sort === "relevance" && (
          <label className="small" title="Re-rank the results on this page with your decision model (Clef)">
            <input type="checkbox" checked={smart} onChange={(e) => go({ rerank: e.target.checked ? "1" : null })} /> Smart ranking
          </label>
        )}
        {data?.reranked && <span className="muted small">Re-ranked by relevance</span>}
      </div>

      {!q && !cat && popular.length > 0 && (
        <section className="popular" aria-labelledby="popular-heading">
          <h2 id="popular-heading">Popular this month</h2>
          <ol className="results">
            {popular.map((p) => (
              <li key={p.arxiv_id} className="result">
                <div className="row spread">
                  <Link href={`/paper/${enc(p.arxiv_id)}`} className="title">
                    {p.title}
                  </Link>
                  {bookmark(p.arxiv_id)}
                </div>
                <div className="byline">
                  {p.authors.slice(0, 4).join(", ")}
                  {p.authors.length > 4 ? ` +${p.authors.length - 4}` : ""}
                </div>
                <div className="meta">
                  <span>{p.readers} readers</span>
                  <span>arXiv:{p.arxiv_id}</span>
                  {p.categories.slice(0, 2).map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Searching arXiv…</p>}
      {data && !loading && (
        <>
          <p className="muted small">{data.total.toLocaleString()} results</p>
          <ul className="results">
            {data.papers.map((p) => (
              <li key={p.arxiv_id} className="result">
                <div className="row spread">
                  <Link href={`/paper/${enc(p.arxiv_id)}`} className="title">
                    {p.title}
                  </Link>
                  {bookmark(p.arxiv_id)}
                </div>
                <div className="byline">
                  {p.authors.slice(0, 6).join(", ")}
                  {p.authors.length > 6 ? ` +${p.authors.length - 6}` : ""}
                </div>
                <div className="meta">
                  <span>arXiv:{p.arxiv_id}</span>
                  {p.published && <span>{p.published.slice(0, 10)}</span>}
                  {p.categories.slice(0, 3).map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
                </div>
                <p className="abstract">{p.abstract.length > 420 ? `${p.abstract.slice(0, 420)}…` : p.abstract}</p>
              </li>
            ))}
          </ul>
          {data.total > PAGE && (
            <div className="pager">
              <button disabled={start === 0} onClick={() => go({ start: String(Math.max(0, start - PAGE)) })}>
                ← Previous
              </button>
              <span className="muted small">
                {start + 1}–{Math.min(start + PAGE, data.total)}
              </span>
              <button disabled={start + PAGE >= data.total} onClick={() => go({ start: String(start + PAGE) })}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
