import {
  asSchema,
  InvalidToolInputError,
  type ModelMessage,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { createLogger, errorMessage } from "@stanley2058/lilac-utils";

import { isAgentPanic, rethrowAgentPanic, type OpaqueAgentValue } from "./failure-adapters";
import { isToolExpansion, type ExpandedToolCall, type ToolExpansion } from "./tool-call-expansion";

const logger = createLogger({ module: "atomic-tool-execution" });
const UNSERIALIZABLE_TOOL_RESULT = "[tool result is not JSON-serializable]";

export type ToolResultOutput = Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
>["output"];

export type NormalizeToolResultOutputFn = (
  output: ToolResultOutput,
  context: {
    toolCallId: string;
    toolName: string;
    bypassGenericOutputNormalizer?: boolean;
    aggregateOutputBudgetExempt?: boolean;
  },
) => ToolResultOutput | Promise<ToolResultOutput>;

export type SettledToolResultOutputEntry = {
  output: ToolResultOutput;
  context: Parameters<NormalizeToolResultOutputFn>[1];
};

export type NormalizeSettledToolResultOutputsFn = (
  entries: readonly SettledToolResultOutputEntry[],
  normalizeUnspilled?: NormalizeToolResultOutputFn,
) => Promise<ToolResultOutput[]>;

export type AtomicToolInputValidation =
  | { type: "prevalidated" }
  | { type: "invalid"; error?: OpaqueAgentValue }
  | { type: "validate" };

export type AtomicToolExpansionHandling =
  | { type: "capture" }
  | { type: "reject"; message?: string };

export type AtomicToolExecutionOutcomeKind = "success" | "invalid-input" | "denied" | "error";

export type AtomicToolExecutionOutcome = {
  result: unknown;
  isError: boolean;
  toolOutput: ToolResultOutput;
  outcome: AtomicToolExecutionOutcomeKind;
  expansion?: ToolExpansion;
};

export class AtomicToolStreamFailed extends TaggedError("AtomicToolStreamFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AtomicToolStreamCleanupFailed extends TaggedError("AtomicToolStreamCleanupFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AtomicToolStreamAndCleanupFailed extends TaggedError(
  "AtomicToolStreamAndCleanupFailed",
)<{
  readonly streamError: AtomicToolStreamFailed;
  readonly cleanupError: AtomicToolStreamCleanupFailed;
  readonly message: string;
}> {}

export type AtomicToolStreamError =
  | AtomicToolStreamFailed
  | AtomicToolStreamCleanupFailed
  | AtomicToolStreamAndCleanupFailed;

export class AtomicToolTerminalCleanupFailed extends TaggedError(
  "AtomicToolTerminalCleanupFailed",
)<{
  readonly cause: OpaqueAgentValue;
  readonly message: string;
}> {}

export class AtomicToolOperationAndCleanupError extends Error {
  constructor(
    readonly operationError: OpaqueAgentValue,
    readonly cleanupError: AtomicToolTerminalCleanupFailed,
  ) {
    super(
      `Atomic tool operation failed: ${errorMessage(operationError)}; terminal cleanup failed: ${cleanupError.message}`,
      { cause: cleanupError },
    );
    this.name = "AtomicToolOperationAndCleanupError";
  }
}

export class AtomicToolExecutionFailed extends TaggedError("AtomicToolExecutionFailed")<{
  readonly cause: OpaqueAgentValue;
  readonly message: string;
}> {}

export type AtomicToolExecutionEvent =
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      isError: boolean;
      output: ToolResultOutput;
      outcome: AtomicToolExecutionOutcomeKind;
    };

export type ExecuteAtomicToolCallOptions = {
  call: ExpandedToolCall;
  tools: ToolSet;
  messages: ModelMessage[];
  context?: unknown;
  abortSignal?: AbortSignal;
  pendingToolCalls: Set<string>;
  inputValidation: AtomicToolInputValidation;
  expansionHandling: AtomicToolExpansionHandling;
  normalizeToolResultOutput?: NormalizeToolResultOutputFn;
  bypassGenericOutputNormalizer?: boolean;
  aggregateOutputBudgetExempt?: boolean;
  executionRejection?: string;
  assertNotAborted?: () => void;
  onEvent?: (event: AtomicToolExecutionEvent) => void;
};

type JsonToolOutputValue = Extract<ToolResultOutput, { type: "json" }>["value"];

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function isInvalidToolInputError(error: unknown): boolean {
  if (InvalidToolInputError.isInstance(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError") return true;
  return isInvalidToolInputError(error.cause);
}

function isJsonToolOutputValue(value: unknown): value is JsonToolOutputValue {
  return isJsonToolOutputValueInner(value, new WeakSet<object>());
}

function isJsonToolOutputValueInner(
  value: unknown,
  activeObjects: WeakSet<object>,
): value is JsonToolOutputValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (activeObjects.has(value)) return false;
      activeObjects.add(value);
      try {
        const values = Array.isArray(value) ? value : Object.values(value);
        return values.every((item) => isJsonToolOutputValueInner(item, activeObjects));
      } catch (cause) {
        rethrowAgentPanic(cause);
        return false;
      } finally {
        activeObjects.delete(value);
      }
    default:
      return false;
  }
}

function toJsonToolOutputValue(value: unknown): JsonToolOutputValue {
  if (typeof value === "undefined") return null;
  if (isJsonToolOutputValue(value)) return value;

  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    if (isJsonToolOutputValue(parsed)) return parsed;
  } catch (cause) {
    rethrowAgentPanic(cause);
    // Fall through to the stable string representation.
  }

  return String(value);
}

