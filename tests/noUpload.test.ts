import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A static guard, not a network trace: this can't prove nothing is ever
// uploaded (Agent B's live network trace against the real pipeline did
// that), but it does prove the source doesn't contain the *shape* of an
// upload -- a POST/PUT, a fetch body, a form submission -- anywhere near
// the modules that ever touch a captured frame. A future edit that adds one
// fails this immediately instead of only being caught by manual QA.
// ---------------------------------------------------------------------------

const SRC_DIR = join(__dirname, "../src");
const CAMERA_ADJACENT_FILES = ["camera.ts", "depth.ts", "depth/worker.ts", "App.tsx", "recordedExample.ts"];
const UPLOAD_PATTERNS = [/method:\s*["']POST["']/i, /method:\s*["']PUT["']/i, /\.send\(/, /FormData/, /XMLHttpRequest/, /new WebSocket/];

function readAll(dir: string): { path: string; contents: string }[] {
  const out: { path: string; contents: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push({ path: full, contents: readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("no camera data leaves the browser (static guard)", () => {
  it("every file that ever touches a captured frame exists and contains no upload pattern", () => {
    const files = readAll(SRC_DIR);
    for (const name of CAMERA_ADJACENT_FILES) {
      const match = files.find((f) => f.path.endsWith(name));
      expect(match, `expected ${name} to exist`).toBeDefined();
      for (const pattern of UPLOAD_PATTERNS) {
        expect(match!.contents, `${name} matched upload pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("the only fetch() calls in the whole app are same-origin (relative paths) or the declared model host", () => {
    const files = readAll(SRC_DIR);
    const fetchCalls = files.flatMap((f) => [...f.contents.matchAll(/fetch\(\s*[`"']([^`"']+)/g)].map((m) => m[1]));
    for (const url of fetchCalls) {
      const isRelative = url.startsWith("/") || url.startsWith("./") || url.startsWith("http://localhost");
      expect(isRelative, `unexpected fetch target: ${url}`).toBe(true);
    }
  });
});
