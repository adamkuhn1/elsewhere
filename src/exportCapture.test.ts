import { afterEach, describe, expect, it, vi } from "vitest";
import { isExportDebugEnabled } from "./exportCapture";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isExportDebugEnabled", () => {
  it("is false by default, so the export button never appears for a visitor", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    expect(isExportDebugEnabled()).toBe(false);
  });

  it("is true only for the exact ?debug=1 flag", () => {
    vi.stubGlobal("window", { location: { search: "?debug=1" } });
    expect(isExportDebugEnabled()).toBe(true);
  });

  it("rejects near-miss values instead of loosely truthy-checking them", () => {
    for (const search of ["?debug=true", "?debug=0", "?debug", "?other=1"]) {
      vi.stubGlobal("window", { location: { search } });
      expect(isExportDebugEnabled()).toBe(false);
    }
  });
});
