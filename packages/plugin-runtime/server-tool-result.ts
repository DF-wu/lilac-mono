import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { invalidHookResult } from "./capabilities";
import type { ServerToolFailure, ServerToolJsonValue, ServerToolResult } from "./types";
import type { ToolPluginCapabilityError } from "./errors";

const jsonValueSchema: z.ZodType<ServerToolJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const serverToolFailureSchema: z.ZodType<ServerToolFailure> = z
  .object({
    kind: z.enum([
      "usage",
      "denied",
      "not_found",
      "conflict",
      "unavailable",
      "timeout",
      "cancelled",
      "internal",
    ]),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict();

const resultProtocolSchema = {
  isOk: z.function(),
  isErr: z.function(),
  map: z.function(),
  mapError: z.function(),
  tryRecover: z.function(),
  tryRecoverAsync: z.function(),
  andThen: z.function(),
  andThenAsync: z.function(),
  match: z.function(),
  unwrap: z.function(),
  unwrapOr: z.function(),
  tap: z.function(),
  tapAsync: z.function(),
  tapError: z.function(),
  tapErrorAsync: z.function(),
  tapBoth: z.function(),
  tapBothAsync: z.function(),
};

const serverToolResultSchema: z.ZodType<ServerToolResult> = z.union([
  z
    .strictObject({
      status: z.literal("ok"),
      value: z.unknown(),
      ...resultProtocolSchema,
    })
    .transform((result) => Result.ok(result.value)),
  z
    .strictObject({
      status: z.literal("error"),
      error: z.unknown(),
      ...resultProtocolSchema,
    })
    .transform((result, context) => {
      const failure = serverToolFailureSchema.safeParse(result.error);
      if (failure.success) return Result.err(failure.data);
      context.addIssue({
        code: "custom",
        message: "Expected a valid ServerToolFailure",
      });
      return z.NEVER;
    }),
]);

export function decodeServerToolResult(
  pluginId: string,
  value: unknown,
): ResultType<ServerToolResult, ToolPluginCapabilityError> {
  const parsed = serverToolResultSchema.safeParse(value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
}
