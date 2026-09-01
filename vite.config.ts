import { existsSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * The ONNX Runtime WASM binaries the depth model actually loads.
 *
 * onnxruntime-web@1.27.0 ships four WebGPU-capable WASM builds (jsep, jspi,
 * asyncify, plain), selected by dead-code-elimination flags baked in at
 * publish time -- inspected directly in the installed package
 * (node_modules/onnxruntime-web/dist/ort.webgpu.mjs): three of the four
 * branches are literal `false` in this exact release, leaving `asyncify` as
 * the only reachable one. This copies just that one, not all four.
 */
const ORT_ASSETS = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"];

function resolveOrtDist(): string | undefined {
  // "onnxruntime-web/package.json" isn't a subpath the package's own
  // `exports` map allows resolving; its main entry always resolves into
  // dist/, though, so that's used to find the sibling WASM files instead.
  try {
    return dirname(require.resolve("onnxruntime-web"));
  } catch {
    return undefined; // not installed yet (e.g. a fresh clone before `npm install`)
  }
}

function selfHostOrtAssets(): Plugin {
  return {
    name: "self-host-ort-assets",
    // Production: copy into public/ort so Vite's normal public-dir-to-dist
    // copy ships them as plain static files.
    buildStart() {
      const src = resolveOrtDist();
      if (!src) return;
      const dest = join(here, "public/ort");
      mkdirSync(dest, { recursive: true });
      for (const name of ORT_ASSETS) {
        const from = join(src, name);
        if (existsSync(from)) copyFileSync(from, join(dest, name));
      }
    },
    // Dev: served directly from node_modules by a middleware, not from
    // public/ort. Vite's dev server refuses to let source code `import()` a
    // file that lives under public/ ("this file is in /public and will be
    // copied as-is... should not be imported from source code") -- and
    // onnxruntime-web's own WASM loader does exactly that, dynamically
    // importing its `.mjs` glue module rather than only fetching the
    // `.wasm`. A middleware answers the request before Vite's public-dir
    // handling (and its import restriction) ever sees it -- the same
    // approach this project's own archived Elsewhere implementation used
    // for this exact problem (see git history on
    // archive/elsewhere-pre-reset-20260811).
    configureServer(server) {
      const src = resolveOrtDist();
      if (!src) return;
      server.middlewares.use("/ort/", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\/+/, "");
        if (!ORT_ASSETS.includes(name)) return next();
        const path = join(src, name);
        if (!existsSync(path)) return next();
        const bytes = readFileSync(path);
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.setHeader("Content-Length", bytes.length);
        res.end(bytes);
      });
    },
    // onnxruntime-web's own module still references its WASM binary with
    // `new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)`,
    // which Rollup resolves and emits into the production build regardless
    // of the self-hosting above -- a second, ~24 MB copy of a file the
    // runtime never actually fetches from that path (wasmPaths points it at
    // /ort/ instead; see depth/worker.ts). Dropping it here is what keeps
    // the copy in dist/ort/ the only copy.
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.(wasm|mjs|js)$/.test(name)) delete bundle[name];
      }
    },
  };
}

// base: "./" keeps built asset paths relative so this app works both
// standalone and embedded in the portfolio shell via iframe (see the same
// comment in apps/showboat and apps/27b's vite.config.ts).
export default defineConfig({
  plugins: [react(), selfHostOrtAssets()],
  base: "./",
  resolve: {
    // @huggingface/transformers depends on a specific onnxruntime-web
    // version internally; this app also depends on it directly (pinned to
    // the stable release, not that nested pin -- see package.json and
    // Agent B's feasibility spike). Without dedupe, Vite bundles both and
    // WebGPU session creation silently picks whichever copy initialized
    // its environment first, which is exactly the kind of bug that only
    // shows up in production.
    dedupe: ["onnxruntime-web", "onnxruntime-common"],
  },
  worker: {
    format: "es",
  },
});
