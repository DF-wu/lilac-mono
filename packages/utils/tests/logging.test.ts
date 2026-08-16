import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";

import { createLogger, getOpenObserveDiagnostics } from "../logging";

type EnvPatch = Record<string, string | undefined>;

class MemoryWriteStream {
  readonly chunks: string[] = [];

  write(chunk: string): unknown {
    this.chunks.push(chunk);
    return true;
  }

  joined(): string {
    return this.chunks.join("");
  }
}

class NullWriteStream {
  write(_chunk: string): unknown {
    return true;
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((cause: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred resolve unavailable");
      resolvePromise(value);
    },
    reject(cause) {
      if (!rejectPromise) throw new Error("Deferred reject unavailable");
      rejectPromise(cause);
    },
  };
}

type FetchCall = {
  readonly url: string;
  readonly init?: Parameters<typeof fetch>[1];
};

type FetchHarness = {
  readonly calls: readonly FetchCall[];
  readonly waitForCall: (index: number) => Promise<FetchCall>;
};

function asHeaderRecord(headers: RequestInit["headers"] | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
      result[key.toLowerCase()] = value;
    }
    return result;
  }

  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers) {
      if (typeof key === "string" && typeof value === "string") {
        result[key.toLowerCase()] = value;
      }
    }
    return result;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
  }
  return result;
}

function parseJsonBody(body: RequestInit["body"] | undefined): unknown[] {
  if (typeof body !== "string") return [];
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withMockFetch<T>(
  responseForCall: (call: FetchCall, index: number) => Response | Promise<Response>,
  fn: (harness: FetchHarness) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const callWaiters = new Map<number, Deferred<FetchCall>>();
  const globals = globalThis as unknown as { fetch: typeof fetch };
  const originalFetch = globals.fetch;

  globals.fetch = (async (...args: Parameters<typeof fetch>) => {
    const call: FetchCall = { url: String(args[0]), init: args[1] };
    const index = calls.length;
    calls.push(call);
    callWaiters.get(index)?.resolve(call);
    return await responseForCall(call, index);
  }) as typeof fetch;

  const harness: FetchHarness = {
    calls,
    waitForCall(index) {
      const existing = calls[index];
      if (existing) return Promise.resolve(existing);
      const waiter = callWaiters.get(index) ?? createDeferred<FetchCall>();
      callWaiters.set(index, waiter);
      return waiter.promise;
    },
  };

  try {
    return await fn(harness);
  } finally {
    globals.fetch = originalFetch;
  }
}

async function withCapturedStderr<T>(fn: (chunks: string[]) => Promise<T>): Promise<T> {
  const stderr = process.stderr as unknown as {
    write: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => boolean;
  };
  const originalWrite = stderr.write;
  const chunks: string[] = [];

  stderr.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    callback?.(null);
    return true;
  }) as typeof stderr.write;

  try {
    return await fn(chunks);
  } finally {
    stderr.write = originalWrite;
  }
}

type ControlledTimers = {
  readonly fireOldest: () => void;
};

async function withControlledTimers<T>(fn: (timers: ControlledTimers) => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const originalSetTimeout = globals.setTimeout;
  const originalClearTimeout = globals.clearTimeout;
  const callbacks = new Map<number, () => void>();
  let nextId = 1;

  globals.setTimeout = ((
    callback: string | ((...args: unknown[]) => void),
    _delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof callback !== "function") throw new Error("String timer handlers are unsupported");
    const id = nextId++;
    callbacks.set(id, () => callback(...args));
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globals.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    callbacks.delete(Number(id));
  }) as typeof clearTimeout;

  try {
    return await fn({
      fireOldest() {
        const entry = callbacks.entries().next().value;
        if (!entry) throw new Error("No controlled timer is pending");
        const [id, callback] = entry;
        callbacks.delete(id);
        callback();
      },
    });
  } finally {
    globals.setTimeout = originalSetTimeout;
    globals.clearTimeout = originalClearTimeout;
  }
}

