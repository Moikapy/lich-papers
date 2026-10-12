import { describe, expect, it } from "vitest";
import { HTTPException } from "hono/http-exception";
import { MAX_COLLECTION_NAME, normalizeCollectionName } from "../src/worker/library";

describe("normalizeCollectionName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeCollectionName("  Reinforcement   learning \n")).toBe("Reinforcement learning");
  });

  it("returns null for empty names", () => {
    expect(normalizeCollectionName("   ")).toBeNull();
    expect(normalizeCollectionName(undefined)).toBeNull();
  });

  it("rejects names that are too long", () => {
    expect(() => normalizeCollectionName("x".repeat(MAX_COLLECTION_NAME + 1))).toThrow(HTTPException);
    expect(normalizeCollectionName("x".repeat(MAX_COLLECTION_NAME))).toHaveLength(MAX_COLLECTION_NAME);
  });
});
