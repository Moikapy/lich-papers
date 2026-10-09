/** Pure helpers the paper tools use to navigate extracted full text. */

export interface Chunk {
  index: number;
  offset: number;
  section: string;
  text: string;
}

const CHUNK_CHARS = 1500;

export function chunkText(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  let section = "Front matter";
  let buf = "";
  let bufOffset = 0;
  let offset = 0;
  const flush = () => {
    if (buf.trim()) chunks.push({ index: chunks.length, offset: bufOffset, section, text: buf.trim() });
    buf = "";
  };
  for (const para of body.split(/\n{2,}/)) {
    const heading = para.match(/^## (.+)/);
    if (heading) {
      flush();
      section = heading[1]!.trim().slice(0, 120);
    }
    if (!buf) bufOffset = offset;
    buf += (buf ? "\n\n" : "") + para;
    if (buf.length >= CHUNK_CHARS) flush();
    offset += para.length + 2;
  }
  flush();
  return chunks;
}

export function outline(body: string): string[] {
  return [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim()).filter((h) => h.length > 0 && h.length < 160);
}

const STOP = new Set("a an and are as at be by for from has have in is it of on or that the this to was were which with what how why does do".split(" "));

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9\-]*/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/** BM25 over chunks. Good enough for "find where the paper talks about X". */
export function searchChunks(chunks: Chunk[], query: string, limit = 4): Chunk[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || chunks.length === 0) return [];
  const docs = chunks.map((c) => tokenize(`${c.section} ${c.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.includes(t)).length);
  const k1 = 1.4;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = d.filter((w) => w === t).length;
      if (!tf) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg)));
    }
    return { chunk: chunks[i]!, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.chunk);
}

export function readRange(body: string, offset: number, length: number): { text: string; next: number | null } {
  const start = Math.max(0, Math.min(offset, body.length));
  const end = Math.min(body.length, start + Math.max(200, Math.min(length, 12_000)));
  return { text: body.slice(start, end), next: end < body.length ? end : null };
}

/** Returns the body of the first section whose heading contains `name`. */
export function readSection(body: string, name: string, maxChars = 12_000): string | null {
  const needle = name.toLowerCase();
  const headings = [...body.matchAll(/^## (.+)$/gm)];
  const idx = headings.findIndex((h) => h[1]!.toLowerCase().includes(needle));
  if (idx < 0) return null;
  const start = headings[idx]!.index!;
  const end = headings[idx + 1]?.index ?? body.length;
  return body.slice(start, Math.min(end, start + maxChars));
}
