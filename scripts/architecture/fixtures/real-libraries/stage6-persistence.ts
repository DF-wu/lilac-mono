import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

type FixtureProvenance = "current" | "migrated" | "missing-defaulted";

type FixtureDecoded<T, P extends FixtureProvenance = FixtureProvenance> = {
  readonly value: T;
  readonly provenance: P;
};

class FixtureMalformed extends TaggedError("FixtureMalformed")<{
  readonly message: string;
}> {}

class FixtureUnsupported extends TaggedError("FixtureUnsupported")<{
  readonly message: string;
}> {}

class FixtureCorrupt extends TaggedError("FixtureCorrupt")<{
  readonly message: string;
}> {}

type FixtureStorageError = FixtureMalformed | FixtureUnsupported | FixtureCorrupt;

const currentStringArraySchema = z.object({ version: z.literal(1), value: z.array(z.string()) });
const currentImportanceSchema = z.object({
  version: z.literal(1),
  value: z.enum(["low", "medium", "high"]),
});
const aboutnessSchema = z.object({
  domains: z.array(z.string()),
  situations: z.array(z.string()),
});
const currentAboutnessSchema = z.object({ version: z.literal(1), value: aboutnessSchema });

function parseJson(raw: string): ResultType<unknown, FixtureMalformed> {
  return Result.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new FixtureMalformed({ message: "malformed persisted fixture" }),
  });
}

export function decodeFixtureStringArray(
  raw: string | null,
): ResultType<FixtureDecoded<readonly string[]>, FixtureStorageError> {
  if (raw === null) return Result.ok({ value: [], provenance: "missing-defaulted" });
  const parsed = parseJson(raw);
  if (parsed.status === "error") return Result.err(parsed.error);
  if (Array.isArray(parsed.value)) {
    const legacy = z.array(z.string()).safeParse(parsed.value);
    return legacy.success
      ? Result.ok({ value: legacy.data, provenance: "migrated" })
      : Result.err(new FixtureCorrupt({ message: "corrupt string array fixture" }));
  }
  const current = currentStringArraySchema.safeParse(parsed.value);
  if (current.success) return Result.ok({ value: current.data.value, provenance: "current" });
  if (
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    "version" in parsed.value &&
    parsed.value.version !== 1
  ) {
    return Result.err(new FixtureUnsupported({ message: "unsupported fixture version" }));
  }
  return Result.err(new FixtureCorrupt({ message: "corrupt string array fixture" }));
}

export function decodeFixtureImportance(
  raw: string | null,
): ResultType<FixtureDecoded<"low" | "medium" | "high">, FixtureStorageError> {
  if (raw === null) return Result.ok({ value: "medium", provenance: "missing-defaulted" });
  if (raw === "low" || raw === "medium" || raw === "high") {
    return Result.ok({ value: raw, provenance: "migrated" });
  }
  const parsed = parseJson(raw);
  if (parsed.status === "error") return Result.err(parsed.error);
  const current = currentImportanceSchema.safeParse(parsed.value);
  if (current.success) return Result.ok({ value: current.data.value, provenance: "current" });
  if (typeof parsed.value === "object" && parsed.value !== null && "version" in parsed.value) {
    return Result.err(new FixtureUnsupported({ message: "unsupported fixture version" }));
  }
  return Result.err(new FixtureCorrupt({ message: "corrupt importance fixture" }));
}

export function decodeFixtureAboutness(
  raw: string | null,
): ResultType<
  FixtureDecoded<{ readonly domains: readonly string[]; readonly situations: readonly string[] }>,
  FixtureStorageError
> {
  const empty = { domains: [], situations: [] };
  if (raw === null) return Result.ok({ value: empty, provenance: "missing-defaulted" });
  const parsed = parseJson(raw);
  if (parsed.status === "error") return Result.err(parsed.error);
  const legacy = aboutnessSchema.safeParse(parsed.value);
  if (legacy.success) return Result.ok({ value: legacy.data, provenance: "migrated" });
  const current = currentAboutnessSchema.safeParse(parsed.value);
  if (current.success) return Result.ok({ value: current.data.value, provenance: "current" });
  if (typeof parsed.value === "object" && parsed.value !== null && "version" in parsed.value) {
    return Result.err(new FixtureUnsupported({ message: "unsupported fixture version" }));
  }
  return Result.err(new FixtureCorrupt({ message: "corrupt aboutness fixture" }));
}

