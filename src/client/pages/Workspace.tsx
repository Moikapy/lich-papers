import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Page, type PageSummary } from "../api";
import { PageEditor } from "../editor/Editor";
import { Link } from "../components/Link";
import { navigate } from "../router";
import { RequireAuth } from "./RequireAuth";

const LAST_PAGE_KEY = "lp_last_page";
const SAVE_DELAY_MS = 800;

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_PAGE_KEY, id);
    else localStorage.removeItem(LAST_PAGE_KEY);
  } catch {}
};
const lastPage = () => {
  try {
    return localStorage.getItem(LAST_PAGE_KEY);
  } catch {
    return null;
  }
};

/** The workspace: the page tree on the left, the open page on the right. */
export function WorkspacePage({ pageId }: { pageId: string | null }) {
  return (
    <RequireAuth>
      <Workspace pageId={pageId} />
    </RequireAuth>
  );
}

function Workspace({ pageId }: { pageId: string | null }) {
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  const reload = useCallback(
    () =>
      api<{ pages: PageSummary[] }>("/pages")
        .then((r) => setPages(r.pages))
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => void reload(), [reload]);

  // No page in the URL: reopen the last one, or the first.
  useEffect(() => {
    if (pageId || !pages?.length) return;
    const last = lastPage();
    const target = pages.find((p) => p.id === last) ?? pages.find((p) => !p.parent_id) ?? pages[0]!;
    navigate(`/p/${target.id}`, true);
  }, [pageId, pages]);

  useEffect(() => {
    if (pageId) remember(pageId);
    setDrawer(false);
  }, [pageId]);

  const create = async (parentId: string | null) => {
    try {
      const { page } = await api<{ page: PageSummary }>("/pages", { method: "POST", json: { parent_id: parentId, title: "" } });
      setPages((ps) => [...(ps ?? []), page]);
      navigate(`/p/${page.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (page: PageSummary) => {
    const children = (pages ?? []).filter((p) => p.parent_id === page.id).length;
    const what = page.title || "Untitled";
    if (!confirm(children ? `Delete "${what}" and the pages inside it?` : `Delete "${what}"?`)) return;
    try {
      await api(`/pages/${page.id}`, { method: "DELETE" });
      if (lastPage() === page.id) remember(null);
      await reload();
      if (pageId === page.id) navigate("/", true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const importNotes = async () => {
    try {
      const r = await api<{ imported: number; first_id: string | null }>("/pages/import-notes", { method: "POST" });
      await reload();
      // Open the first imported note, which also expands the "Imported notes" folder.
      if (r.imported && r.first_id) navigate(`/p/${r.first_id}`);
      else setError("No new notes to import.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const patchLocal = (id: string, m: Partial<PageSummary>) => setPages((ps) => ps?.map((p) => (p.id === id ? { ...p, ...m } : p)) ?? ps);

  return (
    <div className={`workspace${drawer ? " drawer-open" : ""}`}>
      <aside className="page-sidebar" aria-label="Pages">
        <div className="row spread">
          <strong>Pages</strong>
          <button className="linklike" onClick={() => create(null)} title="New page" aria-label="New page">
            ＋
          </button>
        </div>
        {pages === null ? (
          <p className="muted small">Loading…</p>
        ) : (
          <PageTree pages={pages} parentId={null} activeId={pageId} onAdd={create} onDelete={remove} depth={0} />
        )}
        <div className="sidebar-foot">
          <button className="linklike small" onClick={importNotes} title="Copy your saved notes and session summaries into pages">
            Import notes
          </button>
          <Link href="/search" className="small">
            Find papers
          </Link>
        </div>
      </aside>
      <button className="drawer-toggle" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer} aria-label="Show pages">
        ☰ Pages
      </button>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <section className="page-main">
        {error && (
          <p className="notice" role="button" tabIndex={0} onClick={() => setError(null)} onKeyDown={(e) => e.key === "Enter" && setError(null)}>
            {error}
          </p>
        )}
        {pageId ? (
          <PageView key={pageId} id={pageId} onMeta={(m) => patchLocal(pageId, m)} />
        ) : pages && !pages.length ? (
          <div className="empty-workspace">
            <h1>Your pages</h1>
            <p className="muted">Write notes, keep track of papers, and think things through. Lich can help along the way.</p>
            <div className="row">
              <button className="primary" onClick={() => create(null)}>
                New page
              </button>
              <button onClick={importNotes}>Import my saved notes</button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PageTree(props: {
  pages: PageSummary[];
  parentId: string | null;
  activeId: string | null;
  depth: number;
  onAdd: (parentId: string) => void;
  onDelete: (page: PageSummary) => void;
}) {
  const { pages, parentId, activeId, depth } = props;
  const children = useMemo(() => pages.filter((p) => p.parent_id === parentId).sort((a, b) => a.position - b.position), [pages, parentId]);
  // Expand the branch holding the open page.
  const ancestors = useMemo(() => {
    const parentOf = new Map(pages.map((p) => [p.id, p.parent_id]));
    const set = new Set<string>();
    for (let cur = activeId ? parentOf.get(activeId) : null; cur; cur = parentOf.get(cur) ?? null) set.add(cur);
    return set;
  }, [pages, activeId]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!children.length) return depth === 0 ? <p className="muted small">No pages yet.</p> : null;
  return (
    <ul className="page-tree" role={depth === 0 ? "tree" : "group"}>
      {children.map((p) => {
        const hasKids = pages.some((c) => c.parent_id === p.id);
        const expanded = open.has(p.id) || ancestors.has(p.id);
        return (
          <li key={p.id} role="treeitem" aria-expanded={hasKids ? expanded : undefined} aria-selected={p.id === activeId}>
            <div className={`page-row${p.id === activeId ? " active" : ""}`} style={{ paddingLeft: `${depth * 0.9 + 0.2}rem` }}>
              <button
                className="twisty"
                aria-label={expanded ? "Collapse" : "Expand"}
                disabled={!hasKids}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(p.id) || ancestors.has(p.id)) n.delete(p.id);
                    else n.add(p.id);
                    return n;
                  })
                }
              >
                {hasKids ? (expanded ? "▾" : "▸") : "·"}
              </button>
              <Link href={`/p/${p.id}`} className="page-link">
                <span className="page-icon">{p.icon ?? "📄"}</span>
                <span className="page-title">{p.title || "Untitled"}</span>
              </Link>
              <button className="row-action" onClick={() => props.onAdd(p.id)} title="Add a page inside" aria-label={`Add a page inside ${p.title || "Untitled"}`}>
                ＋
              </button>
              <button className="row-action" onClick={() => props.onDelete(p)} title="Delete" aria-label={`Delete ${p.title || "Untitled"}`}>
                ×
              </button>
            </div>
            {hasKids && expanded && <PageTree {...props} parentId={p.id} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

type SaveState = "saved" | "saving" | "unsaved" | "error";

/** One open page: icon, title and editor, saved automatically. */
function PageView({ id, onMeta }: { id: string; onMeta: (m: Partial<PageSummary>) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api<{ page: Page }>(`/pages/${id}`)
      .then((r) => setPage(r.page))
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const flush = useCallback(
    async (keepalive = false) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const patch = pending.current;
      if (!Object.keys(patch).length) return;
      pending.current = {};
      setState("saving");
      try {
        if (keepalive) {
          // Leaving the page: a keepalive request survives the unload.
          await fetch(`/api/pages/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch), keepalive: true, credentials: "same-origin" });
        } else {
          await api(`/pages/${id}`, { method: "PATCH", json: patch });
        }
        setState(Object.keys(pending.current).length ? "unsaved" : "saved");
      } catch (e) {
        // Keep the edits so the next change (or retry) sends them again.
        pending.current = { ...patch, ...pending.current };
        setState("error");
        setError((e as Error).message);
      }
    },
    [id],
  );

  const queue = useCallback(
    (patch: Record<string, unknown>) => {
      pending.current = { ...pending.current, ...patch };
      setState("unsaved");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  // Save on switching pages, hiding the tab, or closing it.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flush(true);
    const onUnload = () => void flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onUnload);
      void flush(true);
    };
  }, [flush]);

  const initial = useMemo(() => {
    if (!page?.content) return null;
    if (page.format === "html") return page.content;
    try {
      return JSON.parse(page.content);
    } catch {
      return null;
    }
  }, [page]);

  if (error && !page) return <p className="error">{error}</p>;
  if (!page) return <p className="muted">Loading…</p>;

  return (
    <article className="page">
      <div className="page-head">
        <button
          className="page-icon-button"
          title="Change icon"
          onClick={() => {
            const icon = prompt("Icon (an emoji)", page.icon ?? "📄");
            if (icon === null) return;
            setPage({ ...page, icon });
            onMeta({ icon });
            queue({ icon });
          }}
        >
          {page.icon ?? "📄"}
        </button>
        <span className={`save-state ${state}`} aria-live="polite">
          {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : state === "unsaved" ? "Editing…" : "Not saved, retrying on next edit"}
        </span>
      </div>
      <input
        className="page-title-input"
        value={page.title}
        placeholder="Untitled"
        aria-label="Page title"
        autoFocus={!page.title}
        onChange={(e) => {
          const title = e.target.value;
          setPage({ ...page, title });
          onMeta({ title });
          queue({ title });
        }}
        onKeyDown={(e) => {
          // Enter moves into the page; without preventDefault the keypress would also add an empty first line.
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            (document.querySelector(".page-doc") as HTMLElement | null)?.focus();
          }
        }}
      />
      <PageEditor initial={initial} autofocus={!!page.title && !page.content} onChange={(content, text) => queue({ content, text })} />
    </article>
  );
}
