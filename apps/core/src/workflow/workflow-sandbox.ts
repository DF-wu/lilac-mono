import path from "node:path";

import { z } from "zod";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { projectRuntimeError } from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";
import { jsonValueSchema, type JsonObject, type JsonValue } from "./workflow-domain";
import {
  parseWorkflowCallSiteManifestUnchecked,
  type WorkflowCallSiteManifestEntry,
} from "./workflow-source-compiler";

const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 100;
const KILL_EXIT_TIMEOUT_MS = 3_000;

const sandboxCallSchema = z.strictObject({
  type: z.literal("call"),
  id: z.number().int().positive(),
  kind: z.enum(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]),
  callSiteId: z.string().min(1).max(200),
  occurrence: z.number().int().nonnegative(),
  path: z.string().min(1).max(1_000),
  parentPath: z.string().min(1).max(1_000).nullable(),
  phase: z.string().min(1).max(200).nullable(),
  depth: z.number().int().nonnegative(),
  input: jsonValueSchema,
});
export type WorkflowSandboxCall = z.infer<typeof sandboxCallSchema>;

const sandboxOutputSchema = z.discriminatedUnion("type", [
  sandboxCallSchema,
  z.strictObject({ type: z.literal("result"), result: jsonValueSchema }),
  z.strictObject({ type: z.literal("error"), error: z.string().max(16_384) }),
]);

export class WorkflowSandboxOutputInvalid extends TaggedError("WorkflowSandboxOutputInvalid")<{
  readonly message: string;
}> {}

export class WorkflowSandboxCancelled extends TaggedError("WorkflowSandboxCancelled")<{
  readonly message: string;
}> {}

export class WorkflowSandboxExecutionFailed extends TaggedError("WorkflowSandboxExecutionFailed")<{
  readonly message: string;
}> {}

export class WorkflowSandboxTerminationFailed extends TaggedError(
  "WorkflowSandboxTerminationFailed",
)<{
  readonly message: string;
}> {}

export type WorkflowSandboxError =
  | WorkflowSandboxCancelled
  | WorkflowSandboxExecutionFailed
  | WorkflowSandboxTerminationFailed;

export async function decodeWorkflowSandboxOutputLine(
  line: string,
): Promise<ResultType<z.output<typeof sandboxOutputSchema>, WorkflowSandboxOutputInvalid>> {
  const parsed = await settleSandboxExternal(() => JSON.parse(line));
  return parsed
    .mapError(
      () =>
        new WorkflowSandboxOutputInvalid({
          message: "Workflow sandbox emitted malformed JSON",
        }),
    )
    .andThen((value) => {
      const decoded = sandboxOutputSchema.safeParse(value);
      if (!decoded.success) {
        return Result.err(
          new WorkflowSandboxOutputInvalid({
            message: "Workflow sandbox emitted an invalid protocol message",
          }),
        );
      }
      return Result.ok(decoded.data);
    });
}

function boundedJsonLine(value: JsonObject): ResultType<string, WorkflowSandboxExecutionFailed> {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_BYTES) {
    return Result.err(
      new WorkflowSandboxExecutionFailed({
        message: "Workflow sandbox protocol message exceeds limit",
      }),
    );
  }
  return Result.ok(line);
}

