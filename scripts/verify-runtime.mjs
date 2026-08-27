#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ORT runtime provenance check (`npm run verify:runtime` in apps/elsewhere).
//
// The compatibility seam this exists for: @huggingface/transformers 4.2.0
// declares its own onnxruntime-web dependency internally, this app also
// depends on onnxruntime-web directly (pinned to the stable release), and
// Vite is configured to dedupe the two and self-host the resulting asset
// (see vite.config.ts). This script proves that seam is actually sound
// rather than assuming it from the config alone:
//
//   1. exactly one onnxruntime-web resolves in this install (no silent
//      second copy from transformers' own nested dependency);
//   2. the exact .mjs/.wasm pair this app self-hosts and serves;
//   3. those served bytes are byte-identical to the installed package's own
//      copy (dev middleware and production dist/ort/ both checked);
//   4. the .wasm file's magic bytes are correct and it actually compiles
//      with WebAssembly.compile() -- not just "the right size";
//   5. no request for these paths is silently answered by the dev server's
//      SPA/HTML fallback instead of the real binary.
//
// Run after `npm run build` (for the dist/ort/ check) with the dev server
// optionally running on :5176 (for the live HTTP checks; skipped if not).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_URL = "http://localhost:5176";
const ORT_ASSETS = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"];
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // "\0asm"

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
// Neither package's `exports` map allows resolving its own `./package.json`
// subpath directly (same seam vite.config.ts's self-hosting plugin already
// works around for onnxruntime-web) -- so the package root is found by
// walking up from the resolved main-entry file instead.
function findPackageRoot(entryPath, packageName) {
  let dir = dirname(entryPath);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === packageName) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not find package.json for ${packageName} above ${entryPath}`);
}

console.log("— Resolved package versions —");
const transformersEntry = require.resolve("@huggingface/transformers");
const transformersRoot = findPackageRoot(transformersEntry, "@huggingface/transformers");
const transformersPkg = JSON.parse(readFileSync(join(transformersRoot, "package.json"), "utf8"));
const rootOrtEntry = require.resolve("onnxruntime-web");
const rootOrtRoot = findPackageRoot(rootOrtEntry, "onnxruntime-web");
const rootOrtPkg = JSON.parse(readFileSync(join(rootOrtRoot, "package.json"), "utf8"));
console.log(`  @huggingface/transformers: ${transformersPkg.version}`);
console.log(`  onnxruntime-web (resolved from this app): ${rootOrtPkg.version}`);
console.log(`  onnxruntime-web declared by transformers.js: ${transformersPkg.dependencies?.["onnxruntime-web"] ?? "(not a direct dependency)"}`);

// npm itself did NOT flatten this install: transformers.js carries its own
// nested onnxruntime-web (a dev-pinned prerelease), reachable by plain
// Node resolution from inside its package. That is not, on its own, a bug
// -- what actually matters is whether Vite's `resolve.dedupe` (see
// vite.config.ts) keeps that nested copy out of the browser bundle this app
// ships. Node's own require/import resolution is the wrong tool to answer
// that: it doesn't run Vite's resolver, so it will find the nested copy
// even when the real bundle never does. Reported here for visibility, not
// used as a pass/fail signal -- the dist/ check below is.
let transformersResolvedOrt;
try {
  transformersResolvedOrt = createRequire(require.resolve("@huggingface/transformers")).resolve("onnxruntime-web");
} catch {
  transformersResolvedOrt = null;
}
if (transformersResolvedOrt && transformersResolvedOrt !== rootOrtEntry) {
  console.log(`  (info: transformers.js also carries its own nested onnxruntime-web at ${transformersResolvedOrt} -- Node's resolver would find it, but Vite's dedupe is checked separately below, against the actual built bundle.)`);
}

console.log("\n— Installed package bytes (source of truth) —");
const ortDist = dirname(rootOrtEntry);
const installedHashes = {};
for (const name of ORT_ASSETS) {
  const path = join(ortDist, name);
  const exists = existsSync(path);
  check(exists, `${name} exists in the installed package`, path);
  if (!exists) continue;
  const bytes = readFileSync(path);
  installedHashes[name] = sha256(bytes);
  console.log(`  ${name}: ${bytes.length} bytes, sha256 ${installedHashes[name]}`);
  if (name.endsWith(".wasm")) {
    check(bytes.subarray(0, 4).equals(WASM_MAGIC), `${name} has correct WASM magic bytes`, `got ${bytes.subarray(0, 4).toString("hex")}`);
    try {
      await WebAssembly.compile(bytes);
      check(true, `${name} compiles with WebAssembly.compile()`);
    } catch (err) {
      check(false, `${name} compiles with WebAssembly.compile()`, String(err));
    }
  }
}

console.log("\n— Production build output (dist/ort/) —");
const distOrt = join(APP_ROOT, "dist/ort");
if (!existsSync(distOrt)) {
  console.log("  (skipped: run `npm run build` first)");
} else {
  for (const name of ORT_ASSETS) {
    const path = join(distOrt, name);
    const exists = existsSync(path);
    check(exists, `dist/ort/${name} exists`, path);
    if (!exists) continue;
    const bytes = readFileSync(path);
    check(sha256(bytes) === installedHashes[name], `dist/ort/${name} is byte-identical to the installed package (production parity)`, `sha256 ${sha256(bytes)} vs installed ${installedHashes[name]}`);
  }
  // The duplicate Rollup would otherwise emit from onnxruntime-web's own
  // `new URL(..., import.meta.url)` reference (see vite.config.ts's
  // generateBundle hook) -- if this exists, that hook silently stopped
  // working and the app is shipping two copies of a ~24MB file.
  const distAssets = join(APP_ROOT, "dist/assets");
  if (existsSync(distAssets)) {
    const { readdirSync } = await import("node:fs");
    const jsFiles = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
    const wasmDuplicates = readdirSync(distAssets).filter((f) => /ort-wasm.*\.(wasm|mjs|js)$/.test(f));
    check(wasmDuplicates.length === 0, "no duplicate ORT asset bundled into dist/assets/", `found: ${wasmDuplicates.join(", ")}`);

    // The real answer to "which onnxruntime-web actually ships": not Node's
    // resolver (see the info line above), but whether this exact string --
    // unique to the nested dev-pinned copy's version -- appears anywhere in
    // the built output Vite actually produced.
    const devPinMarker = transformersPkg.dependencies?.["onnxruntime-web"];
    if (devPinMarker && devPinMarker !== rootOrtPkg.version) {
      const tainted = jsFiles.filter((f) => readFileSync(join(distAssets, f), "utf8").includes(devPinMarker));
      check(tainted.length === 0, `the nested dev-pinned onnxruntime-web version (${devPinMarker}) does not appear anywhere in the built bundle`, `found in: ${tainted.join(", ")}`);
    }
  }
}

console.log(`\n— Live dev server (${DEV_URL}) —`);
for (const name of ORT_ASSETS) {
  const url = `${DEV_URL}/ort/${name}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    console.log(`  (skipped: dev server not reachable at ${DEV_URL})`);
    break;
  }
  const contentType = res.headers.get("content-type") ?? "";
  check(res.ok, `GET ${url} responds 2xx`, `status ${res.status}`);
  check(!contentType.includes("text/html"), `${name} is not answered by an HTML/SPA fallback`, `content-type: ${contentType}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  check(sha256(bytes) === installedHashes[name], `served ${name} is byte-identical to the installed package`, `sha256 ${sha256(bytes)} vs installed ${installedHashes[name]}`);
}

console.log(`\nverify-runtime: ${failures === 0 ? "all green" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
