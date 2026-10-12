import { useEffect, useRef, useState } from "react";
import { api, enc, type Collection, type SavedStatus } from "../api";

interface SaveMenuProps {
  arxivId: string;
  status: SavedStatus;
  collections: Collection[];
  onStatus: (s: SavedStatus) => void;
  onCollections: (c: Collection[]) => void;
  /** Label for the closed button when the paper is saved. */
  savedLabel?: string;
}

/** Save button with a dropdown for choosing the paper's collections. */
export function SaveMenu({ arxivId, status, collections, onStatus, onCollections, savedLabel = "Saved" }: SaveMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const put = async (collection_ids?: number[]) => {
    const s = await api<SavedStatus>(`/library/papers/${enc(arxivId)}`, { method: "PUT", json: collection_ids ? { collection_ids } : {} });
    onStatus(s);
    // Keep the per-collection counts in step with the change.
    const before = new Set(status.collection_ids);
    const after = new Set(s.collection_ids);
    onCollections(collections.map((c) => ({ ...c, paper_count: c.paper_count + (after.has(c.id) ? 1 : 0) - (before.has(c.id) ? 1 : 0) })));
  };

  const save = () =>
    run(async () => {
      await put();
      setOpen(true);
    });

  const toggle = (id: number) =>
    run(() => put(status.collection_ids.includes(id) ? status.collection_ids.filter((x) => x !== id) : [...status.collection_ids, id]));

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    run(async () => {
      const { collection } = await api<{ collection: Collection }>("/library/collections", { method: "POST", json: { name: newName } });
      const all = [...collections, collection].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      onCollections(all);
      setNewName("");
      const s = await api<SavedStatus>(`/library/papers/${enc(arxivId)}`, { method: "PUT", json: { collection_ids: [...status.collection_ids, collection.id] } });
      onStatus(s);
      onCollections(all.map((c) => (c.id === collection.id ? { ...c, paper_count: 1 } : c)));
    });
  };

  const remove = () =>
    run(async () => {
      await api(`/library/papers/${enc(arxivId)}`, { method: "DELETE" });
      onCollections(collections.map((c) => (status.collection_ids.includes(c.id) ? { ...c, paper_count: c.paper_count - 1 } : c)));
      onStatus({ saved: false, collection_ids: [] });
      setOpen(false);
    });

  if (!status.saved) {
    return (
      <div className="save-menu" ref={ref}>
        <button className="small" onClick={save} disabled={busy} title="Save to your library">
          <Bookmark /> Save
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  }

  return (
    <div className="save-menu" ref={ref}>
      <button className="small saved" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
        <Bookmark filled /> {savedLabel} ▾
      </button>
      {open && (
        <div className="save-pop card" role="group" aria-label="Collections">
          <div className="muted small">Collections</div>
          {collections.length === 0 && <div className="muted small">No collections yet.</div>}
          <ul>
            {collections.map((c) => (
              <li key={c.id}>
                <label>
                  <input type="checkbox" checked={status.collection_ids.includes(c.id)} disabled={busy} onChange={() => toggle(c.id)} /> {c.name}
                </label>
              </li>
            ))}
          </ul>
          <form onSubmit={create} className="row">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New collection" maxLength={60} aria-label="New collection name" />
            <button className="small" disabled={busy || !newName.trim()}>
              Add
            </button>
          </form>
          {error && <p className="error small">{error}</p>}
          <button className="small danger" onClick={remove} disabled={busy}>
            Remove from library
          </button>
        </div>
      )}
    </div>
  );
}

/** One-click save/unsave star for lists such as search results. */
export function BookmarkToggle({ arxivId, saved, onChange }: { arxivId: string; saved: boolean; onChange: (saved: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      await api(`/library/papers/${enc(arxivId)}`, saved ? { method: "DELETE" } : { method: "PUT", json: {} });
      onChange(!saved);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={`icon-button${saved ? " saved" : ""}`}
      onClick={click}
      disabled={busy}
      aria-pressed={saved}
      aria-label={saved ? "Remove from library" : "Save to library"}
      title={saved ? "Remove from library" : "Save to library"}
    >
      <Bookmark filled={saved} />
    </button>
  );
}

export function Bookmark({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12v18l-6-4.5L6 21z" />
    </svg>
  );
}
