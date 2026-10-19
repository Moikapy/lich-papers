// Plain variables live in the Cloudflare dashboard. The Vite plugin still writes an empty "vars" block into the
// deploy config it generates, which Workers Builds reads as a mismatch with the dashboard, so drop it.
import { readFileSync, writeFileSync } from "node:fs";

const { configPath } = JSON.parse(readFileSync(".wrangler/deploy/config.json", "utf8"));
const path = new URL(configPath, new URL(".wrangler/deploy/", `file://${process.cwd()}/`));
const config = JSON.parse(readFileSync(path, "utf8"));
if ("vars" in config) {
  delete config.vars;
  writeFileSync(path, JSON.stringify(config));
  console.log(`Removed vars from ${configPath}`);
}
