import { CustomMediaError } from "./errors";

export function createCallSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup(): void;
  mapAbort(error: unknown): never;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("custom-media timeout"));
  }, timeoutMs);

  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
    mapAbort(error: unknown): never {
      if (timedOut) {
        throw new CustomMediaError("TIMEOUT", `Operation exceeded its ${timeoutMs}ms timeout.`);
      }
      if (parent?.aborted || controller.signal.aborted) {
        throw new CustomMediaError("ABORTED", "Operation was aborted.");
      }
      throw error;
    },
  };
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
