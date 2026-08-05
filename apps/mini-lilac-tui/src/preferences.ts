import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { miniLilacReasoningSchema } from "@stanley2058/mini-lilac-client";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { captureTuiOperationAsync } from "./failure-adapter";

const bindingPreferenceSchema = z.object({
  model: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  reasoning: miniLilacReasoningSchema.optional(),
});

const bindingPreferencesSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), bindingPreferenceSchema),
});
const legacyBindingPreferencesSchema = bindingPreferencesSchema.omit({ version: true });

const preferenceVersionSchema = z.object({ version: z.number().int() });

export type BindingPreference = z.output<typeof bindingPreferenceSchema>;
export type BindingPreferences = z.output<typeof bindingPreferencesSchema>;

export interface BindingPreferencesRead {
  readonly preferences: BindingPreferences;
  readonly provenance: "current" | "migrated" | "missing-defaulted";
}

export interface DecodedBindingPreferences {
  readonly value: BindingPreferences;
  readonly provenance: "current" | "migrated" | "missing-defaulted";
}

export class BindingPreferencesMalformed extends TaggedError("BindingPreferencesMalformed")<{
  readonly filePath: string;
  readonly message: string;
}> {}

export class BindingPreferencesUnsupportedVersion extends TaggedError(
  "BindingPreferencesUnsupportedVersion",
)<{
  readonly filePath: string;
  readonly version: number;
  readonly message: string;
}> {}

export class BindingPreferencesCorrupt extends TaggedError("BindingPreferencesCorrupt")<{
  readonly filePath: string;
  readonly message: string;
}> {}

export class BindingPreferencesIoFailed extends TaggedError("BindingPreferencesIoFailed")<{
  readonly operation: "inspect" | "read" | "mkdir" | "write" | "rename" | "cleanup";
  readonly filePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BindingPreferencesWriteAndCleanupFailed extends TaggedError(
  "BindingPreferencesWriteAndCleanupFailed",
)<{
  readonly write: BindingPreferencesIoFailed;
  readonly cleanup: BindingPreferencesIoFailed;
  readonly message: string;
}> {}

export type BindingPreferencesLoadError =
  | BindingPreferencesMalformed
  | BindingPreferencesUnsupportedVersion
  | BindingPreferencesCorrupt
  | BindingPreferencesIoFailed;

export type BindingPreferencesDecodeError =
  | BindingPreferencesMalformed
  | BindingPreferencesUnsupportedVersion
  | BindingPreferencesCorrupt;

export function bindingPreferenceServerKey(server: string): string {
  return server.replace(/\/+$/u, "");
}

export function bindingPreferencesPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "mini-lilac", "preferences.json");
}

/** Decode the complete persisted preferences document with explicit version outcomes. */
export function decodeBindingPreferences(input: {
  readonly filePath: string;
  readonly serialized: string | null;
}): ResultType<DecodedBindingPreferences, BindingPreferencesDecodeError> {
  if (input.serialized === null) {
    return Result.ok({
      value: { version: 1, servers: {} },
      provenance: "missing-defaulted",
    });
  }
  const { filePath } = input;
  const serialized = input.serialized;
  const parsedJson = Result.try({
    try: () => JSON.parse(serialized),
    catch: () =>
      new BindingPreferencesMalformed({
        filePath,
        message: "Preferences are not valid JSON",
      }),
  });
  if (parsedJson.status === "error") {
    return Result.err(parsedJson.error);
  }
  const json: unknown = parsedJson.value;
  const version = preferenceVersionSchema.safeParse(json);
  if (!version.success) {
    const legacy = legacyBindingPreferencesSchema.safeParse(json);
    if (legacy.success) {
      return Result.ok({
        value: { version: 1, ...legacy.data },
        provenance: "migrated",
      });
    }
    return Result.err(
      new BindingPreferencesCorrupt({ filePath, message: "Preferences version is missing" }),
    );
  }
  if (version.data.version !== 1) {
    return Result.err(
      new BindingPreferencesUnsupportedVersion({
        filePath,
        version: version.data.version,
        message: `Unsupported preferences version ${version.data.version}`,
      }),
    );
  }
  const decoded = bindingPreferencesSchema.safeParse(json);
  if (!decoded.success) {
    return Result.err(
      new BindingPreferencesCorrupt({ filePath, message: "Preferences fields are invalid" }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: "current" });
}

const PREFERENCES_FIXTURE_PATH = "/fixture/preferences.json";
const PREFERENCES_FIXTURE_VALUE = {
  version: 1,
  servers: { local: { model: "provider/model", reasoning: "high" } },
} as const;

export const bindingPreferencesCodecCases = {
  current: {
    input: {
      filePath: PREFERENCES_FIXTURE_PATH,
      serialized: JSON.stringify(PREFERENCES_FIXTURE_VALUE),
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      filePath: PREFERENCES_FIXTURE_PATH,
      serialized: JSON.stringify({ servers: {} }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { filePath: PREFERENCES_FIXTURE_PATH, serialized: null },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      filePath: PREFERENCES_FIXTURE_PATH,
      serialized: JSON.stringify({ version: 2, servers: {} }),
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { filePath: PREFERENCES_FIXTURE_PATH, serialized: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      filePath: PREFERENCES_FIXTURE_PATH,
      serialized: JSON.stringify({ version: 1, servers: { local: { reasoning: "extreme" } } }),
    },
    outcome: "error",
  },
} as const;

async function bindingPreferencesFileExists(
  filePath: string,
): Promise<ResultType<boolean, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    () => Bun.file(filePath).exists(),
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "inspect",
        filePath,
        cause,
        message: "Could not inspect TUI preferences",
      }),
  );
}