function stringifyToolInput(value: OpaqueAgentValue): string {
  try {
    return JSON.stringify(value) ?? errorMessage(value);
  } catch (cause) {
    rethrowAgentPanic(cause);
    return errorMessage(value);
  }
}

function invalidInputMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error) return stringifyToolInput(error);
  return "Invalid tool input.";
}

export async function consumeAtomicToolResultStream(
  stream: AsyncIterable<unknown>,
  onUpdate: (value: unknown) => void,
): Promise<ResultType<unknown, AtomicToolStreamError>> {
  const iterator = stream[Symbol.asyncIterator]();
  let last: unknown;
  let completed = false;
  let streamError: AtomicToolStreamFailed | undefined;
  let streamPanic: Panic | undefined;

  while (!completed && streamError === undefined && streamPanic === undefined) {
    let next: IteratorResult<unknown>;
    try {
      next = await iterator.next();
    } catch (cause) {
      if (isAgentPanic(cause)) streamPanic = cause;
      else {
        streamError = new AtomicToolStreamFailed({
          cause,
          message: `Tool result stream failed: ${errorMessage(cause)}`,
        });
      }
      break;
    }
    if (next.done) {
      completed = true;
      last = next.value === undefined ? last : next.value;
      break;
    }
    last = next.value;
    try {
      onUpdate(next.value);
    } catch (cause) {
      if (isAgentPanic(cause)) streamPanic = cause;
      else {
        streamError = new AtomicToolStreamFailed({
          cause,
          message: `Tool result update failed: ${errorMessage(cause)}`,
        });
      }
    }
  }

  let cleanupError: AtomicToolStreamCleanupFailed | undefined;
  if (!completed && iterator.return) {
    try {
      await iterator.return();
    } catch (cause) {
      if (isAgentPanic(cause)) {
        if (streamPanic === undefined) rethrowAgentPanic(cause);
      } else {
        cleanupError = new AtomicToolStreamCleanupFailed({
          cause,
          message: `Tool result stream cleanup failed: ${errorMessage(cause)}`,
        });
      }
    }
  }

  if (streamPanic) rethrowAgentPanic(streamPanic);
  if (streamError && cleanupError) {
    return Result.err(
      new AtomicToolStreamAndCleanupFailed({
        streamError,
        cleanupError,
        message: `${streamError.message}; ${cleanupError.message}`,
      }),
    );
  }
  if (cleanupError) return Result.err(cleanupError);
  if (streamError) return Result.err(streamError);
  return Result.ok(last);
}

