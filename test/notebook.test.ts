import { describe, expect, it } from "vitest";
import { appendOutput, errorText, OUTPUT_LIMITS, type CellOutput } from "../src/client/notebook/outputs";

describe("appendOutput", () => {
  it("merges consecutive writes to the same stream", () => {
    let out: CellOutput[] = [];
    out = appendOutput(out, { type: "stream", name: "stdout", text: "a\n" });
    out = appendOutput(out, { type: "stream", name: "stdout", text: "b\n" });
    out = appendOutput(out, { type: "stream", name: "stderr", text: "warn\n" });
    expect(out).toEqual([
      { type: "stream", name: "stdout", text: "a\nb\n" },
      { type: "stream", name: "stderr", text: "warn\n" },
    ]);
  });
  it("truncates text past the limit and then drops more", () => {
    let out = appendOutput([], { type: "stream", name: "stdout", text: "x".repeat(OUTPUT_LIMITS.textChars + 10) });
    expect(out[0]!.type === "stream" && out[0]!.text.endsWith("[output truncated]\n")).toBe(true);
    out = appendOutput(out, { type: "result", text: "more" });
    expect(out).toHaveLength(1);
  });
  it("keeps a few small images and notes the rest", () => {
    let out: CellOutput[] = [];
    for (let i = 0; i < OUTPUT_LIMITS.images + 1; i++) out = appendOutput(out, { type: "image", mime: "image/png", data: "aGk=" });
    expect(out.filter((o) => o.type === "image")).toHaveLength(OUTPUT_LIMITS.images);
    expect(out.at(-1)).toMatchObject({ type: "stream", name: "stderr" });
    expect(appendOutput([], { type: "image", mime: "image/png", data: "a".repeat(OUTPUT_LIMITS.imageChars + 1) })[0]).toMatchObject({ type: "stream" });
  });
});

describe("errorText", () => {
  it("shows the error once, then the traceback", () => {
    expect(errorText({ type: "error", ename: "ReferenceError", evalue: "x is not defined", traceback: "ReferenceError: x is not defined\n    at <anonymous>:1:1" })).toBe(
      "ReferenceError: x is not defined\n    at <anonymous>:1:1",
    );
    expect(errorText({ type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: "Traceback (most recent call last):\n  File \"<exec>\", line 1\nZeroDivisionError: division by zero" })).toBe(
      'ZeroDivisionError: division by zero\nTraceback (most recent call last):\n  File "<exec>", line 1',
    );
  });
});
