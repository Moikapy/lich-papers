import { useEffect, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { api, enc, type PaperMeta } from "../api";
import { Link } from "../components/Link";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paperEmbed: { insertPaper: (arxivId: string) => ReturnType };
  }
}

/** Pulls an arXiv id out of an id, "arXiv:…" reference or arxiv.org URL. */
export function parseArxivRef(input: string): string | null {
  const m = input.trim().match(/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i);
  return m ? m[1]! : null;
}

/** An arXiv paper on a page: title, authors and abstract, with links to the reader. Lich can read the paper by its id. */
export const PaperEmbed = Node.create({
  name: "paperEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      arxivId: { default: "", parseHTML: (el) => el.getAttribute("data-arxiv-id") ?? "" },
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title") ?? "" },
      authors: { default: "", parseHTML: (el) => el.getAttribute("data-authors") ?? "" },
    };
  },
  parseHTML: () => [{ tag: 'div[data-type="paper-embed"]' }],
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "paper-embed", "data-arxiv-id": node.attrs.arxivId, "data-title": node.attrs.title, "data-authors": node.attrs.authors })];
  },
  renderText: ({ node }) => `\n[paper arXiv:${node.attrs.arxivId}${node.attrs.title ? ` — ${node.attrs.title}` : ""}]\n`,
  addCommands() {
    return {
      insertPaper:
        (arxivId) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { arxivId } }),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(PaperEmbedView);
  },
});

function PaperEmbedView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { arxivId, title, authors } = node.attrs as { arxivId: string; title: string; authors: string };
  const [paper, setPaper] = useState<PaperMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!arxivId) return;
    let cancelled = false;
    api<{ paper: PaperMeta }>(`/papers/${enc(arxivId)}`)
      .then(({ paper }) => {
        if (cancelled) return;
        setPaper(paper);
        const names = paper.authors.slice(0, 4).join(", ") + (paper.authors.length > 4 ? " et al." : "");
        // Keep the title on the page, so it reads without a fetch (and Lich sees it).
        if (paper.title !== title || names !== authors) queueMicrotask(() => updateAttributes({ title: paper.title, authors: names }));
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [arxivId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NodeViewWrapper className={`paper-embed${selected ? " selected" : ""}`} contentEditable={false}>
      <div className="paper-embed-head">
        <span className="tag">arXiv:{arxivId}</span>
        <button type="button" className="linklike small" onClick={() => deleteNode()} aria-label="Remove paper">
          ×
        </button>
      </div>
      <div className="paper-embed-title">{title || (error ? "Couldn't load this paper" : "Loading…")}</div>
      {authors && <div className="byline">{authors}</div>}
      {error && !title && <div className="error small">{error}</div>}
      {paper && (
        <p className={`abstract${open ? "" : " clamp"}`} onClick={() => setOpen((o) => !o)} title={open ? "Show less" : "Show more"}>
          {paper.abstract}
        </p>
      )}
      <div className="row small">
        <Link href={`/paper/${enc(arxivId)}`}>Open reader</Link>
        <a href={`https://arxiv.org/abs/${arxivId}`} target="_blank" rel="noreferrer">
          arXiv ↗
        </a>
        <span className="muted">Ask Lich about it from this page.</span>
      </div>
    </NodeViewWrapper>
  );
}
