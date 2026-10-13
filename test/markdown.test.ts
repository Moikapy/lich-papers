import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import { normalizeMarkdown } from "../src/client/markdown-normalize";

// Same pipeline as the chat variant of <Markdown> (minus DOMPurify, which needs a DOM).
const md = new Marked({ gfm: true, breaks: true }).use(markedKatex({ throwOnError: false, nonStandard: true }));
const render = (s: string) => md.parse(normalizeMarkdown(s), { async: false }) as string;
const squash = (html: string) => html.replace(/\s+/g, "");

describe("list rendering for model output", () => {
  it("turns unicode bullets into a list", () => {
    expect(squash(render("Key points:\n• first\n• second"))).toBe("<p>Keypoints:</p><ul><li>first</li><li>second</li></ul>");
  });

  it("starts a numbered list that doesn't begin at 1 after a sentence", () => {
    expect(squash(render("Then:\n2. second\n3. third"))).toBe('<p>Then:</p><olstart="2"><li>second</li><li>third</li></ol>');
  });

  it("nests bullets indented 2 spaces under a numbered item", () => {
    expect(squash(render("1. Outer\n  - inner a\n  - inner b\n2. Next"))).toBe(
      "<ol><li>Outer<ul><li>innera</li><li>innerb</li></ul></li><li>Next</li></ol>",
    );
  });

  it("nests three levels written with 2-space steps", () => {
    const html = squash(render("- a\n  - b\n    - c\n- d"));
    expect(html).toBe("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>");
  });

  it("keeps well-formed lists unchanged", () => {
    expect(squash(render("Steps:\n1. first\n2. second"))).toBe("<p>Steps:</p><ol><li>first</li><li>second</li></ol>");
    expect(squash(render("1) one\n2) two"))).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("keeps a continuation paragraph and code block inside the item", () => {
    const html = squash(render("1. Run this:\n\n  ```\n  x = 1\n  ```\n2. Then this"));
    expect(html).toContain("<ol><li><p>Runthis:</p><pre><code>x=1");
    expect(html).toContain("<li><p>Thenthis</p></li></ol>");
  });

  it("ends the list at unindented text and resumes numbering after it", () => {
    expect(squash(render("1. one\n2. two\nThen:\n3. three"))).toBe('<ol><li>one</li><li>two</li></ol><p>Then:</p><olstart="3"><li>three</li></ol>');
  });

  it("treats single newlines as line breaks", () => {
    expect(squash(render("Line one\nLine two"))).toBe("<p>Lineone<br>Linetwo</p>");
  });

  it("doesn't touch horizontal rules, bold numbering or code", () => {
    expect(render("---")).toContain("<hr>");
    expect(normalizeMarkdown("**1. Title**\nText")).toBe("**1. Title**\nText");
    expect(normalizeMarkdown("```\n• not a bullet\n  - nor this\n```")).toBe("```\n• not a bullet\n  - nor this\n```");
  });
});

describe("dollar signs", () => {
  it("doesn't typeset prices as math", () => {
    const html = render("It costs $5 and $10 per month, or $1,000.50 a year.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 and $10");
  });
  it("still renders real math", () => {
    expect(render("scaled by $\\sqrt{d_k}$")).toContain("katex");
    expect(render("($x$) and $2^{10}$ and $3$")).toContain("katex");
    expect(render("$$x = 1$$")).toContain("katex-display");
  });
  it("leaves dollars inside inline code alone", () => {
    expect(normalizeMarkdown("run `echo $5 and $10`")).toBe("run `echo $5 and $10`");
  });
});