type WorkflowSandboxLauncher = {
  stdin: { write(value: string): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
};

export type WorkflowSandboxRuntimeProbes = {
  spawn(command: readonly string[]): WorkflowSandboxLauncher;
  sleep(ms: number): Promise<void>;
};

const defaultRuntimeProbes: WorkflowSandboxRuntimeProbes = {
  spawn: (command) =>
    Bun.spawn([...command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  sleep: Bun.sleep,
};

export type WorkflowSandboxRun = {
  result: Promise<ResultType<JsonValue, WorkflowSandboxError>>;
  cancel(): Promise<ResultType<void, WorkflowSandboxTerminationFailed>>;
};

type LauncherExit = { type: "exit"; exitCode: number } | { type: "error"; error: unknown };

class WorkflowSandboxTerminationSignal extends Error {}

function errorFrom(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(opaqueErrorMessage(value, "Opaque workflow sandbox failure"));
}

async function settleSandboxExternal<T>(
  effect: () => T | Promise<T>,
): Promise<ResultType<T, WorkflowSandboxExecutionFailed>> {
  const [settled] = await Promise.allSettled([Promise.resolve().then(effect)]);
  if (settled.status === "rejected") {
    if (Panic.is(settled.reason)) preserveToolPanic(settled.reason);
    return Result.err(
      new WorkflowSandboxExecutionFailed({ message: errorFrom(settled.reason).message }),
    );
  }
  return Result.ok(settled.value);
}

function captureSandboxTerminationSync<T>(
  operation: string,
  effect: () => Awaited<T>,
): ResultType<T, WorkflowSandboxTerminationFailed | Panic> {
  const started = Result.try({
    try: effect,
    catch: projectRuntimeError(`Opaque ${operation}`),
  });
  return started.mapError((error) =>
    Panic.is(error)
      ? error
      : new WorkflowSandboxTerminationFailed({
          message: `${operation}: ${error.message}`,
        }),
  );
}

async function captureSandboxTerminationPromise<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<ResultType<T, WorkflowSandboxTerminationFailed | Panic>> {
  const started = captureSandboxTerminationSync(operation, () => ({ promise: effect() }));
  const startedOutcome = started.match<
    | { readonly kind: "ok"; readonly promise: Promise<T> }
    | {
        readonly kind: "error";
        readonly error: WorkflowSandboxTerminationFailed | Panic;
      }
  >({
    ok: ({ promise }) => ({ kind: "ok", promise }),
    err: (error) => ({ kind: "error", error }),
  });
  if (startedOutcome.kind === "error") return Result.err(startedOutcome.error);
  const [settled] = await Promise.allSettled([startedOutcome.promise]);
  if (settled.status === "fulfilled") return Result.ok(settled.value);
  if (Panic.is(settled.reason)) return Result.err(settled.reason);
  return Result.err(
    new WorkflowSandboxTerminationFailed({
      message: `${operation}: ${errorFrom(settled.reason).message}`,
    }),
  );
}

export function startWorkflowSandbox(input: {
  source: string;
  args: JsonObject;
  signal?: AbortSignal;
  onCall(call: WorkflowSandboxCall): Promise<ResultType<JsonValue, Error>>;
  runtimeProbes?: WorkflowSandboxRuntimeProbes;
  reportFatalPanic?: (panic: Panic) => void;
}): WorkflowSandboxRun {
  if (input.signal?.aborted) {
    const result: Promise<ResultType<JsonValue, WorkflowSandboxError>> = Promise.resolve(
      Result.err(new WorkflowSandboxCancelled({ message: "Workflow sandbox cancelled" })),
    );
    const cancelPromise: Promise<ResultType<void, WorkflowSandboxTerminationFailed>> =
      Promise.resolve(Result.ok(undefined));
    return { result, cancel: () => cancelPromise };
  }
  const manifest = parseWorkflowCallSiteManifestUnchecked(input.source);
  const manifestOutcome = manifest.match<
    | { readonly kind: "ok"; readonly entries: readonly WorkflowCallSiteManifestEntry[] }
    | { readonly kind: "error"; readonly message: string }
  >({
    ok: (entries) => ({ kind: "ok", entries }),
    err: (error) => ({ kind: "error", message: error.message }),
  });
  if (manifestOutcome.kind === "error") {
    const result = Promise.resolve(
      Result.err<JsonValue, WorkflowSandboxError>(
        new WorkflowSandboxExecutionFailed({ message: manifestOutcome.message }),
      ),
    );
    const cancelPromise: Promise<ResultType<void, WorkflowSandboxTerminationFailed>> =
      Promise.resolve(Result.ok(undefined));
    return { result, cancel: () => cancelPromise };
  }
  const allowedCallSites = new Map(
    manifestOutcome.entries.map((entry) => [entry.callSiteId, entry.kind]),
  );
  const runtime = input.runtimeProbes ?? defaultRuntimeProbes;
  const helperPath = path.join(import.meta.dir, "workflow-sandbox-child.js");
  const command = [process.execPath, "--smol", helperPath] as const;
  const subprocess = runtime.spawn(command);

  let processExited = false;
  const launcherExited = Promise.allSettled([subprocess.exited]).then(([settled]): LauncherExit => {
    processExited = true;
    return settled.status === "fulfilled"
      ? { type: "exit", exitCode: settled.value }
      : { type: "error", error: errorFrom(settled.reason) };
  });

  let terminationError: Error | null = null;
  const currentTerminationError = (): Error | null => terminationError;
  let terminationPromise: Promise<ResultType<void, WorkflowSandboxTerminationFailed>> | null = null;
  let resolveTermination: (error: Error) => void = () => {};
  const terminationResult = new Promise<{ type: "termination"; error: Error }>((resolve) => {
    resolveTermination = (error) => resolve({ type: "termination", error });
  });
  let firstHostDefect: unknown;
  let hasHostDefect = false;
  let hostPanic: unknown;
  let terminationPanic: Panic | null = null;
  const hostCallsInFlight = new Set<Promise<ResultType<void, WorkflowSandboxExecutionFailed>>>();

  const waitForExit = async (
    timeoutMs: number,
    operation: string,
  ): Promise<ResultType<boolean, WorkflowSandboxTerminationFailed | Panic>> => {
    const delay = captureSandboxTerminationPromise(operation, () => runtime.sleep(timeoutMs));
    const raced = await Promise.race([
      launcherExited.then(() => ({ type: "exit" as const })),
      delay.then((result) => ({ type: "delay" as const, result })),
    ]);
    if (raced.type === "exit") {
      void delay.then((late) => {
        late.match({
          ok: () => undefined,
          err: (error) => {
            if (Panic.is(error)) input.reportFatalPanic?.(error);
          },
        });
      });
      return Result.ok(true);
    }
    return raced.result.map(() => false);
  };

  const performTermination = async (): Promise<
    ResultType<void, WorkflowSandboxTerminationFailed>
  > => {
    const failures: WorkflowSandboxTerminationFailed[] = [];
    let cleanupPanic: Panic | null = null;
    const record = (
      result: ResultType<unknown, WorkflowSandboxTerminationFailed | Panic>,
    ): void => {
      result.match({
        ok: () => undefined,
        err: (error) => {
          if (Panic.is(error)) cleanupPanic ??= error;
          else failures.push(error);
        },
      });
    };

    record(
      captureSandboxTerminationSync("Workflow sandbox stdin close failed", () =>
        subprocess.stdin.end(),
      ),
    );
    if (!processExited) {
      record(
        captureSandboxTerminationSync("Workflow sandbox SIGTERM failed", () =>
          subprocess.kill("SIGTERM"),
        ),
      );
      const grace = await waitForExit(
        TERMINATION_GRACE_MS,
        "Workflow sandbox SIGTERM grace wait failed",
      );
      record(grace);
      const exitedAfterGrace = grace.match({
        ok: (exited) => exited,
        err: () => false,
      });
      if (!exitedAfterGrace) {
        record(
          captureSandboxTerminationSync("Workflow sandbox SIGKILL failed", () =>
            subprocess.kill("SIGKILL"),
          ),
        );
        const killed = await waitForExit(
          KILL_EXIT_TIMEOUT_MS,
          "Workflow sandbox SIGKILL exit wait failed",
        );
        record(killed);
        const exitedAfterKill = killed.match({
          ok: (exited) => exited,
          err: () => true,
        });
        if (!exitedAfterKill) {
          failures.push(
            new WorkflowSandboxTerminationFailed({
              message: `Workflow sandbox process did not exit within ${KILL_EXIT_TIMEOUT_MS}ms after SIGKILL`,
            }),
          );
        }
      }
    }

    if (cleanupPanic) {
      terminationPanic = cleanupPanic;
      preserveToolPanic(cleanupPanic);
    }
    if (failures.length > 0) {
      return Result.err(
        new WorkflowSandboxTerminationFailed({
          message: failures.map((failure) => failure.message).join("; "),
        }),
      );
    }
    return Result.ok(undefined);
  };

  const terminate = (cause: Error): Promise<ResultType<void, WorkflowSandboxTerminationFailed>> => {
    if (terminationPromise) return terminationPromise;
    if (processExited) return Promise.resolve(Result.ok(undefined));
    terminationError = cause;
    terminationPromise = performTermination();
    void Promise.allSettled([terminationPromise]).then(([settled]) => {
      if (settled.status === "rejected") {
        const error = errorFrom(settled.reason);
        if (Panic.is(settled.reason)) terminationPanic = settled.reason;
        resolveTermination(error);
        return;
      }
      resolveTermination(
        settled.value.match({
          ok: () => cause,
          err: (error) => new WorkflowSandboxTerminationSignal(error.message),
        }),
      );
    });
    return terminationPromise;
  };
  const cancellationError = new Error("Workflow sandbox cancelled");
  let cancelResultPromise: Promise<ResultType<void, WorkflowSandboxTerminationFailed>> | null =
    null;
  const cancel = (): Promise<ResultType<void, WorkflowSandboxTerminationFailed>> => {
    cancelResultPromise ??= (async () => {
      return await terminate(cancellationError);
    })();
    return cancelResultPromise;
  };

  const abort = (): void => {
    void Promise.allSettled([cancel()]).then(([settled]) => {
      if (settled.status === "rejected" && Panic.is(settled.reason)) {
        input.reportFatalPanic?.(settled.reason);
      }
    });
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  const respondToHostCall = async (
    message: WorkflowSandboxCall,
  ): Promise<ResultType<void, WorkflowSandboxExecutionFailed>> => {
    let response: ResultType<JsonValue, Error>;
    try {
      response = await input.onCall(message);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      response = Result.err(cause);
    }
    const payload = response.match<JsonObject>({
      ok: (value) => ({ type: "resolve", id: message.id, value }),
      err: (error) => ({ type: "reject", id: message.id, error: error.message }),
    });
    return Result.gen(async function* () {
      const encoded = yield* boundedJsonLine(payload);
      yield* Result.await(settleSandboxExternal(() => subprocess.stdin.write(encoded)));
      return Result.ok(undefined);
    });
  };

  const executionResult = (async (): Promise<ResultType<JsonValue, WorkflowSandboxError>> => {
    const stderrPromise = (async (): Promise<
      ResultType<string, WorkflowSandboxExecutionFailed>
    > => {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      for await (const chunk of subprocess.stderr) {
        bytes += chunk.byteLength;
        if (bytes > MAX_STDERR_BYTES) {
          const error = new Error("Workflow sandbox stderr exceeded limit");
          await terminate(error);
          return Result.err(new WorkflowSandboxExecutionFailed({ message: error.message }));
        }
        text += decoder.decode(chunk, { stream: true });
      }
      return Result.ok(text + decoder.decode());
    })();

    const startLine = boundedJsonLine({ type: "start", source: input.source, args: input.args });
    const startOutcome = startLine.match<
      | { readonly kind: "ok"; readonly line: string }
      | { readonly kind: "error"; readonly error: WorkflowSandboxExecutionFailed }
    >({
      ok: (line) => ({ kind: "ok", line }),
      err: (error) => ({ kind: "error", error }),
    });
    if (startOutcome.kind === "error") return Result.err(startOutcome.error);
    subprocess.stdin.write(startOutcome.line);

    const decoder = new TextDecoder();
    let buffered = "";
    let stdoutBytes = 0;
    let resolvedResult: JsonValue | undefined;
    let receivedResult = false;
    let sandboxError: string | null = null;

    for await (const chunk of subprocess.stdout) {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PROTOCOL_BYTES) {
        const failure = new WorkflowSandboxExecutionFailed({
          message: "Workflow sandbox cumulative stdout exceeded limit",
        });
        await terminate(failure);
        return Result.err(failure);
      }
      buffered += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > MAX_PROTOCOL_BYTES) {
        const failure = new WorkflowSandboxExecutionFailed({
          message: "Workflow sandbox stdout exceeded limit",
        });
        await terminate(failure);
        return Result.err(failure);
      }

      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const decoded = await decodeWorkflowSandboxOutputLine(line);
        const decodedOutcome = decoded.match<
          | { readonly kind: "ok"; readonly message: z.output<typeof sandboxOutputSchema> }
          | { readonly kind: "error"; readonly error: WorkflowSandboxOutputInvalid }
        >({
          ok: (message) => ({ kind: "ok", message }),
          err: (error) => ({ kind: "error", error }),
        });
        if (decodedOutcome.kind === "error") {
          await terminate(decodedOutcome.error);
          return Result.err(
            new WorkflowSandboxExecutionFailed({ message: decodedOutcome.error.message }),
          );
        }
        const message = decodedOutcome.message;
        if (message.type === "call") {
          if (allowedCallSites.get(message.callSiteId) !== message.kind) {
            const failure = new WorkflowSandboxExecutionFailed({
              message: `Workflow sandbox emitted unapproved call site ${message.kind}:${message.callSiteId}`,
            });
            await terminate(failure);
            return Result.err(failure);
          }
          const hostCall = respondToHostCall(message).then(
            (outcome) =>
              outcome.match<Promise<ResultType<void, WorkflowSandboxExecutionFailed>>>({
                ok: () => Promise.resolve(outcome),
                err: async (error) => {
                  if (!hasHostDefect) {
                    hasHostDefect = true;
                    firstHostDefect = error;
                  }
                  await terminate(error);
                  return outcome;
                },
              }),
            async (cause: unknown) => {
              if (!hasHostDefect) {
                hasHostDefect = true;
                firstHostDefect = cause;
              }
              if (Panic.is(cause) && hostPanic === undefined) hostPanic = cause;
              const error = errorFrom(cause);
              await terminate(error);
              return Result.err(new WorkflowSandboxExecutionFailed({ message: error.message }));
            },
          );
          hostCallsInFlight.add(hostCall);
          void Promise.allSettled([hostCall]).then(() => hostCallsInFlight.delete(hostCall));
        } else if (message.type === "result") {
          receivedResult = true;
          resolvedResult = message.result;
          await settleSandboxExternal(() => subprocess.stdin.end());
        } else {
          sandboxError = message.error;
          await settleSandboxExternal(() => subprocess.stdin.end());
        }
      }
    }

    buffered += decoder.decode();
    if (buffered.length > 0) {
      return Result.err(
        new WorkflowSandboxExecutionFailed({
          message: "Workflow sandbox emitted an incomplete protocol message",
        }),
      );
    }
    const exit = await launcherExited;
    const stderrResult = await stderrPromise;
    const stderrOutcome = stderrResult.match<
      | { readonly kind: "ok"; readonly stderr: string }
      | { readonly kind: "error"; readonly error: WorkflowSandboxExecutionFailed }
    >({
      ok: (stderr) => ({ kind: "ok", stderr: stderr.trim() }),
      err: (error) => ({ kind: "error", error }),
    });
    if (stderrOutcome.kind === "error") return Result.err(stderrOutcome.error);
    const stderr = stderrOutcome.stderr;
    const terminalError = currentTerminationError();
    if (terminalError) {
      if (terminalError === cancellationError) {
        return Result.err(new WorkflowSandboxCancelled({ message: terminalError.message }));
      }
      return Result.err(new WorkflowSandboxExecutionFailed({ message: terminalError.message }));
    }
    if (exit.type === "error") {
      return Result.err(
        new WorkflowSandboxExecutionFailed({
          message: `Workflow sandbox process failed: ${errorFrom(exit.error).message}`,
        }),
      );
    }
    if (sandboxError) {
      return Result.err(new WorkflowSandboxExecutionFailed({ message: sandboxError }));
    }
    if (receivedResult && exit.exitCode === 0) return Result.ok(resolvedResult ?? null);
    return Result.err(
      new WorkflowSandboxExecutionFailed({
        message: `Workflow sandbox exited with code ${exit.exitCode}${stderr ? `: ${stderr}` : ""}`,
      }),
    );
  })();

  const result = (async (): Promise<ResultType<JsonValue, WorkflowSandboxError>> => {
    try {
      const outcome = await Promise.race([
        executionResult.then((execution) => ({ type: "execution" as const, execution })),
        terminationResult,
      ]);
      while (hostCallsInFlight.size > 0) {
        await Promise.allSettled(hostCallsInFlight);
      }
      if (hostPanic !== undefined) throw hostPanic;
      if (terminationPanic) preserveToolPanic(terminationPanic);
      if (hasHostDefect) throw firstHostDefect;
      if (outcome.type === "execution") return outcome.execution;
      if (outcome.error instanceof WorkflowSandboxTerminationSignal) {
        return Result.err(new WorkflowSandboxTerminationFailed({ message: outcome.error.message }));
      }
      if (outcome.error === cancellationError) {
        return Result.err(new WorkflowSandboxCancelled({ message: outcome.error.message }));
      }
      return Result.err(new WorkflowSandboxExecutionFailed({ message: outcome.error.message }));
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      if (cause instanceof WorkflowSandboxTerminationSignal) {
        return Result.err(new WorkflowSandboxTerminationFailed({ message: cause.message }));
      }
      if (cause === cancellationError) {
        return Result.err(new WorkflowSandboxCancelled({ message: cause.message }));
      }
      return Result.err(new WorkflowSandboxExecutionFailed({ message: cause.message }));
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  })();

  return { result, cancel };
}
