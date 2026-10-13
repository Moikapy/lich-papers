/**
 * Repairs the Markdown that language models commonly produce so lists render as lists.
 * Pure string → string, so it's unit-tested without a DOM.
 *
 * Fixes:
 * - "•", "◦", "▪", "‣", "·" and "–" bullets become "- ".
 * - A list item right after a paragraph line gets a blank line before it, so lists that
 *   don't start at "1." (e.g. "2." after an interruption) still start a list.
 * - Unindented text right after a list item ends the list instead of joining the item.
 * - Nested items indented too little for CommonMark (e.g. 2 spaces under "1. ") are
 *   re-indented so they nest: each nesting level becomes 4 spaces, which satisfies any
 *   parent marker up to "99. ".
 * - Dollar amounts like "$5 and $10" are escaped so they aren't typeset as math
 *   (math such as "$2^{10}$" or "$3$" is left alone).
 *
 * Fenced code blocks and inline code are left untouched (apart from being shifted with their list item).
 */

const UNICODE_BULLET = /^(\s*)[•◦▪‣·–](\s+)/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const FENCE = /^\s*(```|~~~)/;

// "$" + an amount followed by a space, punctuation, a dash or end of line: a price, not math.
const PRICE = /(^|[^\\$\w])\$(\d[\d,]*(?:\.\d+)?)(?=[\s.,;:!?)\-]|$)/g;

/** Escapes prices outside inline code spans. */
function escapePrices(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(PRICE, "$1\\$$$2")))
    .join("");
}

function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 4 : 1;
  return n;
}

export function normalizeMarkdown(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  // Indentation (as written) of each open list level, outermost first.
  let levels: number[] = [];
  let inFence = false;
  let fenceShift = 0;
  let inList = false;

  for (let raw of lines) {
    if (inFence) {
      out.push(fenceShift > 0 ? " ".repeat(fenceShift) + raw : raw);
      if (FENCE.test(raw)) inFence = false;
      continue;
    }

    raw = escapePrices(raw.replace(UNICODE_BULLET, "$1-$2"));
    const prev = out.length ? out[out.length - 1]! : "";
    const item = raw.match(ITEM);

    if (item) {
      const written = indentWidth(item[1]!);
      // Close levels deeper than this item, then open a new level if it's deeper still.
      while (levels.length && written < levels[levels.length - 1]!) levels.pop();
      if (!levels.length || written > levels[levels.length - 1]!) levels.push(written);
      const depth = levels.length - 1;
      const line = " ".repeat(depth * 4) + raw.slice(item[1]!.length);
      if (!inList && prev.trim() !== "" && !ITEM.test(prev)) out.push("");
      out.push(line);
      inList = true;
      continue;
    }

    if (raw.trim() === "") {
      out.push(raw);
      continue;
    }

    const lead = raw.match(/^\s*/)![0];
    if (inList && lead.length > 0) {
      // Continuation of the current item (paragraph or code fence): indent under its text.
      const target = Math.max(1, levels.length) * 4;
      const shift = target - indentWidth(lead);
      if (FENCE.test(raw)) {
        inFence = true;
        fenceShift = Math.max(0, shift);
      }
      out.push(" ".repeat(target) + raw.trimStart());
      continue;
    }

    if (FENCE.test(raw)) {
      inFence = true;
      fenceShift = 0;
    }
    // Unindented text ends the list. (Markdown would treat a line directly under an item as part of it,
    // but in model output it's almost always a new paragraph, e.g. "Then:" before "3. ...".)
    if (inList) {
      if (prev.trim() !== "") out.push("");
      inList = false;
      levels = [];
    }
    out.push(raw);
  }
  return out.join("\n");
}
