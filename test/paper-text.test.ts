import { describe, expect, it } from "vitest";
import { chunkText, outline, readRange, readSection, searchChunks } from "../src/worker/paper-text";

const BODY = [
  "Attention Is All You Need",
  "## Abstract",
  "The dominant sequence transduction models are based on recurrent networks.",
  "## 1 Introduction",
  "Recurrent neural networks have been firmly established as state of the art.",
  "## 3 Model Architecture",
  "The Transformer uses stacked self-attention and point-wise fully connected layers.",
  "## 3.2 Attention",
  "Scaled dot-product attention divides by the square root of the key dimension.",
  "## 6 Results",
  "On WMT 2014 English-to-German the big transformer achieves 28.4 BLEU.",
].join("\n\n");

describe("paper text helpers", () => {
  it("extracts the outline", () => {
    expect(outline(BODY)).toEqual(["Abstract", "1 Introduction", "3 Model Architecture", "3.2 Attention", "6 Results"]);
  });

  it("chunks by section and tracks offsets", () => {
    const chunks = chunkText(BODY);
    expect(chunks.map((c) => c.section)).toEqual(["Front matter", "Abstract", "1 Introduction", "3 Model Architecture", "3.2 Attention", "6 Results"]);
    for (const c of chunks) expect(BODY.slice(c.offset)).toContain(c.text.slice(0, 20));
  });

  it("ranks the most relevant chunk first", () => {
    const hits = searchChunks(chunkText(BODY), "how is attention scaled by dimension?");
    expect(hits[0]!.section).toBe("3.2 Attention");
    expect(searchChunks(chunkText(BODY), "BLEU score")[0]!.section).toBe("6 Results");
    expect(searchChunks(chunkText(BODY), "the of and")).toEqual([]);
  });

  it("reads sections and ranges", () => {
    expect(readSection(BODY, "results")).toContain("28.4 BLEU");
    expect(readSection(BODY, "model")).toContain("stacked self-attention");
    expect(readSection(BODY, "model")).not.toContain("Scaled dot-product");
    expect(readSection(BODY, "nonexistent")).toBeNull();
    const r = readRange(BODY, 0, 200);
    expect(r.text).toHaveLength(200);
    expect(r.next).toBe(200);
    expect(readRange(BODY, BODY.length - 10, 500).next).toBeNull();
  });
});
