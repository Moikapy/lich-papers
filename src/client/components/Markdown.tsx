import { useMemo } from "react";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";

const md = new Marked({ gfm: true, breaks: false }).use(markedKatex({ throwOnError: false, nonStandard: true }));

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.parse(text, { async: false }) as string), [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
