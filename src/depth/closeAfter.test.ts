import { describe, expect, it, vi } from "vitest";
import { closeAfter } from "./closeAfter";

describe("closeAfter", () => {
  it("closes the resource after a successful use and returns its result", async () => {
    const close = vi.fn();
    const result = await closeAfter({ close }, () => 42);
    expect(result).toBe(42);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the resource even when use() throws, and still propagates the error", async () => {
    const close = vi.fn();
    await expect(
      closeAfter({ close }, () => {
        throw new Error("draw failed");
      }),
    ).rejects.toThrow("draw failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the resource even when use() returns a rejected promise", async () => {
    const close = vi.fn();
    await expect(closeAfter({ close }, async () => Promise.reject(new Error("async failure")))).rejects.toThrow(
      "async failure",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes exactly once, not once per await", async () => {
    const close = vi.fn();
    await closeAfter({ close }, async () => "ok");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
