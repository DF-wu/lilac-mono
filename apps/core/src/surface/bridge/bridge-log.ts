import { Result, TaggedError } from "better-result";
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
  const formatted = Result.try({
    try: () =>
      TaggedError.is(error) ? { ...formattedContext, ...formatTaggedErrorForLog(error) } : null,
    catch: () => null,
  });
  const projection = formatted.match({ ok: (value) => value, err: () => null });
  if (projection) return projection;
  return {
    ...formattedContext,
    errorTag: redactErrorTextForLog(fallback.errorTag),
    errorMessage: redactErrorTextForLog(fallback.errorMessage),
  };
}
