import { Marked } from "marked";

const markdown = new Marked({ gfm: true, breaks: false });

/**
 * Notes are Markdown with $…$ / $$…$$ math; the editor's math nodes read data-latex. Code is left
 * alone, and "$5 and $10" stays text (inline math can't start or end with a space or precede a digit).
 */
export function noteToHtml(md: string): string {
  const html = markdown.parse(md, { async: false }) as string;
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\$\$([^$]+)\$\$/g, (_m, tex: string) => `<div data-type="block-math" data-latex="${escapeAttr(unescapeHtml(tex.trim()))}"></div>`)
            .replace(/\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (_m, tex: string) => `<span data-type="inline-math" data-latex="${escapeAttr(unescapeHtml(tex))}"></span>`),
    )
    .join("");
}

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
