// Creates .dev.vars for local development with a fresh ENCRYPTION_KEY (never overwrites).
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".dev.vars")) {
  console.log(".dev.vars already exists; leaving it alone.");
} else {
  writeFileSync(
    ".dev.vars",
    [
      `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      "# Optional: a server OpenRouter key so new users can try the free router before connecting their own.",
      "# OPENROUTER_API_KEY=sk-or-...",
      "# Lets provider base URLs use http:// (e.g. a local Ollama at http://localhost:11434).",
      "ALLOW_INSECURE_PROVIDER_URLS=1",
      "",
    ].join("\n"),
  );
  console.log("Wrote .dev.vars");
}
