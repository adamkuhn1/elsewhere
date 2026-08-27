/**
 * Runs `use`, then closes `resource` regardless of whether `use` throws.
 *
 * Pulled out of worker.ts as its own framework-free function so the "the
 * transferred bitmap is always closed, on every path" guarantee is
 * unit-testable directly -- worker.ts itself can't be imported outside a
 * real Worker (`self`, `OffscreenCanvas`) without mocking the entire
 * ONNX/WebGPU environment, which would test a lot more than this one rule.
 */
export async function closeAfter<T>(resource: { close(): void }, use: () => T | Promise<T>): Promise<T> {
  try {
    return await use();
  } finally {
    resource.close();
  }
}