async function validateInput(
  options: ExecuteAtomicToolCallOptions,
): Promise<ResultType<unknown, InvalidToolInputError>> {
  if (options.inputValidation.type === "prevalidated") return Result.ok(options.call.input);
  if (options.inputValidation.type === "invalid") {
    return Result.err(
      new InvalidToolInputError({
        toolName: options.call.toolName,
        toolInput: stringifyToolInput(options.call.input),
        cause: options.inputValidation.error,
        message: invalidInputMessage(options.inputValidation.error),
      }),
    );
  }

  const tool = options.tools[options.call.toolName];
  if (!tool) {
    return Result.err(
      new InvalidToolInputError({
        toolName: options.call.toolName,
        toolInput: stringifyToolInput(options.call.input),
        cause: undefined,
        message: `Tool not found: ${options.call.toolName}`,
      }),
    );
  }

  const schema = asSchema(tool.inputSchema);
  if (!schema.validate) return Result.ok(options.call.input);

  let validation: Awaited<ReturnType<NonNullable<typeof schema.validate>>>;
  try {
    validation = await schema.validate(options.call.input);
  } catch (error) {
    rethrowAgentPanic(error);
    return Result.err(
      new InvalidToolInputError({
        toolName: options.call.toolName,
        toolInput: stringifyToolInput(options.call.input),
        cause: error,
      }),
    );
  }
  if (!validation.success) {
    return Result.err(
      new InvalidToolInputError({
        toolName: options.call.toolName,
        toolInput: stringifyToolInput(options.call.input),
        cause: validation.error,
      }),
    );
  }
  return Result.ok(validation.value);
}

export async function normalizeToolResultOutput(
  output: ToolResultOutput,
  context: Parameters<NormalizeToolResultOutputFn>[1],
  normalize?: NormalizeToolResultOutputFn,
): Promise<ToolResultOutput> {
  if (!normalize) return output;

  try {
    return await normalize(output, context);
  } catch (error) {
    rethrowAgentPanic(error);
    logger.warn("tool result normalization failed", {
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      error: errorMessage(error),
    });
    return { type: "error-text", value: UNSERIALIZABLE_TOOL_RESULT };
  }
}

