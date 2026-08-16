import { describe, expect, it } from "bun:test";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;

type ParseFailure = {
  readonly _tag: "ParseFailure";
  readonly input: string;
};

type PositiveFailure = {
  readonly _tag: "PositiveFailure";
  readonly value: number;
};

type ReadFailure = {
  readonly _tag: "ReadFailure";
};

type SyncCaptureFailure = {
  readonly _tag: "SyncCaptureFailure";
  readonly cause: unknown;
};

type AsyncCaptureFailure = {
  readonly _tag: "AsyncCaptureFailure";
  readonly cause: unknown;
};

type CallbackFailureA = {
  readonly _tag: "CallbackFailureA";
};

type CallbackFailureB = {
  readonly _tag: "CallbackFailureB";
};

class MissingValue extends TaggedError("MissingValue")<{
  key: string;
  message: string;
}> {}

class InvalidValue extends TaggedError("InvalidValue")<{
  input: string;
  message: string;
}> {}

class RetryFailure extends TaggedError("RetryFailure")<{
  attempt: number;
  cause: unknown;
  message: string;
}> {}

class OperationCancelled extends TaggedError("OperationCancelled")<{
  reason: unknown;
  message: string;
}> {}

class ExternalOperationFailure extends TaggedError("ExternalOperationFailure")<{
  cause: unknown;
  message: string;
}> {}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function preserveValueFailureUnion(
  failure: MissingValue | InvalidValue,
): MissingValue | InvalidValue {
  return failure;
}

function throwCleanupFailure(cause: unknown): never {
  throw cause;
}

function parseNumber(input: string): ResultType<number, ParseFailure> {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return Result.err({ _tag: "ParseFailure", input });
  }
  return Result.ok(value);
}

function requirePositive(value: number): ResultType<number, PositiveFailure> {
  if (value <= 0) {
    return Result.err({ _tag: "PositiveFailure", value });
  }
  return Result.ok(value);
}

async function readNumber(): Promise<ResultType<string, ReadFailure>> {
  return Result.ok("21");
}

function mapSyncCaptureFailure(cause: unknown): SyncCaptureFailure {
  return { _tag: "SyncCaptureFailure", cause };
}

function mapAsyncCaptureFailure(cause: unknown): AsyncCaptureFailure {
  return { _tag: "AsyncCaptureFailure", cause };
}

function widenedError<E>(error: E): ResultType<never, E> {
  return Result.err(error);
}

function callbackFailure(value: number) {
  return value > 0
    ? widenedError<CallbackFailureA>({ _tag: "CallbackFailureA" })
    : widenedError<CallbackFailureB>({ _tag: "CallbackFailureB" });
}

function superviseDefect(operation: () => void, observe: (defect: Panic) => void): void {
  try {
    operation();
  } catch (error) {
    if (Panic.is(error)) {
      observe(error);
    }
    throw error;
  }
}

type CancellationAwareRetryContext = {
  readonly attempt: number;
  readonly signal: AbortSignal;
};

type CancellationAwareDelayContext<E> = CancellationAwareRetryContext & {
  readonly error: E;
};

function cancelled<T>(signal: AbortSignal): ResultType<T, OperationCancelled> {
  return Result.err(
    new OperationCancelled({ reason: signal.reason, message: "operation cancelled" }),
  );
}

async function runCancellationAwareRetry<T, E>(options: {
  readonly signal: AbortSignal;
  readonly retries: number;
  readonly attempt: (context: CancellationAwareRetryContext) => Promise<T>;
  readonly mapRejected: (cause: unknown, context: CancellationAwareRetryContext) => E;
  readonly delay: (context: CancellationAwareDelayContext<E>) => Promise<void>;
}): Promise<ResultType<T, E | OperationCancelled>> {
  let attempt = 1;

  while (true) {
    if (options.signal.aborted) return cancelled(options.signal);

    const context = { attempt, signal: options.signal } satisfies CancellationAwareRetryContext;
    const attempted = await Result.tryPromise({
      try: () => options.attempt(context),
      catch: (cause) => options.mapRejected(cause, context),
    });

    if (options.signal.aborted) return cancelled(options.signal);
    if (attempted.status === "ok") return attempted;
    if (attempt > options.retries) return attempted;

    if (options.signal.aborted) return cancelled(options.signal);

    const delayed = await Result.tryPromise({
      try: () => options.delay({ ...context, error: attempted.error }),
      catch: (cause) => options.mapRejected(cause, context),
    });

    if (options.signal.aborted) return cancelled(options.signal);
    if (delayed.status === "error") return Result.err(delayed.error);

    attempt += 1;
  }
}

