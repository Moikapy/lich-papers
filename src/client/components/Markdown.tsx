import { useMemo } from "react";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { normalizeMarkdown } from "../markdown-normalize";

const katex = () => markedKatex({ throwOnError: false, nonStandard: true });
/** Model output (answers, notes, summaries): single newlines are line breaks, as people expect in chat. */
const chatMd = new Marked({ gfm: true, breaks: true }).use(katex());
/** Paper text extracted from arXiv: standard Markdown paragraphs. */
const docMd = new Marked({ gfm: true, breaks: false }).use(katex());

/** Renders Markdown to sanitized HTML. Exported for tests. */
export function renderMarkdown(text: string, variant: "chat" | "document" = "chat"): string {
  const html = variant === "chat" ? (chatMd.parse(normalizeMarkdown(text), { async: false }) as string) : (docMd.parse(text, { async: false }) as string);
  return DOMPurify.sanitize(html, SANITIZE);
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Untrusted content (paper text, model output, saved notes): no remote images (markdown-image exfiltration)
// and no form controls. Inline style stays because KaTeX output needs it; the page CSP blocks remote CSS loads.
const SANITIZE = {
  FORBID_TAGS: ["form", "input", "button", "textarea", "select", "style", "img", "image", "use", "picture", "source", "video", "audio", "track"],
  FORBID_ATTR: ["action", "formaction"],
};

export function Markdown({ text, className, variant = "chat" }: { text: string; className?: string; variant?: "chat" | "document" }) {
  const html = useMemo(() => renderMarkdown(text, variant), [text, variant]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
