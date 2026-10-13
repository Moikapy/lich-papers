import { describe, expect, it } from "vitest";
import { isOllamaCloud, ollamaModelName } from "../src/worker/providers";

describe("isOllamaCloud", () => {
  it("treats ollama.com (and no base URL) as the cloud", () => {
    expect(isOllamaCloud(null)).toBe(true);
    expect(isOllamaCloud("https://ollama.com")).toBe(true);
    expect(isOllamaCloud("https://api.ollama.com/")).toBe(true);
  });
  it("treats any other host as self-hosted", () => {
    expect(isOllamaCloud("https://my-ollama.example.com")).toBe(false);
    expect(isOllamaCloud("https://notollama.com")).toBe(false);
    expect(isOllamaCloud("not a url")).toBe(false);
  });
});

describe("ollamaModelName", () => {
  it("drops the -cloud suffix for the cloud API", () => {
    expect(ollamaModelName("gpt-oss:120b-cloud", "https://ollama.com")).toBe("gpt-oss:120b");
    expect(ollamaModelName(" qwen3-coder:480b-cloud ", null)).toBe("qwen3-coder:480b");
    expect(ollamaModelName("gpt-oss:120b", "https://ollama.com")).toBe("gpt-oss:120b");
  });
  it("leaves names alone for self-hosted servers", () => {
    expect(ollamaModelName("gpt-oss:120b-cloud", "https://my-ollama.example.com")).toBe("gpt-oss:120b-cloud");
  });
});
