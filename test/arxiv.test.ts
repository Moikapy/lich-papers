import { describe, expect, it } from "vitest";
import { buildSearchQuery, decodeEntities, parseArxivId, parseAtom } from "../src/worker/arxiv";

describe("parseArxivId", () => {
  it.each([
    ["2401.12345", "2401.12345"],
    ["2401.12345v3", "2401.12345"],
    ["arXiv:1706.03762", "1706.03762"],
    ["https://arxiv.org/abs/1706.03762v7", "1706.03762"],
    ["https://arxiv.org/pdf/2401.00001.pdf", "2401.00001"],
    ["http://arxiv.org/abs/hep-th/9901001v1", "hep-th/9901001"],
    ["math.GT/0309136", "math.GT/0309136"],
  ])("%s -> %s", (input, id) => expect(parseArxivId(input)).toBe(id));

  it.each(["attention is all you need", "transformers 2017", "1234", ""])("rejects %j", (input) => expect(parseArxivId(input)).toBeNull());
});

describe("buildSearchQuery", () => {
  it("ANDs free-text terms across all fields", () => {
    expect(buildSearchQuery("diffusion models")).toBe("all:diffusion AND all:models");
  });
  it("keeps quoted phrases", () => {
    expect(buildSearchQuery('"attention is all you need"')).toBe('all:"attention is all you need"');
  });
  it("passes field-prefixed queries through", () => {
    expect(buildSearchQuery("au:hinton AND ti:capsule")).toBe("au:hinton AND ti:capsule");
  });
  it("adds a category filter", () => {
    expect(buildSearchQuery("rlhf", "cs.CL")).toBe("(all:rlhf) AND cat:cs.CL");
    expect(buildSearchQuery("", "cs.AI")).toBe("cat:cs.AI");
  });
});

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1234</opensearch:totalResults>
  <opensearch:startIndex>20</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models...  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Solo</title>
    <summary>One author, one category.</summary>
    <author><name>A. Person</name></author>
    <category term="math.CO"/>
  </entry>
</feed>`;

describe("parseAtom", () => {
  it("parses entries, totals, and single-element arrays", () => {
    const r = parseAtom(ATOM);
    expect(r.total).toBe(1234);
    expect(r.start).toBe(20);
    expect(r.papers).toHaveLength(2);
    expect(r.papers[0]).toMatchObject({
      arxiv_id: "1706.03762",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      abstract: "The dominant sequence transduction models...",
      categories: ["cs.CL", "cs.LG"],
      published: "2017-06-12T17:57:34Z",
    });
    expect(r.papers[1]).toMatchObject({ arxiv_id: "2401.00001", authors: ["A. Person"], categories: ["math.CO"] });
  });

  it("handles an empty feed", () => {
    expect(parseAtom(`<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="x">0</opensearch:totalResults></feed>`).papers).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#955; &#x3bb; &nbsp;")).toBe("a & b <c> λ λ  ");
  });
});

describe("arxiv id and query edge cases", () => {
  it("normalizes case of old-style ids", () => {
    expect(parseArxivId("math.gt/0309136")).toBe("math.GT/0309136");
    expect(parseArxivId("HEP-TH/9901001v2")).toBe("hep-th/9901001");
  });
  it("strips a lone quote from free-text tokens", () => {
    expect(buildSearchQuery('"deep learning')).toBe("all:deep AND all:learning");
  });
});