describe("better-result compatibility preflight", () => {
  it("loads through Bun ESM and preserves generator inference", async () => {
    const resultModule = await import("better-result");
    expect(resultModule.Result).toBe(Result);

    const syncResult = Result.gen(function* () {
      const parsed = yield* parseNumber("21");
      const positive = yield* requirePositive(parsed);
      return Result.ok(positive * 2);
    });
    type SyncInference = Expect<
      Equal<typeof syncResult, ResultType<number, ParseFailure | PositiveFailure>>
    >;
    const syncInference: SyncInference = true;

    expect(syncInference).toBe(true);
    expect(syncResult).toEqual(Result.ok(42));

    const asyncResult = await Result.gen(async function* () {
      const input = yield* Result.await(readNumber());
      const parsed = yield* Result.await(Promise.resolve(parseNumber(input)));
      return Result.ok(parsed * 2);
    });
    type AsyncInference = Expect<
      Equal<typeof asyncResult, ResultType<number, ReadFailure | ParseFailure>>
    >;
    const asyncInference: AsyncInference = true;

    expect(asyncInference).toBe(true);
    expect(asyncResult).toEqual(Result.ok(42));
  });

  it("preserves widened callback Result lanes across composition", async () => {
    const chainable = (): ResultType<number, ReadFailure> => Result.ok(1);
    const chained = chainable().andThen(callbackFailure);
    const chainedAsync = chainable().andThenAsync(async (value) => callbackFailure(value));

    type ChainedInference = Expect<
      Equal<typeof chained, ResultType<never, ReadFailure | CallbackFailureA | CallbackFailureB>>
    >;
    type ChainedAsyncInference = Expect<
      Equal<
        typeof chainedAsync,
        Promise<ResultType<never, ReadFailure | CallbackFailureA | CallbackFailureB>>
      >
    >;
    const chainedInference: ChainedInference = true;
    const chainedAsyncInference: ChainedAsyncInference = true;

    expect(chainedInference).toBe(true);
    expect(chainedAsyncInference).toBe(true);
    expect(chained).toEqual(Result.err({ _tag: "CallbackFailureA" }));
    expect(await chainedAsync).toEqual(Result.err({ _tag: "CallbackFailureA" }));
  });

  it("narrows TaggedError instances with generic, class, and discriminant guards", () => {
    const candidate: unknown = new MissingValue({ key: "port", message: "port is missing" });

    expect(TaggedError.is(candidate)).toBe(true);
    if (!TaggedError.is(candidate)) throw new Error("expected a tagged error");
    expect(candidate._tag).toBe("MissingValue");

    if (!MissingValue.is(candidate)) throw new Error("expected MissingValue");
    type ClassGuardNarrowing = Expect<Equal<typeof candidate, MissingValue>>;
    const classGuardNarrowing: ClassGuardNarrowing = true;

    const failure = preserveValueFailureUnion(candidate);
    if (failure._tag === "MissingValue") {
      type DiscriminantNarrowing = Expect<Equal<typeof failure, MissingValue>>;
      const discriminantNarrowing: DiscriminantNarrowing = true;

      expect(discriminantNarrowing).toBe(true);
      expect(failure.key).toBe("port");
    }
    expect(classGuardNarrowing).toBe(true);
  });

  it("runs synchronous and asynchronous generator cleanup on short circuit", async () => {
    const syncFailure = new MissingValue({ key: "host", message: "host is missing" });
    const syncCleanup: string[] = [];
    const syncResult = Result.gen(function* () {
      try {
        yield* syncFailure;
        return Result.ok("unreachable");
      } finally {
        syncCleanup.push("cleaned");
      }
    });

    expect(syncResult).toEqual(Result.err(syncFailure));
    expect(syncCleanup).toEqual(["cleaned"]);

    const asyncFailure = new InvalidValue({ input: "none", message: "value is invalid" });
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const asyncCleanup: string[] = [];
    const asyncResultPromise = Result.gen(async function* () {
      try {
        yield* Result.await(Promise.resolve(Result.err(asyncFailure)));
        return Result.ok("unreachable");
      } finally {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        asyncCleanup.push("cleaned");
      }
    });

    await cleanupStarted.promise;
    releaseCleanup.resolve();
    const asyncResult = await asyncResultPromise;

    expect(asyncResult).toEqual(Result.err(asyncFailure));
    expect(asyncCleanup).toEqual(["cleaned"]);
  });

  it("turns throwing generator cleanup into a Panic that preserves the cause", () => {
    const failure = new MissingValue({ key: "host", message: "host is missing" });
    const cause = new Error("cleanup invariant failed");
    const observed: Panic[] = [];

    expect(() =>
      superviseDefect(
        () => {
          Result.gen(function* () {
            try {
              yield* failure;
              return Result.ok("unreachable");
            } finally {
              throwCleanupFailure(cause);
            }
          });
        },
        (defect) => observed.push(defect),
      ),
    ).toThrow(Panic);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.message).toBe("generator cleanup threw");
    expect(observed[0]?.cause).toBe(cause);
  });

  it("captures synchronous throws and promise rejections with explicit mappings", async () => {
    const syncCause = new Error("sync boundary failed");
    const syncResult = Result.try({
      try: () => {
        throw syncCause;
      },
      catch: mapSyncCaptureFailure,
    });
    type SyncCaptureInference = Expect<
      Equal<typeof syncResult, ResultType<never, SyncCaptureFailure>>
    >;
    const syncCaptureInference: SyncCaptureInference = true;

    expect(syncCaptureInference).toBe(true);
    expect(syncResult).toEqual(Result.err({ _tag: "SyncCaptureFailure", cause: syncCause }));

    const asyncCause = new Error("async boundary failed");
    const asyncResult = await Result.tryPromise({
      try: async (): Promise<number> => {
        throw asyncCause;
      },
      catch: mapAsyncCaptureFailure,
    });
    type AsyncCaptureInference = Expect<
      Equal<typeof asyncResult, ResultType<number, AsyncCaptureFailure>>
    >;
    const asyncCaptureInference: AsyncCaptureInference = true;

    expect(asyncCaptureInference).toBe(true);
    expect(asyncResult).toEqual(Result.err({ _tag: "AsyncCaptureFailure", cause: asyncCause }));
  });

  it("lets a defect supervisor observe and propagate Panic without logging", () => {
    const cause = new Error("broken callback invariant");
    const observed: Panic[] = [];

    expect(() =>
      superviseDefect(
        () => {
          Result.ok(1).map(() => {
            throw cause;
          });
        },
        (defect) => observed.push(defect),
      ),
    ).toThrow(Panic);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.cause).toBe(cause);
  });

  it("aborts a built-in retry delay and returns the latest typed failure", async () => {
    const controller = new AbortController();
    const retryDelayStarted = deferred<{
      error: RetryFailure;
      signal: AbortSignal | undefined;
      attempt: number;
    }>();
    const abortObserved = deferred<void>();
    let attempts = 0;
    controller.signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });

    const resultPromise = Result.tryPromise(
      {
        try: async ({ attempt, signal }): Promise<number> => {
          attempts = attempt;
          expect(signal).toBe(controller.signal);
          throw new Error(`attempt ${attempt} failed`);
        },
        catch: (cause) =>
          new RetryFailure({ attempt: attempts, cause, message: "retryable operation failed" }),
      },
      {
        signal: controller.signal,
        retry: {
          times: 3,
          delayMs: (error, { attempt, signal }) => {
            retryDelayStarted.resolve({ error, signal, attempt });
            return 60_000;
          },
        },
      },
    );
    type RetryInference = Expect<
      Equal<Awaited<typeof resultPromise>, ResultType<number, RetryFailure>>
    >;
    const retryInference: RetryInference = true;

    const pendingDelay = await retryDelayStarted.promise;
    expect(pendingDelay.attempt).toBe(1);
    expect(pendingDelay.signal).toBe(controller.signal);
    expect(pendingDelay.error.attempt).toBe(1);

    controller.abort("stop retries");
    await abortObserved.promise;
    const result = await resultPromise;

    expect(retryInference).toBe(true);
    expect(attempts).toBe(1);
    expect(result).toEqual(Result.err(pendingDelay.error));
    expect(OperationCancelled.is(result.status === "error" ? result.error : undefined)).toBe(false);
  });

  it("returns cancellation before a pre-aborted retry attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before retry");
    let attempts = 0;
    let delays = 0;
    controller.abort(reason);

    const result = await runCancellationAwareRetry({
      signal: controller.signal,
      retries: 2,
      attempt: async () => {
        attempts += 1;
        return 42;
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: () => {
        delays += 1;
        return Promise.resolve();
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error" && OperationCancelled.is(result.error)) {
      expect(result.error.reason).toBe(reason);
    } else {
      throw new Error("expected pre-abort cancellation");
    }
    expect(attempts).toBe(0);
    expect(delays).toBe(0);
  });

  it("returns cancellation when the owned signal aborts in flight", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled in flight");
    const attemptStarted = deferred<AbortSignal>();
    let delays = 0;
    const resultPromise = runCancellationAwareRetry({
      signal: controller.signal,
      retries: 2,
      attempt: ({ signal }) => {
        attemptStarted.resolve(signal);
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: () => {
        delays += 1;
        return Promise.resolve();
      },
    });

    expect(await attemptStarted.promise).toBe(controller.signal);
    controller.abort(reason);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    if (result.status === "error" && OperationCancelled.is(result.error)) {
      expect(result.error.reason).toBe(reason);
    } else {
      throw new Error("expected in-flight cancellation");
    }
    expect(delays).toBe(0);
  });

  it("returns cancellation when the owned signal aborts during an injected retry delay", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during delay");
    const attemptCause = new Error("first attempt failed");
    const delayStarted = deferred<CancellationAwareDelayContext<ExternalOperationFailure>>();
    let attempts = 0;
    const resultPromise = runCancellationAwareRetry({
      signal: controller.signal,
      retries: 2,
      attempt: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        attempts += 1;
        throw attemptCause;
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: (context) => {
        delayStarted.resolve(context);
        if (context.signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    const delay = await delayStarted.promise;
    expect(delay.attempt).toBe(1);
    expect(delay.signal).toBe(controller.signal);
    expect(delay.error.cause).toBe(attemptCause);
    controller.abort(reason);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    if (result.status === "error" && OperationCancelled.is(result.error)) {
      expect(result.error.reason).toBe(reason);
    } else {
      throw new Error("expected retry-delay cancellation");
    }
    expect(attempts).toBe(1);
  });

  it("gives an owned abort precedence in the completion race", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled as attempt completed");
    const attemptStarted = deferred<AbortSignal>();
    const completeAttempt = deferred<number>();
    const resultPromise = runCancellationAwareRetry({
      signal: controller.signal,
      retries: 0,
      attempt: ({ signal }) => {
        attemptStarted.resolve(signal);
        return completeAttempt.promise;
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: () => Promise.resolve(),
    });

    expect(await attemptStarted.promise).toBe(controller.signal);
    completeAttempt.resolve(42);
    controller.abort(reason);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    if (result.status === "error" && OperationCancelled.is(result.error)) {
      expect(result.error.reason).toBe(reason);
    } else {
      throw new Error("expected completion-race cancellation");
    }
  });

  it("returns the latest typed external rejection after retries", async () => {
    const controller = new AbortController();
    const firstCause = new Error("first external rejection");
    const latestCause = new Error("latest external rejection");
    const delayContexts: CancellationAwareDelayContext<ExternalOperationFailure>[] = [];
    let attempts = 0;
    const resultPromise = runCancellationAwareRetry({
      signal: controller.signal,
      retries: 1,
      attempt: async ({ attempt, signal }): Promise<number> => {
        expect(signal).toBe(controller.signal);
        attempts = attempt;
        throw attempt === 1 ? firstCause : latestCause;
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: (context) => {
        delayContexts.push(context);
        return Promise.resolve();
      },
    });
    type CancellationAwareRetryInference = Expect<
      Equal<
        Awaited<typeof resultPromise>,
        ResultType<number, ExternalOperationFailure | OperationCancelled>
      >
    >;
    const cancellationAwareRetryInference: CancellationAwareRetryInference = true;
    const result = await resultPromise;

    expect(cancellationAwareRetryInference).toBe(true);
    expect(attempts).toBe(2);
    expect(delayContexts).toHaveLength(1);
    expect(delayContexts[0]?.signal).toBe(controller.signal);
    expect(delayContexts[0]?.error.cause).toBe(firstCause);
    expect(result.status).toBe("error");
    if (result.status === "error" && ExternalOperationFailure.is(result.error)) {
      expect(result.error.cause).toBe(latestCause);
    } else {
      throw new Error("expected latest external operation failure");
    }
  });

  it("does not classify an unrelated AbortError-like rejection as owned cancellation", async () => {
    const ownedController = new AbortController();
    const unrelatedController = new AbortController();
    const unrelatedReason = Object.assign(new Error("unrelated failure"), { name: "AbortError" });
    unrelatedController.abort(unrelatedReason);

    const result = await runCancellationAwareRetry({
      signal: ownedController.signal,
      retries: 0,
      attempt: async ({ signal }): Promise<number> => {
        expect(signal).toBe(ownedController.signal);
        throw unrelatedController.signal.reason;
      },
      mapRejected: (cause) =>
        new ExternalOperationFailure({ cause, message: "external operation failed" }),
      delay: () => Promise.resolve(),
    });

    expect(ownedController.signal.aborted).toBe(false);
    expect(result.status).toBe("error");
    if (result.status === "error" && ExternalOperationFailure.is(result.error)) {
      expect(result.error.cause).toBe(unrelatedReason);
      expect(OperationCancelled.is(result.error)).toBe(false);
    } else {
      throw new Error("expected unrelated external operation failure");
    }
  });
});
