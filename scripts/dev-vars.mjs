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
      "# Plain variables (production sets these in the Cloudflare dashboard).",
      "APP_NAME=Lich Papers",
      "DEFAULT_MODEL=openrouter/free",
      "PRO_PRICE_CENTS=1000",
      "PRO_MONTHLY_CAP_USD=4",
      "PRO_DEFAULT_MODEL=google/gemini-2.5-flash",
      "FREE_TRIAL_MESSAGES=10",
      "# Optional: the shared decision model on Workers AI (needs `wrangler login`; billed to your account).",
      "# DECISION_BACKEND=workers-ai",
      "# DECISION_MODEL=clef-flash",
      "# Optional: a server OpenRouter key so new users can try the free router before connecting their own.",
      "# OPENROUTER_API_KEY=sk-or-...",
      "# Lets provider base URLs use http:// (e.g. a local Ollama at http://localhost:11434).",
      "ALLOW_INSECURE_PROVIDER_URLS=1",
      "",
    ].join("\n"),
  );
  console.log("Wrote .dev.vars");
}
