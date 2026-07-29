import {
  asSchema,
  InvalidToolInputError,
  type ModelMessage,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import { createLogger, errorMessage } from "@stanley2058/lilac-utils";

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
  | { type: "invalid"; error?: unknown }
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
      } catch {
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
  } catch {
    // Fall through to the stable string representation.
  }

  return String(value);
}

function stringifyToolInput(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function invalidInputMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error) return stringifyToolInput(error);
  return "Invalid tool input.";
}

async function validateInput(options: ExecuteAtomicToolCallOptions): Promise<unknown> {
  if (options.inputValidation.type === "prevalidated") return options.call.input;
  if (options.inputValidation.type === "invalid") {
    throw new InvalidToolInputError({
      toolName: options.call.toolName,
      toolInput: stringifyToolInput(options.call.input),
      cause: options.inputValidation.error,
      message: invalidInputMessage(options.inputValidation.error),
    });
  }

  const tool = options.tools[options.call.toolName];
  if (!tool) throw new Error(`Tool not found: ${options.call.toolName}`);

  const schema = asSchema(tool.inputSchema);
  if (!schema.validate) return options.call.input;

  let validation: Awaited<ReturnType<NonNullable<typeof schema.validate>>>;
  try {
    validation = await schema.validate(options.call.input);
  } catch (error) {
    throw new InvalidToolInputError({
      toolName: options.call.toolName,
      toolInput: stringifyToolInput(options.call.input),
      cause: error,
    });
  }
  if (!validation.success) {
    throw new InvalidToolInputError({
      toolName: options.call.toolName,
      toolInput: stringifyToolInput(options.call.input),
      cause: validation.error,
    });
  }
  return validation.value;
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
      throw new Error(`Tool not found: ${call.toolName}`);
    } else {
      assertNotAborted();
      const input = await validateInput(options);
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
        throw new Error(`Tool has no execute(): ${call.toolName}`);
      } else {
        assertNotAborted();
        const raw = tool.execute(input, {
          toolCallId: call.toolCallId,
          messages: options.messages,
          abortSignal: options.abortSignal,
          context: options.context,
        });

        let rawResult: unknown;
        if (isAsyncIterable(raw)) {
          let last: unknown = undefined;
          const iterator = raw[Symbol.asyncIterator]();
          let completed = false;
          try {
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                completed = true;
                rawResult = next.value === undefined ? last : next.value;
                break;
              }
              assertNotAborted();
              last = next.value;
              options.onEvent?.({
                type: "tool_execution_update",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: call.input,
                partialResult: next.value,
              });
              assertNotAborted();
            }
          } finally {
            if (!completed) await iterator.return?.();
          }
        } else {
          rawResult = await raw;
        }
        assertNotAborted();

        if (isToolExpansion(rawResult)) {
          if (options.expansionHandling.type === "reject") {
            throw new Error(
              options.expansionHandling.message ?? "Tool-call expansions are not supported.",
            );
          }
          expansion = rawResult;
          result = rawResult.result;
          toolOutput = { type: "json", value: toJsonToolOutputValue(result) };
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
  } catch (error) {
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

function cleanupFailedAtomicToolCall(options: ExecuteAtomicToolCallOptions, error: unknown): void {
  if (!options.pendingToolCalls.delete(options.call.toolCallId)) return;

  const message = errorMessage(error);
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
}

/** Execute through raw output conversion, leaving normalization and the terminal event deferred. */
export async function settleAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
): Promise<AtomicToolExecutionOutcome> {
  try {
    return await settleAtomicToolCallImpl(options);
  } catch (error) {
    cleanupFailedAtomicToolCall(options, error);
    throw error;
  }
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

export async function executeAtomicToolCall(
  options: ExecuteAtomicToolCallOptions,
): Promise<AtomicToolExecutionOutcome> {
  try {
    const settled = await settleAtomicToolCall(options);
    const toolOutput = await normalizeToolResultOutput(
      settled.toolOutput,
      {
        toolCallId: options.call.toolCallId,
        toolName: options.call.toolName,
        ...(options.bypassGenericOutputNormalizer === undefined
          ? {}
          : { bypassGenericOutputNormalizer: options.bypassGenericOutputNormalizer }),
      },
      options.normalizeToolResultOutput,
    );
    (options.assertNotAborted ?? (() => options.abortSignal?.throwIfAborted()))();
    return finalizeSettledAtomicToolCall(options, settled, toolOutput);
  } catch (error) {
    cleanupFailedAtomicToolCall(options, error);
    throw error;
  }
}