async function readBindingPreferencesFile(
  filePath: string,
): Promise<ResultType<string, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    () => Bun.file(filePath).text(),
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "read",
        filePath,
        cause,
        message: "Could not read TUI preferences",
      }),
  );
}

async function createBindingPreferencesDirectory(
  filePath: string,
): Promise<ResultType<void, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
    },
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "mkdir",
        filePath,
        cause,
        message: "Could not create the TUI preferences directory",
      }),
  );
}

async function writeBindingPreferencesFile(
  filePath: string,
  text: string,
): Promise<ResultType<void, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await Bun.write(filePath, text);
    },
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "write",
        filePath,
        cause,
        message: "Could not write temporary TUI preferences",
      }),
  );
}

async function renameBindingPreferencesFile(
  temporaryPath: string,
  filePath: string,
): Promise<ResultType<void, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await rename(temporaryPath, filePath);
    },
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "rename",
        filePath,
        cause,
        message: "Could not replace TUI preferences",
      }),
  );
}

async function removeTemporaryBindingPreferences(
  filePath: string,
): Promise<ResultType<void, BindingPreferencesIoFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await rm(filePath, { force: true });
    },
    (cause) =>
      new BindingPreferencesIoFailed({
        operation: "cleanup",
        filePath,
        cause,
        message: "Could not clean up temporary TUI preferences",
      }),
  );
}

export async function loadBindingPreferences(
  filePath: string,
): Promise<ResultType<BindingPreferencesRead, BindingPreferencesLoadError>> {
  const exists = await bindingPreferencesFileExists(filePath);
  if (exists.status === "error") return Result.err(exists.error);
  let text: string | undefined;
  if (exists.value) {
    const read = await readBindingPreferencesFile(filePath);
    if (read.status === "error") return Result.err(read.error);
    text = read.value;
  }
  const decoded = decodeBindingPreferences({ filePath, serialized: text ?? null });
  if (decoded.status === "error") return Result.err(decoded.error);
  return Result.ok({
    preferences: decoded.value.value,
    provenance: decoded.value.provenance,
  });
}

export async function saveBindingPreferences(
  filePath: string,
  preferences: BindingPreferences,
): Promise<ResultType<void, BindingPreferencesIoFailed | BindingPreferencesWriteAndCleanupFailed>> {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const directory = await createBindingPreferencesDirectory(filePath);
  if (directory.status === "error") return Result.err(directory.error);
  const written = await writeBindingPreferencesFile(
    temporaryPath,
    `${JSON.stringify(preferences, null, 2)}\n`,
  );
  let writeFailure: BindingPreferencesIoFailed | undefined =
    written.status === "error" ? written.error : undefined;
  if (writeFailure === undefined) {
    const renamed = await renameBindingPreferencesFile(temporaryPath, filePath);
    if (renamed.status === "error") writeFailure = renamed.error;
  }
  if (writeFailure === undefined) return Result.ok(undefined);
  const cleaned = await removeTemporaryBindingPreferences(temporaryPath);
  if (cleaned.status === "error") {
    return Result.err(
      new BindingPreferencesWriteAndCleanupFailed({
        write: writeFailure,
        cleanup: cleaned.error,
        message: `${writeFailure.message}; ${cleaned.error.message}`,
      }),
    );
  }
  return Result.err(writeFailure);
}