async function waitForDiagnostics(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("OpenObserve diagnostics did not reach the expected observable state");
}

let endpointSequence = 0;

function openObserveEnv(extra: EnvPatch = {}): EnvPatch {
  endpointSequence += 1;
  return {
    LILAC_LOG_JSONL: undefined,
    LILAC_LOG_OPENOBSERVE_BASE_URL: `https://observe-${endpointSequence}.example`,
    LILAC_LOG_OPENOBSERVE_ORG: undefined,
    LILAC_LOG_OPENOBSERVE_STREAM: undefined,
    LILAC_LOG_OPENOBSERVE_LEVEL: undefined,
    LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: undefined,
    LILAC_LOG_OPENOBSERVE_USERNAME: undefined,
    LILAC_LOG_OPENOBSERVE_PASSWORD: undefined,
    ...extra,
  };
}

function remoteLogger(stdout = new NullWriteStream(), stderr = new NullWriteStream()) {
  return createLogger({ module: "logging-test", logLevel: "info", stdout, stderr });
}

describe("logging", () => {
  it("keeps local text output by default", async () => {
    await withEnv(
      { LILAC_LOG_JSONL: undefined, LILAC_LOG_OPENOBSERVE_BASE_URL: undefined },
      async () => {
        const stdout = new MemoryWriteStream();
        const logger = createLogger({
          module: "logging-test",
          logLevel: "info",
          stdout,
          stderr: new MemoryWriteStream(),
        });

        logger.info("hello-text");

        expect(stdout.joined()).toContain("hello-text");
        expect(stdout.joined().trim().startsWith("{")).toBe(false);
      },
    );
  });

  it("supports local jsonl output via env flag", async () => {
    await withEnv({ LILAC_LOG_JSONL: "1", LILAC_LOG_OPENOBSERVE_BASE_URL: undefined }, async () => {
      const stdout = new MemoryWriteStream();
      const logger = createLogger({
        module: "logging-test",
        logLevel: "info",
        stdout,
        stderr: new MemoryWriteStream(),
      });

      logger.info("hello-jsonl");

      const record = JSON.parse(stdout.joined().trim()) as Record<string, unknown>;
      expect(record.level).toBe("info");
      expect(record.message).toBe("hello-jsonl");
      expect(record.module).toBe("logging-test");
    });
  });

  it("mirrors normalized records while preserving local text and auth", async () => {
    await withEnv(
      openObserveEnv({
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: "token-123",
        LILAC_LOG_OPENOBSERVE_USERNAME: "ignored-user",
        LILAC_LOG_OPENOBSERVE_PASSWORD: "ignored-password",
      }),
      async () => {
        const before = getOpenObserveDiagnostics();
        await withMockFetch(
          () => new Response("{}", { status: 200 }),
          async ({ waitForCall }) => {
            const stdout = new MemoryWriteStream();
            const logger = remoteLogger(stdout, new MemoryWriteStream());

            logger.info(
              "structured-event",
              { adapterEventType: "adapter.message.updated", nested: { hello: "world" } },
              "second-arg",
            );
            const call = await waitForCall(0);

            expect(stdout.joined()).toContain("structured-event");
            expect(stdout.joined().trim().startsWith("{")).toBe(false);
            expect(call.url).toMatch(/\/api\/default\/lilac\/_json$/);
            expect(asHeaderRecord(call.init?.headers).authorization).toBe("Bearer token-123");

            const records = parseJsonBody(call.init?.body);
            expect(records).toHaveLength(1);
            const record = records[0] as Record<string, unknown>;
            expect(record.message).toBe("structured-event");
            expect(record.args).toBeUndefined();
            expect(record.argsCount).toBe(2);
            expect(record.arg0_adapterEventType).toBe("adapter.message.updated");
            expect(record.arg0_nested).toBe('{"hello":"world"}');
            expect(record.arg1).toBe("second-arg");

            await waitForDiagnostics(
              () => getOpenObserveDiagnostics().succeededBatches === before.succeededBatches + 1,
            );
          },
        );
      },
    );
  });

  it("supports a distinct remote log level", async () => {
    await withEnv(openObserveEnv({ LILAC_LOG_OPENOBSERVE_LEVEL: "warn" }), async () => {
      const before = getOpenObserveDiagnostics();
      await withMockFetch(
        () => new Response("{}", { status: 200 }),
        async ({ waitForCall }) => {
          const stdout = new MemoryWriteStream();
          const stderr = new MemoryWriteStream();
          const logger = remoteLogger(stdout, stderr);

          logger.info("local-only-info");
          logger.warn("local-and-remote-warn");
          const call = await waitForCall(0);

          expect(stdout.joined()).toContain("local-only-info");
          expect(stderr.joined()).toContain("local-and-remote-warn");
          const messages = parseJsonBody(call.init?.body).map(
            (record) => (record as Record<string, unknown>).message,
          );
          expect(messages).toEqual(["local-and-remote-warn"]);
          await waitForDiagnostics(
            () => getOpenObserveDiagnostics().succeededBatches === before.succeededBatches + 1,
          );
        },
      );
    });
  });

  it("emits rate-limited aggregate diagnostics without secrets or payloads", async () => {
    const endpointPassword = "endpoint-password-secret";
    const bearerToken = "bearer-token-secret";
    const requestSecret = "request-error-secret";
    const payloadSecret = "payload-secret";

    await withEnv(
      openObserveEnv({
        LILAC_LOG_OPENOBSERVE_BASE_URL: `https://endpoint-user:${endpointPassword}@redaction.example`,
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: bearerToken,
      }),
      async () => {
        await withCapturedStderr(async (stderrChunks) => {
          const before = getOpenObserveDiagnostics();
          await withMockFetch(
            () => {
              throw new Error(`password=${requestSecret}`);
            },
            async ({ waitForCall }) => {
              const logger = remoteLogger();
              logger.info(payloadSecret);
              await waitForCall(0);
              await waitForDiagnostics(
                () => getOpenObserveDiagnostics().failedBatches === before.failedBatches + 1,
              );

              const stderrText = stderrChunks.join("");
              expect(stderrText).toContain("[openobserve] delivery degraded");
              expect(stderrText).toContain("request=1");
              for (const secret of [
                endpointPassword,
                bearerToken,
                requestSecret,
                payloadSecret,
                "endpoint-user",
                "redaction.example",
              ]) {
                expect(stderrText).not.toContain(secret);
                expect(JSON.stringify(getOpenObserveDiagnostics())).not.toContain(secret);
              }
            },
          );
        });
      },
    );
  });

  it("classifies HTTP failures without reading response payloads", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        const before = getOpenObserveDiagnostics();
        await withMockFetch(
          () => new Response("response-secret", { status: 503 }),
          async ({ waitForCall }) => {
            const logger = remoteLogger();
            logger.info("http-failure-payload");
            await waitForCall(0);
            await waitForDiagnostics(
              () => getOpenObserveDiagnostics().failedBatches === before.failedBatches + 1,
            );

            const diagnostics = getOpenObserveDiagnostics();
            expect(diagnostics.httpFailures).toBe(before.httpFailures + 1);
            expect(diagnostics.lastFailureKind).toBe("http");
            expect(diagnostics.lastHttpStatus).toBe(503);
            expect(diagnostics.lastFailureAtMs).not.toBeNull();
          },
        );
      });
    });
  });

  it("shares one stream, permits one in-flight request, and never evicts its active batch", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        const firstResponse = createDeferred<Response>();
        const before = getOpenObserveDiagnostics();
        await withMockFetch(
          (_call, index) =>
            index === 0 ? firstResponse.promise : new Response("{}", { status: 200 }),
          async (harness) => {
            const firstLogger = remoteLogger();
            const secondLogger = remoteLogger();

            firstLogger.info("active-oldest");
            const firstCall = await harness.waitForCall(0);
            secondLogger.info("pending-shared");
            await Promise.resolve();

            expect(harness.calls).toHaveLength(1);
            expect(getOpenObserveDiagnostics().inFlightRequests).toBe(1);
            expect(
              (parseJsonBody(firstCall.init?.body)[0] as Record<string, unknown>).message,
            ).toBe("active-oldest");

            firstResponse.resolve(new Response("{}", { status: 200 }));
            const secondCall = await harness.waitForCall(1);
            expect(
              (parseJsonBody(secondCall.init?.body)[0] as Record<string, unknown>).message,
            ).toBe("pending-shared");
            await waitForDiagnostics(
              () =>
                getOpenObserveDiagnostics().succeededBatches === before.succeededBatches + 2 &&
                getOpenObserveDiagnostics().inFlightRequests === 0,
            );
          },
        );
      });
    });
  });

  it("bounds a stalled stream at 2000 records and evicts the oldest pending records", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        const firstResponse = createDeferred<Response>();
        const before = getOpenObserveDiagnostics();
        await withMockFetch(
          (_call, index) =>
            index === 0 ? firstResponse.promise : new Response("{}", { status: 200 }),
          async (harness) => {
            const logger = remoteLogger();
            logger.info("record-0");
            await harness.waitForCall(0);

            for (let index = 1; index <= 2_001; index += 1) {
              logger.info(`record-${index}`);
            }

            const bounded = getOpenObserveDiagnostics();
            expect(bounded.retainedRecords).toBe(2_000);
            expect(bounded.activeRecords).toBe(1);
            expect(bounded.pendingRecords).toBe(1_999);
            expect(bounded.overflowDroppedRecords - before.overflowDroppedRecords).toBe(2);
            expect(harness.calls).toHaveLength(1);

            firstResponse.resolve(new Response("{}", { status: 200 }));
            const secondCall = await harness.waitForCall(1);
            const secondBatch = parseJsonBody(secondCall.init?.body);
            expect((secondBatch[0] as Record<string, unknown>).message).toBe("record-3");
            await waitForDiagnostics(
              () =>
                getOpenObserveDiagnostics().retainedRecords === 0 &&
                getOpenObserveDiagnostics().inFlightRequests === 0,
            );
          },
        );
      });
    });
  });

  it("enforces retained bytes, record bytes, and batch count and byte limits", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        const firstResponse = createDeferred<Response>();
        const before = getOpenObserveDiagnostics();
        await withMockFetch(
          (_call, index) =>
            index === 0 ? firstResponse.promise : new Response("{}", { status: 200 }),
          async (harness) => {
            const logger = remoteLogger();
            logger.info("byte-anchor");
            await harness.waitForCall(0);

            const largeValue = "x".repeat(200_000);
            for (let index = 0; index < 50; index += 1) {
              logger.info(`large-${index}`, largeValue);
            }
            logger.info("oversize", "y".repeat(300_000));

            const bounded = getOpenObserveDiagnostics();
            expect(bounded.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
            expect(bounded.oversizeDroppedRecords - before.oversizeDroppedRecords).toBe(1);
            expect(bounded.overflowDroppedRecords).toBeGreaterThan(before.overflowDroppedRecords);

            firstResponse.resolve(new Response("{}", { status: 200 }));
            await waitForDiagnostics(
              () =>
                getOpenObserveDiagnostics().retainedRecords === 0 &&
                getOpenObserveDiagnostics().inFlightRequests === 0,
            );

            for (const call of harness.calls) {
              expect(parseJsonBody(call.init?.body).length).toBeLessThanOrEqual(200);
              expect(Buffer.byteLength(String(call.init?.body), "utf8")).toBeLessThanOrEqual(
                1024 * 1024,
              );
            }
          },
        );
      });
    });
  });

  it("aborts a timed-out fetch and recovers without retrying its batch", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        await withControlledTimers(async (timers) => {
          const aborted = createDeferred<void>();
          const before = getOpenObserveDiagnostics();
          await withMockFetch(
            (call, index) => {
              if (index > 0) return new Response("{}", { status: 200 });
              return new Promise<Response>((_, reject) => {
                call.init?.signal?.addEventListener("abort", () => {
                  aborted.resolve(undefined);
                  reject(new Error("request aborted"));
                });
              });
            },
            async (harness) => {
              const logger = remoteLogger();
              logger.info("timed-out-batch");
              const firstCall = await harness.waitForCall(0);
              logger.info("recovery-batch");

              timers.fireOldest();
              await aborted.promise;
              expect(firstCall.init?.signal?.aborted).toBe(true);

              const recoveryCall = await harness.waitForCall(1);
              expect(
                (parseJsonBody(recoveryCall.init?.body)[0] as Record<string, unknown>).message,
              ).toBe("recovery-batch");
              await waitForDiagnostics(
                () =>
                  getOpenObserveDiagnostics().timeoutFailures === before.timeoutFailures + 1 &&
                  getOpenObserveDiagnostics().retainedRecords === 0,
              );
              expect(harness.calls).toHaveLength(2);
            },
          );
        });
      });
    });
  });

  it("does not overlap batches while an aborted fetch remains unsettled", async () => {
    await withEnv(openObserveEnv(), async () => {
      await withCapturedStderr(async () => {
        await withControlledTimers(async (timers) => {
          const firstResponse = createDeferred<Response>();
          const aborted = createDeferred<void>();
          const before = getOpenObserveDiagnostics();
          await withMockFetch(
            (call, index) => {
              if (index > 0) return new Response("{}", { status: 200 });
              call.init?.signal?.addEventListener("abort", () => aborted.resolve(undefined));
              return firstResponse.promise;
            },
            async (harness) => {
              const logger = remoteLogger();
              logger.info("blocked-batch");
              await harness.waitForCall(0);
              logger.info("queued-after-timeout");

              timers.fireOldest();
              await aborted.promise;
              await Promise.resolve();

              expect(harness.calls).toHaveLength(1);
              expect(getOpenObserveDiagnostics()).toMatchObject({
                inFlightRequests: 1,
                activeRecords: 1,
                pendingRecords: 1,
              });

              firstResponse.resolve(new Response("{}", { status: 200 }));
              await harness.waitForCall(1);
              await waitForDiagnostics(
                () =>
                  getOpenObserveDiagnostics().timeoutFailures === before.timeoutFailures + 1 &&
                  getOpenObserveDiagnostics().retainedRecords === 0,
              );
              expect(harness.calls).toHaveLength(2);
            },
          );
        });
      });
    });
  });

  it("mirrors fatal logs before local process exit", async () => {
    await withEnv(openObserveEnv({ LILAC_LOG_OPENOBSERVE_LEVEL: "fatal" }), async () => {
      const before = getOpenObserveDiagnostics();
      await withMockFetch(
        () => new Response("{}", { status: 200 }),
        async ({ calls, waitForCall }) => {
          const proc = process as unknown as { exit: (code?: number) => never };
          const originalExit = proc.exit;
          proc.exit = ((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`);
          }) as (code?: number) => never;

          try {
            const localStderr = new MemoryWriteStream();
            const logger = remoteLogger(new NullWriteStream(), localStderr);
            logger.error("ordinary-error");
            await Promise.resolve();
            expect(calls).toHaveLength(0);
            expect(() => logger.log("fatal", "fatal-event")).toThrow("process.exit:1");
            expect(localStderr.joined()).toContain("fatal-event");
            const call = await waitForCall(0);
            const record = parseJsonBody(call.init?.body)[0] as Record<string, unknown>;
            expect(record.level).toBe("error");
            expect(record.message).toBe("fatal-event");
            await waitForDiagnostics(
              () => getOpenObserveDiagnostics().succeededBatches === before.succeededBatches + 1,
            );
          } finally {
            proc.exit = originalExit;
          }
        },
      );
    });
  });
});