export function decodeFixtureBytes(
  raw: string | null,
): ResultType<FixtureDecoded<Uint8Array | URL>, FixtureStorageError> {
  if (raw === null) return Result.ok({ value: new Uint8Array(), provenance: "missing-defaulted" });
  if (raw === "legacy") {
    return Result.ok({ value: new Uint8Array([1]), provenance: "migrated" });
  }
  if (raw === "current") {
    return Result.ok({ value: new URL("https://example.test/current"), provenance: "current" });
  }
  if (raw === "unsupported") {
    return Result.err(new FixtureUnsupported({ message: "unsupported bytes fixture" }));
  }
  if (raw === "malformed") {
    return Result.err(new FixtureMalformed({ message: "malformed bytes fixture" }));
  }
  return Result.err(new FixtureCorrupt({ message: "corrupt bytes fixture" }));
}

export function decodeRequiredFixture(
  raw: string | null,
): ResultType<FixtureDecoded<string, "current" | "migrated">, FixtureStorageError> {
  if (raw === null)
    return Result.err(new FixtureCorrupt({ message: "required fixture is absent" }));
  if (raw === "legacy") return Result.ok({ value: raw, provenance: "migrated" });
  if (raw === "current") return Result.ok({ value: raw, provenance: "current" });
  if (raw === "unsupported") {
    return Result.err(new FixtureUnsupported({ message: "unsupported required fixture" }));
  }
  if (raw === "malformed") {
    return Result.err(new FixtureMalformed({ message: "malformed required fixture" }));
  }
  return Result.err(new FixtureCorrupt({ message: "corrupt required fixture" }));
}

export const fixtureStringArrayCases = {
  current: { input: '{"version":1,"value":["a"]}', outcome: "ok", provenance: "current" },
  legacy: { input: '["a"]', outcome: "ok", provenance: "migrated" },
  "missing-defaulted": { input: null, outcome: "ok", provenance: "missing-defaulted" },
  "unsupported-version": { input: '{"version":2,"value":[]}', outcome: "error" },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": { input: '{"version":1,"value":[1]}', outcome: "error" },
} as const;

export const fixtureImportanceCases = {
  current: { input: '{"version":1,"value":"high"}', outcome: "ok", provenance: "current" },
  legacy: { input: "low", outcome: "ok", provenance: "migrated" },
  "missing-defaulted": { input: null, outcome: "ok", provenance: "missing-defaulted" },
  "unsupported-version": { input: '{"version":2,"value":"high"}', outcome: "error" },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": { input: '{"version":1,"value":"urgent"}', outcome: "error" },
} as const;

export const fixtureAboutnessCases = {
  current: {
    input: '{"version":1,"value":{"domains":["runtime"],"situations":[]}}',
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: '{"domains":["runtime"],"situations":[]}',
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": { input: null, outcome: "ok", provenance: "missing-defaulted" },
  "unsupported-version": {
    input: '{"version":2,"value":{"domains":[],"situations":[]}}',
    outcome: "error",
  },
  "malformed-serialization": { input: "{", outcome: "error" },
  "corrupt-fields": {
    input: '{"version":1,"value":{"domains":[1],"situations":[]}}',
    outcome: "error",
  },
} as const;

export const fixtureBytesCases = {
  current: { input: "current", outcome: "ok", provenance: "current" },
  legacy: { input: "legacy", outcome: "ok", provenance: "migrated" },
  "missing-defaulted": { input: null, outcome: "ok", provenance: "missing-defaulted" },
  "unsupported-version": { input: "unsupported", outcome: "error" },
  "malformed-serialization": { input: "malformed", outcome: "error" },
  "corrupt-fields": { input: "corrupt", outcome: "error" },
} as const;

export const requiredFixtureCases = {
  current: { input: "current", outcome: "ok", provenance: "current" },
  legacy: { input: "legacy", outcome: "ok", provenance: "migrated" },
  "missing-defaulted": { input: null, outcome: "error" },
  "unsupported-version": { input: "unsupported", outcome: "error" },
  "malformed-serialization": { input: "malformed", outcome: "error" },
  "corrupt-fields": { input: "corrupt", outcome: "error" },
} as const;

export function consumeFixturePersistence(raw: string | null) {
  const decode = raw === null ? decodeFixtureStringArray : decodeFixtureStringArray;
  return decode(raw);
}

export function consumeFixturePersistenceInline(raw: string) {
  return currentStringArraySchema.safeParse(JSON.parse(raw));
}

export function decodeFixtureWithWrongProvenance(
  raw: string | null,
): ResultType<
  { readonly value: string; readonly provenance: "current" | "guessed" },
  FixtureStorageError
> {
  return Result.ok({ value: raw ?? "", provenance: "guessed" });
}

export const incompleteFixtureCases = {
  current: { input: "value", outcome: "ok", provenance: "current" },
  legacy: { input: "value", outcome: "ok", provenance: "current" },
} as const;
