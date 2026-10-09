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

export default defineConfig({
  plugins: [lichWorkersCompat(), react(), cloudflare()],
  environments: {
    // Keep lich out of dev pre-bundling so the transform above also applies under `vite dev`.
    lich_papers: { optimizeDeps: { exclude: ["@moikapy/lich"] } },
  },
});
