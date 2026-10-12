import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { readFileSync } from "node:fs";

// @moikapy/lich computes LICH_VERSION by reading its package.json from disk via
// import.meta.url at module load. Workers have no package on disk, so inline it.
function lichWorkersCompat(): Plugin {
  const version = JSON.parse(
    readFileSync(new URL("./node_modules/@moikapy/lich/package.json", import.meta.url), "utf8"),
  ).version as string;
  return {
    name: "lich-workers-compat",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@moikapy/lich/dist") || !code.includes("read_package_version()")) return;
      return code.replace(/var LICH_VERSION = read_package_version\(\);/, `var LICH_VERSION = ${JSON.stringify(version)};`);
    },
  };
}

// Production CSP (meta tag, so it also covers the static assets). Skipped under `vite dev`, which needs inline scripts.
// style-src allows inline styles for KaTeX.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function cspMeta(): Plugin {
  return {
    name: "csp-meta",
    transformIndexHtml: {
      order: "post",
      handler: (html, ctx) => (ctx.server ? html : html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)),
    },
  };
}

export default defineConfig({
  plugins: [lichWorkersCompat(), react(), cloudflare(), cspMeta()],
  environments: {
    // Keep lich out of dev pre-bundling so the transform above also applies under `vite dev`.
    lich_papers: { optimizeDeps: { exclude: ["@moikapy/lich"] } },
  },
});
