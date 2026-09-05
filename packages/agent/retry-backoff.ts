import { setTimeout as sleep } from "node:timers/promises";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureAgentPromise, rethrowAgentPanic, type OpaqueAgentValue } from "./failure-adapters";

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
  next(
    abortSignal?: AbortSignal,
  ): Promise<ResultType<RetryBackoffAttempt | null, RetryBackoffAborted | RetryBackoffDelayFailed>>;
};

export class RetryBackoffAborted extends TaggedError("RetryBackoffAborted")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RetryBackoffDelayFailed extends TaggedError("RetryBackoffDelayFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

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
      if (!retry.enabled || attempts >= Math.max(0, retry.maxRetries)) return Result.ok(null);

      attempts += 1;
      const delayMs = computeRetryBackoffDelayMs({
        attempt: attempts,
        baseDelayMs: retry.baseDelayMs,
        maxDelayMs: retry.maxDelayMs,
      });
      const delayed = await captureAgentPromise(async () => {
        if (delayMs > 0) await sleep(delayMs, undefined, { signal: abortSignal });
        else abortSignal?.throwIfAborted();
      });
      const delaySettlement = delayed.match<
        | { readonly kind: "completed" }
        | { readonly kind: "failed"; readonly error: OpaqueAgentValue }
      >({
        ok: () => ({ kind: "completed" }),
        err: (error) => ({ kind: "failed", error }),
      });
      if (delaySettlement.kind === "failed") {
        attempts -= 1;
        const delayError = delaySettlement.error;
        rethrowAgentPanic(delayError);
        const cause =
          delayError instanceof Error
            ? delayError
            : new Error("Retry backoff failed", { cause: delayError });
        if (!abortSignal?.aborted) {
          return Result.err(
            new RetryBackoffDelayFailed({
              cause,
              message: "Retry backoff delay failed",
            }),
          );
        }
        return Result.err(
          new RetryBackoffAborted({
            cause,
            message: "Retry backoff was aborted",
          }),
        );
      }

      return Result.ok({ attempt: attempts, delayMs });
    },
  };
}
