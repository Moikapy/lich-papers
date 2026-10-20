import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  // Only the code-cell sandbox (/sandbox.html), which runs in an opaque-origin iframe.
  "frame-src 'self'",
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

/** Pyodide's core files, served at /pyodide/ for the code-cell sandbox (see src/sandbox/sandbox.html). */
const PYODIDE_FILES = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PYODIDE_DIR = new URL("./node_modules/pyodide/", import.meta.url);
const MIME: Record<string, string> = { js: "text/javascript", wasm: "application/wasm", zip: "application/zip", json: "application/json" };

/**
 * The code-cell sandbox page and the Pyodide runtime it loads. The sandbox runs in an opaque-origin iframe, so
 * /pyodide/ needs CORS. Dev serves both from source; the client build writes them to the output, plus a _headers
 * file for the CORS header in production.
 */
function codeSandbox(): Plugin {
  const pyodideVersion = JSON.parse(readFileSync(new URL("package.json", PYODIDE_DIR), "utf8")).version as string;
  const sandboxHtml = () => readFileSync(new URL("./src/sandbox/sandbox.html", import.meta.url), "utf8").replaceAll("__PYODIDE_VERSION__", pyodideVersion);
  return {
    name: "code-sandbox",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!;
        if (path === "/sandbox.html") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end(sandboxHtml());
        }
        const file = path.startsWith("/pyodide/") ? path.slice("/pyodide/".length) : null;
        if (file && PYODIDE_FILES.includes(file)) {
          res.setHeader("content-type", MIME[file.split(".").pop()!] ?? "application/octet-stream");
          res.setHeader("access-control-allow-origin", "*");
          return res.end(readFileSync(new URL(file, PYODIDE_DIR)));
        }
        next();
      });
    },
    writeBundle(options) {
      if (this.environment.name !== "client" || !options.dir) return;
      writeFileSync(join(options.dir, "sandbox.html"), sandboxHtml());
      mkdirSync(join(options.dir, "pyodide"), { recursive: true });
      for (const f of PYODIDE_FILES) copyFileSync(new URL(f, PYODIDE_DIR), join(options.dir, "pyodide", f));
      writeFileSync(join(options.dir, "_headers"), "/pyodide/*\n  Access-Control-Allow-Origin: *\n  Cross-Origin-Resource-Policy: cross-origin\n");
    },
  };
}

export default defineConfig({
  // The AI binding (Clef, the chat fallback) is always remote, which needs a Cloudflare login. Local dev runs without it
  // (those features fail open) unless REMOTE_BINDINGS=1 and you're logged in with `wrangler login`.
  plugins: [lichWorkersCompat(), react(), cloudflare({ remoteBindings: process.env.REMOTE_BINDINGS === "1" }), cspMeta(), codeSandbox()],
  environments: {
    // Keep lich out of dev pre-bundling so the transform above also applies under `vite dev`.
    lich_papers: { optimizeDeps: { exclude: ["@moikapy/lich"] } },
  },
});
