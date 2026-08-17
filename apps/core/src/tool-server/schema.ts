import { z } from "zod";

import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";

const PrimaryPositionalSchema = z.object({
  field: z.string(),
  variadic: z.boolean().optional(),
});

export const BridgeListResponse = z.object({
  tools: z.array(
    z.object({
      callableId: z.string(),
      name: z.string(),
      description: z.string(),
      shortInput: z.array(z.string()),
      primaryPositional: PrimaryPositionalSchema.optional(),
      hidden: z.boolean().optional(),
    }),
  ),
});

export const BridgeVersionResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  commit: z.string(),
  dirty: z.boolean().optional(),
  builtAt: z.string().optional(),
  plugins: z
    .object({
      loadedExternal: z.number().int().nonnegative(),
    })
    .optional(),
  startedAt: z.number(),
  pid: z.number(),
});

export const BridgeFnHelpRequest = z.object({
  callableId: z.string(),
});

export const BridgeFnHelpResponse = z.object({
  callableId: z.string(),
  name: z.string(),
  description: z.string(),
  shortInput: z.array(z.string()),
  input: z.array(z.string()),
  primaryPositional: PrimaryPositionalSchema.optional(),
  hidden: z.boolean().optional(),
});

export const BridgeFnRequest = z.object({
  callableId: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const ServerToolFailureSchema: z.ZodType<ServerToolFailure> = z
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
    details: z.json().optional(),
  })
  .strict();

export const BridgeFnResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), value: z.json() }).strict(),
  z.object({ status: z.literal("error"), error: ServerToolFailureSchema }).strict(),
]);
