import { describe, expect, it } from "vitest";
import { b64, decryptSecret, encryptSecret, hashPassword, verifyPassword } from "../src/worker/crypto";
import { ftsQuery } from "../src/worker/knowledge";

const KEY = b64(new Uint8Array(32).fill(7));

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong horse", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("round-trips encrypted secrets with a fresh IV each time", async () => {
    const a = await encryptSecret("sk-or-secret", KEY);
    const b = await encryptSecret("sk-or-secret", KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-or");
    expect(await decryptSecret(a, KEY)).toBe("sk-or-secret");
    await expect(decryptSecret(a, b64(new Uint8Array(32).fill(8)))).rejects.toThrow();
  });

  it("rejects a malformed encryption key", async () => {
    await expect(encryptSecret("x", b64(new Uint8Array(16)))).rejects.toThrow(/32-byte/);
  });
});

describe("ftsQuery", () => {
  it("ORs quoted, de-duplicated terms and drops stopwords", () => {
    expect(ftsQuery('What is "attention" in the attention paper?')).toBe('"attention" OR "paper"');
    expect(ftsQuery("the of")).toBeNull();
  });
});
