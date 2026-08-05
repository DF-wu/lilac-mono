import { TaggedError } from "better-result";
import {
  formatTaggedErrorForLog,
  redactErrorTextForLog,
  type TaggedErrorLogProjection,
} from "@stanley2058/lilac-utils";

export type BridgeLogValue = string | number | boolean | null | undefined;
export type BridgeLogContext = Readonly<Record<string, BridgeLogValue>>;

export function formatBridgeLogContext(context: BridgeLogContext): BridgeLogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "string" ? redactErrorTextForLog(value) : value,
    ]),
  );
}

export function formatBridgeTaggedErrorForLog(
  error: unknown,
  context: BridgeLogContext = {},
  fallback: TaggedErrorLogProjection = {
    errorTag: "UnknownBridgeFailure",
    errorMessage: "Unknown bridge failure",
  },
): BridgeLogContext & TaggedErrorLogProjection {
  const formattedContext = formatBridgeLogContext(context);
  try {
    if (TaggedError.is(error)) {
      return { ...formattedContext, ...formatTaggedErrorForLog(error) };
    }
  } catch {
    // Logging must not replace the bridge failure being reported.
  }
  return {
    ...formattedContext,
    errorTag: redactErrorTextForLog(fallback.errorTag),
    errorMessage: redactErrorTextForLog(fallback.errorMessage),
  };
}