async function settleAtomicToolCallImpl(
  options: ExecuteAtomicToolCallOptions,
): Promise<AtomicToolExecutionOutcome> {
  const { call } = options;
  const tool = options.tools[call.toolName];
  const assertNotAborted =
    options.assertNotAborted ?? (() => options.abortSignal?.throwIfAborted());

  options.pendingToolCalls.add(call.toolCallId);
  options.onEvent?.({
    type: "tool_execution_start",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.input,
  });
  assertNotAborted();

  let result: unknown;
  let isError = false;
  let toolOutput: ToolResultOutput;
  let expansion: ToolExpansion | undefined;
  let outcome: AtomicToolExecutionOutcomeKind = "success";

  try {
    if (options.executionRejection) {
      isError = true;
      outcome = "error";
      result = options.executionRejection;
      toolOutput = { type: "error-text", value: options.executionRejection };
    } else if (options.inputValidation.type === "invalid") {
      isError = true;
      outcome = "invalid-input";
      const message = invalidInputMessage(options.inputValidation.error);
      result = message;
      toolOutput = { type: "error-text", value: message };
    } else if (!tool) {
      const message = `Tool not found: ${call.toolName}`;
      isError = true;
      outcome = "error";
      result = message;
      toolOutput = { type: "error-text", value: message };
    } else {
      assertNotAborted();
      const validatedInput = await validateInput(options);
      const validationError = validatedInput.match({ ok: () => null, err: (error) => error });
      if (validationError) {
        isError = true;
        outcome = "invalid-input";
        result = validationError.message;
        toolOutput = { type: "error-text", value: validationError.message };
      } else {
        const input = validatedInput.match({ ok: (value) => value, err: () => call.input });
        assertNotAborted();

        const needsApproval =
          typeof tool.needsApproval === "function"
            ? await tool.needsApproval(input, {
                toolCallId: call.toolCallId,
                messages: options.messages,
                context: options.context,
              })
            : Boolean(tool.needsApproval);
        assertNotAborted();

        if (needsApproval) {
          isError = true;
          outcome = "denied";
          result = { denied: true };
          toolOutput = {
            type: "execution-denied",
            reason: "Tool requires approval.",
          };
        } else if (!tool.execute) {
          const message = `Tool has no execute(): ${call.toolName}`;
          isError = true;
          outcome = "error";
          result = message;
          toolOutput = { type: "error-text", value: message };
        } else {
          assertNotAborted();
          const raw = tool.execute(input, {
            toolCallId: call.toolCallId,
            messages: options.messages,
            abortSignal: options.abortSignal,
            context: options.context,
          });

          let rawResult: unknown;
          let streamFailure: AtomicToolStreamError | undefined;
          if (isAsyncIterable(raw)) {
            const streamed = await consumeAtomicToolResultStream(raw, (partialResult) => {
              assertNotAborted();
              options.onEvent?.({
                type: "tool_execution_update",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: call.input,
                partialResult,
              });
              assertNotAborted();
            });
            streamed.match({
              err: (error) => {
                streamFailure = error;
              },
              ok: (value) => {
                rawResult = value;
              },
            });
          } else {
            rawResult = await raw;
          }
          assertNotAborted();

          if (streamFailure) {
            isError = true;
            outcome = "error";
            result = streamFailure.message;
            toolOutput = { type: "error-text", value: streamFailure.message };
          } else if (isToolExpansion(rawResult)) {
            if (options.expansionHandling.type === "reject") {
              const message =
                options.expansionHandling.message ?? "Tool-call expansions are not supported.";
              isError = true;
              outcome = "error";
              result = message;
              toolOutput = { type: "error-text", value: message };
            } else {
              expansion = rawResult;
              result = rawResult.result;
              toolOutput = { type: "json", value: toJsonToolOutputValue(result) };
            }
          } else {
            result = rawResult;
            toolOutput = tool.toModelOutput
              ? await tool.toModelOutput({
                  toolCallId: call.toolCallId,
                  input,
                  output: result,
                })
              : { type: "json", value: toJsonToolOutputValue(result) };
            assertNotAborted();
          }
        }
      }
    }
  } catch (error) {
    rethrowAgentPanic(error);
    assertNotAborted();
    isError = true;
    const message = errorMessage(error);
    outcome =
      isInvalidToolInputError(error) || message.includes("AI_InvalidToolInputError")
        ? "invalid-input"
        : "error";
    result = message;
    toolOutput = {
      type: "error-text",
      value: message,
    };
  }

  assertNotAborted();
  return {
    result,
    isError,
    toolOutput,
    outcome,
    ...(expansion ? { expansion } : {}),
  };
}

function cleanupFailedAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
  error: unknown,
): ResultType<void, AtomicToolTerminalCleanupFailed> {
  if (!options.pendingToolCalls.delete(options.call.toolCallId)) return Result.ok(undefined);

  const message = errorMessage(error);
  try {
    options.onEvent?.({
      type: "tool_execution_end",
      toolCallId: options.call.toolCallId,
      toolName: options.call.toolName,
      args: options.call.input,
      result: message,
      isError: true,
      output: { type: "error-text", value: message },
      outcome: "error",
    });
    return Result.ok(undefined);
  } catch (cause) {
    return Result.err(
      new AtomicToolTerminalCleanupFailed({
        cause,
        message: `Atomic tool terminal event failed: ${errorMessage(cause)}`,
      }),
    );
  }
}

type AtomicToolFailureAfterCleanup =
  | { readonly type: "panic"; readonly panic: Panic }
  | { readonly type: "error"; readonly error: OpaqueAgentValue };

