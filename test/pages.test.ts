import { describe, expect, it } from "vitest";
import { isInSubtree, noteToHtml } from "../src/worker/pages";

describe("noteToHtml", () => {
  it("turns $…$ and $$…$$ into the editor's math nodes", () => {
    const html = noteToHtml("Grows like $\\sqrt{d_k}$.\n\n$$a < b$$");
    expect(html).toContain('<span data-type="inline-math" data-latex="\\sqrt{d_k}"></span>');
    expect(html).toContain('<div data-type="block-math" data-latex="a &lt; b"></div>');
  });
  it("leaves prices and code alone", () => {
    const html = noteToHtml("Costs $5 and $10.\n\n```\nx = $3 + $4\n```\n\nInline `$y$` too.");
    expect(html).not.toContain("inline-math");
    expect(html).toContain("$5 and $10");
  });
  it("keeps Markdown structure", () => {
    expect(noteToHtml("# Title\n\n- a\n- b")).toMatch(/<h1>Title<\/h1>[\s\S]*<ul>[\s\S]*<li>a<\/li>/);
  });
});

describe("isInSubtree", () => {
  const pages = [
    { id: "a", parent_id: null },
    { id: "b", parent_id: "a" },
    { id: "c", parent_id: "b" },
    { id: "d", parent_id: null },
  ];
  it("stops a page moving inside itself or its descendants", () => {
    expect(isInSubtree(pages, "a", "a")).toBe(true);
    expect(isInSubtree(pages, "a", "c")).toBe(true);
    expect(isInSubtree(pages, "b", "d")).toBe(false);
    expect(isInSubtree(pages, "c", "a")).toBe(false);
  });
  it("terminates on a corrupt cycle", () => {
    expect(isInSubtree([{ id: "x", parent_id: "y" }, { id: "y", parent_id: "x" }], "z", "x")).toBe(false);
  });
});
