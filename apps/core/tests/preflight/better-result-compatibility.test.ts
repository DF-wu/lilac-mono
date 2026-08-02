import { describe, expect, it } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";

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
});
