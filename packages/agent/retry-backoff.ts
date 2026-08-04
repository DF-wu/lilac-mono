import { setTimeout as sleep } from "node:timers/promises";

export type RetryBackoffConfig = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RetryBackoffAttempt = {
  readonly attempt: number;
  readonly delayMs: number;
};

export type RetryBackoffBudget = {
  readonly attempts: number;
  next(abortSignal?: AbortSignal): Promise<RetryBackoffAttempt | null>;
};

export function computeRetryBackoffDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): number {
  const baseDelayMs = Math.max(0, params.baseDelayMs);
  const maxDelayMs = Math.max(0, params.maxDelayMs);
  const exponential = baseDelayMs * 2 ** Math.max(0, params.attempt - 1);
  return Math.min(maxDelayMs, exponential);
}

/** A run-scoped retry budget. Attempts persist until this object is discarded. */
export function createRetryBackoffBudget(retry: RetryBackoffConfig): RetryBackoffBudget {
  let attempts = 0;

  return {
    get attempts() {
      return attempts;
    },
    async next(abortSignal) {
      if (!retry.enabled || attempts >= Math.max(0, retry.maxRetries)) return null;

      attempts += 1;
      const delayMs = computeRetryBackoffDelayMs({
        attempt: attempts,
        baseDelayMs: retry.baseDelayMs,
        maxDelayMs: retry.maxDelayMs,
      });
      try {
        if (delayMs > 0) await sleep(delayMs, undefined, { signal: abortSignal });
        else abortSignal?.throwIfAborted();
      } catch (error) {
        attempts -= 1;
        throw error;
      }

      return { attempt: attempts, delayMs };
    },
  };
}
