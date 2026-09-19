import { Result, TaggedError } from "better-result";
import { z } from "zod";
import { replayCheckpointSchema, turnSlotSchema } from "@stanley2058/lilac-client-protocol";

export class TuiPersistedError extends TaggedError("TuiPersistedError")<{
  issueCode:
    | "unsupported-version"
    | "malformed-json"
    | "missing-required-field"
    | "invalid-row-field";
  message: string;
}> {}
export const cacheFileSchema = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      z.strictObject({
        key: z.string(),
        scope: z.string(),
        updatedAt: z.number().int().nonnegative(),
        checkpoint: replayCheckpointSchema,
        slots: z.array(
          z.strictObject({ revision: z.number().int().nonnegative(), slot: turnSlotSchema }),
        ),
      }),
    )
    .max(64),
});
export const credentialSchema = z.strictObject({
  version: z.literal(1),
  baseUrl: z.url(),
  provider: z.enum(["local", "clerk"]),
  token: z.string().min(1),
  expiresAt: z.number().positive(),
  refreshToken: z.string().optional(),
  issuer: z.url().optional(),
  clientId: z.string().optional(),
});
export type CacheFile = z.infer<typeof cacheFileSchema>;
export type TuiCredential = z.infer<typeof credentialSchema>;
export type TuiPersistedRow = { version: number; data: string | null };
function decode<T>(
  row: TuiPersistedRow,
  schema: z.ZodType<T>,
): Result<{ value: T; provenance: "current" }, TuiPersistedError> {
  if (row.version !== 1)
    return Result.err(
      new TuiPersistedError({
        issueCode: "unsupported-version",
        message: "Unsupported TUI cache version",
      }),
    );
  if (row.data === null)
    return Result.err(
      new TuiPersistedError({ issueCode: "missing-required-field", message: "Missing TUI data" }),
    );
  const data = row.data;
  return Result.try({
    try: (): unknown => JSON.parse(data),
    catch: () =>
      new TuiPersistedError({ issueCode: "malformed-json", message: "Invalid TUI serialization" }),
  }).andThen((value) => {
    if (typeof value === "object" && value !== null && "version" in value && value.version !== 1)
      return Result.err(
        new TuiPersistedError({
          issueCode: "unsupported-version",
          message: "Unsupported TUI file version",
        }),
      );
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return Result.err(
        new TuiPersistedError({ issueCode: "invalid-row-field", message: "Invalid TUI fields" }),
      );
    return Result.ok({ value: parsed.data, provenance: "current" as const });
  });
}
export function decodeTuiCache(
  row: TuiPersistedRow,
): Result<{ value: CacheFile; provenance: "current" }, TuiPersistedError> {
  return decode(row, cacheFileSchema);
}
export function decodeTuiCredential(
  row: TuiPersistedRow,
): Result<{ value: TuiCredential; provenance: "current" }, TuiPersistedError> {
  return decode(row, credentialSchema);
}
const cacheCurrent = { version: 1, data: JSON.stringify({ version: 1, entries: [] }) };
const credentialCurrent = {
  version: 1,
  data: JSON.stringify({
    version: 1,
    baseUrl: "https://example.test",
    provider: "local",
    token: "fixture",
    expiresAt: 1,
  }),
};
export const tuiCacheCodecCases = {
  current: { input: cacheCurrent, outcome: "ok", provenance: "current" },
  legacy: {
    input: { ...cacheCurrent, version: 0 },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "unsupported-version",
  },
  "missing-defaulted": {
    input: { ...cacheCurrent, data: null },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "missing-required-field",
  },
  "unsupported-version": {
    input: { ...cacheCurrent, version: 2 },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "unsupported-version",
  },
  "malformed-serialization": {
    input: { ...cacheCurrent, data: "{" },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "malformed-json",
  },
  "corrupt-fields": {
    input: { ...cacheCurrent, data: "{}" },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "invalid-row-field",
  },
} as const;
export const tuiCredentialCodecCases = {
  current: { input: credentialCurrent, outcome: "ok", provenance: "current" },
  legacy: {
    input: { ...credentialCurrent, version: 0 },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "unsupported-version",
  },
  "missing-defaulted": {
    input: { ...credentialCurrent, data: null },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "missing-required-field",
  },
  "unsupported-version": {
    input: { ...credentialCurrent, version: 2 },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "unsupported-version",
  },
  "malformed-serialization": {
    input: { ...credentialCurrent, data: "{" },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "malformed-json",
  },
  "corrupt-fields": {
    input: { ...credentialCurrent, data: "{}" },
    outcome: "error",
    errorTag: "TuiPersistedError",
    issueCode: "invalid-row-field",
  },
} as const;
