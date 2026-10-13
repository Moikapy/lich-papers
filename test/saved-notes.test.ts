import { describe, expect, it } from "vitest";
import { withSavedNotes } from "../src/worker/agent";

const save = (title: string, content: string, ok = true) => ({ name: "save_knowledge", args: { title, content }, ok });

describe("withSavedNotes", () => {
  it("shows a saved note when the model only says it saved it", () => {
    const out = withSavedNotes("I've saved a summary to your notes.", [save("Paper summary", "- point one\n- point two")]);
    expect(out).toContain("I've saved a summary to your notes.");
    expect(out).toContain("**Paper summary**");
    expect(out).toContain("- point one");
  });

  it("leaves a full answer alone", () => {
    const answer = "x".repeat(500);
    expect(withSavedNotes(answer, [save("t", "note body")])).toBe(answer);
  });

  it("doesn't duplicate a note the reply already contains", () => {
    const note = "Scaled dot-product attention divides by the square root of d_k to keep softmax gradients healthy.";
    expect(withSavedNotes(`Saved:\n\n${note}`, [save("t", note)])).toBe(`Saved:\n\n${note}`);
  });

  it("ignores failed saves and other tools", () => {
    expect(withSavedNotes("ok", [save("t", "body", false), { name: "search_paper", args: { query: "x" }, ok: true }])).toBe("ok");
  });
});