function resolveAtomicToolFailureAfterCleanup(
  options: ExecuteAtomicToolCallOptions,
  operationError: OpaqueAgentValue,
): AtomicToolFailureAfterCleanup {
  const cleanup = cleanupFailedAtomicToolCall(options, operationError);
  if (isAgentPanic(operationError)) return { type: "panic", panic: operationError };
  return cleanup.match({
    ok: () => ({ type: "error", error: operationError }),
    err: (error): AtomicToolFailureAfterCleanup =>
      isAgentPanic(error.cause)
        ? { type: "panic", panic: error.cause }
        : {
            type: "error",
            error: new AtomicToolOperationAndCleanupError(operationError, error),
          },
  });
}

/** Execute through raw output conversion, leaving normalization and the terminal event deferred. */
export async function settleAtomicToolCallResult(
  options: ExecuteAtomicToolCallOptions,
): Promise<ResultType<AtomicToolExecutionOutcome, AtomicToolExecutionFailed>> {
  try {
    return Result.ok(await settleAtomicToolCallImpl(options));
  } catch (error) {
    const failure = resolveAtomicToolFailureAfterCleanup(options, error);
    if (failure.type === "panic") rethrowAgentPanic(failure.panic);
    return Result.err(
      new AtomicToolExecutionFailed({
        cause: failure.error,
        message: errorMessage(failure.error),
      }),
    );
  }
}

function signalAtomicToolExecutionHost(error: AtomicToolExecutionFailed): never {
  throw error.cause;
}

function atomicToolResultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

/** Compatibility adapter for callers bound to the AI SDK's rejecting tool contract. */
export async function settleAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
): Promise<AtomicToolExecutionOutcome> {
  const result = atomicToolResultOutcome(await settleAtomicToolCallResult(options));
  if (!result.ok) return signalAtomicToolExecutionHost(result.error);
  return result.value;
}

/** Complete a settled call with its chosen model-facing output. */
export function finalizeSettledAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
  settled: AtomicToolExecutionOutcome,
  toolOutput: ToolResultOutput,
): AtomicToolExecutionOutcome {
  options.pendingToolCalls.delete(options.call.toolCallId);
  options.onEvent?.({
    type: "tool_execution_end",
    toolCallId: options.call.toolCallId,
    toolName: options.call.toolName,
    args: options.call.input,
    result: settled.result,
    isError: settled.isError,
    output: toolOutput,
    outcome: settled.outcome,
  });

  return { ...settled, toolOutput };
}

export async function executeAtomicToolCallResult(
  options: ExecuteAtomicToolCallOptions,
): Promise<ResultType<AtomicToolExecutionOutcome, AtomicToolExecutionFailed>> {
  try {
    const settled = atomicToolResultOutcome(await settleAtomicToolCallResult(options));
    if (!settled.ok) return Result.err(settled.error);
    const toolOutput = await normalizeToolResultOutput(
      settled.value.toolOutput,
      {
        toolCallId: options.call.toolCallId,
        toolName: options.call.toolName,
        ...(options.bypassGenericOutputNormalizer === undefined
          ? {}
          : { bypassGenericOutputNormalizer: options.bypassGenericOutputNormalizer }),
        ...(options.aggregateOutputBudgetExempt === undefined
          ? {}
          : { aggregateOutputBudgetExempt: options.aggregateOutputBudgetExempt }),
      },
      options.normalizeToolResultOutput,
    );
    (options.assertNotAborted ?? (() => options.abortSignal?.throwIfAborted()))();
    return Result.ok(finalizeSettledAtomicToolCall(options, settled.value, toolOutput));
  } catch (error) {
    const failure = resolveAtomicToolFailureAfterCleanup(options, error);
    if (failure.type === "panic") rethrowAgentPanic(failure.panic);
    return Result.err(
      new AtomicToolExecutionFailed({
        cause: failure.error,
        message: errorMessage(failure.error),
      }),
    );
  }
}

export async function executeAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
): Promise<AtomicToolExecutionOutcome> {
  const result = atomicToolResultOutcome(await executeAtomicToolCallResult(options));
  if (!result.ok) return signalAtomicToolExecutionHost(result.error);
  return result.value;
}
