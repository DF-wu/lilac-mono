import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { ToolContent } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  errorCode,
  isPanic,
  isRecord,
  opaqueErrorCause,
  opaqueErrorMessage,
} from "./runtime-utils";
import { formatTaggedErrorForLog } from "./tagged-error-log";

export const CUSTOM_COMMAND_TEXT_PREFIX = "lilac:";
export const CUSTOM_COMMAND_TOOL_NAME = "custom_command";
export const CUSTOM_COMMAND_PROMPT_ARG_KEY = "prompt";

const COMMAND_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_ARG_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const customCommandArgSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(COMMAND_ARG_KEY_RE, "arg key must be lowercase letters/numbers with hyphen separators"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().trim().min(1).max(100).optional(),
  required: z.boolean().optional().default(false),
  choices: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const customCommandDefSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(COMMAND_NAME_RE, "name must be lowercase letters/numbers with hyphen separators"),
    description: z.string().trim().min(1).max(100),
    args: z.array(customCommandArgSchema).max(24).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.args.length; i += 1) {
      const key = value.args[i]?.key;
      if (!key) continue;
      if (key === CUSTOM_COMMAND_PROMPT_ARG_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "key"],
          message: `'${CUSTOM_COMMAND_PROMPT_ARG_KEY}' is reserved for transcript prompts`,
        });
      }
      if (!seen.has(key)) {
        seen.add(key);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "key"],
          message: `duplicate arg key '${key}'`,
        });
      }

      const choices = value.args[i]?.choices;
      if (!choices) continue;
      if (value.args[i]?.type !== "string") {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "choices"],
          message: "choices are only supported for string args",
        });
      }

      const seenChoices = new Set<string>();
      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
        const choice = choices[choiceIndex];
        if (!choice) continue;
        if (!seenChoices.has(choice)) {
          seenChoices.add(choice);
          continue;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["args", i, "choices", choiceIndex],
          message: `duplicate choice '${choice}'`,
        });
      }
    }
  });

export type CustomCommandArgDef = z.infer<typeof customCommandArgSchema>;
export type CustomCommandDef = z.infer<typeof customCommandDefSchema>;
export type CustomCommandResult = Extract<ToolContent[number], { type: "tool-result" }>["output"];

export type CustomCommandContext = {
  cwd: string;
  dataDir: string;
  commandDir: string;
  commandName: string;
  requestId: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  reportActivity?: () => void;
};

export type CustomCommandModule = {
  execute(
    args: unknown[],
    ctx: CustomCommandContext,
  ): Promise<CustomCommandResult> | CustomCommandResult;
};

export type DiscoveredCustomCommand = {
  def: CustomCommandDef;
  dir: string;
  defPath: string;
  entrypointPath: string;
};

export type InvalidCustomCommand = {
  dir: string;
  defPath?: string;
  reason: string;
};

export type CustomCommandDiscovery =
  | {
      type: "command";
      command: DiscoveredCustomCommand;
    }
  | {
      type: "invalid";
      invalid: InvalidCustomCommand;
    };

export class CustomCommandDirectoryReadError extends TaggedError(
  "CustomCommandDirectoryReadError",
)<{
  readonly directoryPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CustomCommandDefinitionReadError extends TaggedError(
  "CustomCommandDefinitionReadError",
)<{
  readonly defPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CustomCommandDefinitionJsonError extends TaggedError(
  "CustomCommandDefinitionJsonError",
)<{
  readonly defPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CustomCommandDefinitionSchemaError extends TaggedError(
  "CustomCommandDefinitionSchemaError",
)<{
  readonly defPath: string;
  readonly issues: readonly string[];
  readonly cause?: unknown;
  readonly message: string;
}> {}

export type CustomCommandDefinitionError =
  | CustomCommandDefinitionReadError
  | CustomCommandDefinitionJsonError
  | CustomCommandDefinitionSchemaError;
export type CustomCommandDiscoveryError = CustomCommandDirectoryReadError;

export type CustomCommandDiscoveryDependencies = {
  readonly access: (filePath: string) => Promise<void>;
  readonly readText: (filePath: string) => Promise<string>;
  readonly readDirectory: (directoryPath: string) => Promise<Dirent[]>;
};

const DEFAULT_DISCOVERY_DEPENDENCIES: CustomCommandDiscoveryDependencies = {
  access: (filePath) => fs.access(filePath),
  readText: (filePath) => fs.readFile(filePath, "utf8"),
  readDirectory: (directoryPath) => fs.readdir(directoryPath, { withFileTypes: true }),
};

async function pathExists(
  filePath: string,
  dependencies: CustomCommandDiscoveryDependencies,
): Promise<boolean> {
  try {
    await dependencies.access(filePath);
    return true;
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return false;
  }
}

export async function readCustomCommandDefinition(params: {
  defPath: string;
  readText?: CustomCommandDiscoveryDependencies["readText"];
}): Promise<ResultType<CustomCommandDef, CustomCommandDefinitionError>> {
  let text: string;
  try {
    text = await (params.readText ?? DEFAULT_DISCOVERY_DEPENDENCIES.readText)(params.defPath);
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command definition read failure");
    return Result.err(
      new CustomCommandDefinitionReadError({
        defPath: params.defPath,
        cause,
        message: opaqueErrorMessage(cause, "Opaque custom-command definition read failure"),
      }),
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command definition JSON failure");
    return Result.err(
      new CustomCommandDefinitionJsonError({
        defPath: params.defPath,
        cause,
        message: opaqueErrorMessage(cause, "Opaque custom-command definition JSON failure"),
      }),
    );
  }

  try {
    const parsed = customCommandDefSchema.safeParse(decoded);
    if (parsed.success) return Result.ok(parsed.data);
    return Result.err(
      new CustomCommandDefinitionSchemaError({
        defPath: params.defPath,
        issues: parsed.error.issues.map((issue) => issue.message),
        message: parsed.error.message,
      }),
    );
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command schema failure");
    const message = opaqueErrorMessage(cause, "Opaque custom-command schema failure");
    return Result.err(
      new CustomCommandDefinitionSchemaError({
        defPath: params.defPath,
        issues: [message],
        cause,
        message,
      }),
    );
  }
}

async function resolveEntrypoint(
  dir: string,
  dependencies: CustomCommandDiscoveryDependencies,
): Promise<string | null> {
  const candidates = [path.join(dir, "index.ts"), path.join(dir, "index.js")];
  for (const filePath of candidates) {
    if (await pathExists(filePath, dependencies)) return filePath;
  }
  return null;
}

export function resolveCustomCommandsDir(dataDir: string): string {
  return path.join(dataDir, "cmds");
}

export function buildCustomCommandTextName(name: string): string {
  return `${CUSTOM_COMMAND_TEXT_PREFIX}${name}`;
}

export function decodeCustomCommandResult(value: unknown): CustomCommandResult | null {
  try {
    const hasPlainPrototype = (candidate: Record<string, unknown>): boolean => {
      const prototype = Object.getPrototypeOf(candidate);
      return prototype === Object.prototype || prototype === null;
    };
    const isStringMap = (candidate: unknown): boolean => {
      if (!isRecord(candidate) || !hasPlainPrototype(candidate)) return false;
      return Object.keys(candidate).every((key) => typeof candidate[key] === "string");
    };
    const isProviderReference = (candidate: unknown): boolean =>
      isRecord(candidate) &&
      hasPlainPrototype(candidate) &&
      !Object.hasOwn(candidate, "type") &&
      Object.keys(candidate).every((key) => typeof candidate[key] === "string");
    const isJsonValue = (candidate: unknown, ancestors: WeakSet<object>): boolean => {
      if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
        return true;
      }
      if (typeof candidate === "number") return Number.isFinite(candidate);
      if (typeof candidate !== "object") return false;
      if (ancestors.has(candidate)) return false;

      ancestors.add(candidate);
      try {
        if (Array.isArray(candidate)) {
          for (let index = 0; index < candidate.length; index += 1) {
            if (!Object.hasOwn(candidate, index) || !isJsonValue(candidate[index], ancestors)) {
              return false;
            }
          }
          return true;
        }
        if (!isRecord(candidate) || !hasPlainPrototype(candidate)) return false;
        return Object.keys(candidate).every((key) => {
          const nested = candidate[key];
          return nested === undefined || isJsonValue(nested, ancestors);
        });
      } finally {
        ancestors.delete(candidate);
      }
    };
    const isProviderOptions = (candidate: unknown): boolean => {
      if (!isRecord(candidate) || !hasPlainPrototype(candidate)) return false;
      return Object.keys(candidate).every((provider) => {
        const options = candidate[provider];
        return (
          isRecord(options) && hasPlainPrototype(options) && isJsonValue(options, new WeakSet())
        );
      });
    };
    const hasOptionalString = (candidate: Record<string, unknown>, key: string): boolean =>
      Object.hasOwn(candidate, key)
        ? candidate[key] === undefined || typeof candidate[key] === "string"
        : !(key in candidate);
    const hasOptionalProviderOptions = (candidate: Record<string, unknown>): boolean =>
      Object.hasOwn(candidate, "providerOptions")
        ? candidate["providerOptions"] === undefined ||
          isProviderOptions(candidate["providerOptions"])
        : !("providerOptions" in candidate);
    const isFileData = (candidate: unknown): boolean => {
      if (!isRecord(candidate) || !Object.hasOwn(candidate, "type")) return false;
      switch (candidate["type"]) {
        case "data": {
          if (!Object.hasOwn(candidate, "data")) return false;
          const data = candidate["data"];
          return (
            typeof data === "string" || data instanceof Uint8Array || data instanceof ArrayBuffer
          );
        }
        case "url":
          return Object.hasOwn(candidate, "url") && candidate["url"] instanceof URL;
        case "reference":
          return (
            Object.hasOwn(candidate, "reference") && isProviderReference(candidate["reference"])
          );
        case "text":
          return Object.hasOwn(candidate, "text") && typeof candidate["text"] === "string";
        default:
          return false;
      }
    };
    const isFileId = (candidate: unknown): boolean =>
      typeof candidate === "string" || isStringMap(candidate);
    const isContentPart = (candidate: unknown): boolean => {
      if (!isRecord(candidate) || !Object.hasOwn(candidate, "type")) return false;
      if (!hasOptionalProviderOptions(candidate)) return false;
      switch (candidate["type"]) {
        case "text":
          return Object.hasOwn(candidate, "text") && typeof candidate["text"] === "string";
        case "file":
          return (
            Object.hasOwn(candidate, "data") &&
            isFileData(candidate["data"]) &&
            Object.hasOwn(candidate, "mediaType") &&
            typeof candidate["mediaType"] === "string" &&
            hasOptionalString(candidate, "filename")
          );
        case "file-data":
          return (
            Object.hasOwn(candidate, "data") &&
            typeof candidate["data"] === "string" &&
            Object.hasOwn(candidate, "mediaType") &&
            typeof candidate["mediaType"] === "string" &&
            hasOptionalString(candidate, "filename")
          );
        case "file-url":
          return (
            Object.hasOwn(candidate, "url") &&
            typeof candidate["url"] === "string" &&
            hasOptionalString(candidate, "mediaType")
          );
        case "file-id":
        case "image-file-id":
          return Object.hasOwn(candidate, "fileId") && isFileId(candidate["fileId"]);
        case "file-reference":
        case "image-file-reference":
          return (
            Object.hasOwn(candidate, "providerReference") &&
            isProviderReference(candidate["providerReference"])
          );
        case "image-data":
          return (
            Object.hasOwn(candidate, "data") &&
            typeof candidate["data"] === "string" &&
            Object.hasOwn(candidate, "mediaType") &&
            typeof candidate["mediaType"] === "string"
          );
        case "image-url":
          return Object.hasOwn(candidate, "url") && typeof candidate["url"] === "string";
        case "custom":
          return true;
        default:
          return false;
      }
    };
    const isContentParts = (candidate: unknown[]): boolean => {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.hasOwn(candidate, index) || !isContentPart(candidate[index])) return false;
      }
      return true;
    };
    const identitySchema = z.custom<CustomCommandResult>((candidate) => {
      if (!isRecord(candidate) || !Object.hasOwn(candidate, "type")) return false;
      switch (candidate["type"]) {
        case "text":
        case "error-text":
          return (
            Object.hasOwn(candidate, "value") &&
            typeof candidate["value"] === "string" &&
            hasOptionalProviderOptions(candidate)
          );
        case "json":
        case "error-json":
          return (
            Object.hasOwn(candidate, "value") &&
            isJsonValue(candidate["value"], new WeakSet()) &&
            hasOptionalProviderOptions(candidate)
          );
        case "execution-denied":
          return hasOptionalString(candidate, "reason") && hasOptionalProviderOptions(candidate);
        case "content":
          return (
            Object.hasOwn(candidate, "value") &&
            Array.isArray(candidate["value"]) &&
            isContentParts(candidate["value"])
          );
        default:
          return false;
      }
    });
    const decoded = identitySchema.safeParse(value);
    return decoded.success ? decoded.data : null;
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return null;
  }
}

export async function discoverCustomCommands(params: {
  dataDir: string;
  dependencies?: Partial<CustomCommandDiscoveryDependencies>;
}): Promise<ResultType<CustomCommandDiscovery[], CustomCommandDiscoveryError>> {
  const root = resolveCustomCommandsDir(params.dataDir);
  const dependencies: CustomCommandDiscoveryDependencies = {
    access: params.dependencies?.access ?? DEFAULT_DISCOVERY_DEPENDENCIES.access,
    readText: params.dependencies?.readText ?? DEFAULT_DISCOVERY_DEPENDENCIES.readText,
    readDirectory:
      params.dependencies?.readDirectory ?? DEFAULT_DISCOVERY_DEPENDENCIES.readDirectory,
  };

  let dirents: Dirent[];
  try {
    dirents = await dependencies.readDirectory(root);
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command discovery failure");
    if (errorCode(cause) === "ENOENT") return Result.ok([]);
    return Result.err(
      new CustomCommandDirectoryReadError({
        directoryPath: root,
        cause,
        message: opaqueErrorMessage(cause, "Opaque custom-command discovery failure"),
      }),
    );
  }

  const out: CustomCommandDiscovery[] = [];
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const dir = path.join(root, dirent.name);
    const defPath = path.join(dir, "def.json");

    if (!(await pathExists(defPath, dependencies))) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          reason: "missing def.json",
        },
      });
      continue;
    }

    const entrypointPath = await resolveEntrypoint(dir, dependencies);
    if (!entrypointPath) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          defPath,
          reason: "missing index.ts or index.js",
        },
      });
      continue;
    }

    const definition = await readCustomCommandDefinition({
      defPath,
      readText: dependencies.readText,
    });
    definition.match({
      ok: (value) =>
        out.push({
          type: "command",
          command: { def: value, dir, defPath, entrypointPath },
        }),
      err: (error) =>
        out.push({
          type: "invalid",
          invalid: {
            dir,
            defPath,
            reason: `invalid def.json: ${formatTaggedErrorForLog(error).errorMessage}`,
          },
        }),
    });
  }

  return Result.ok(out);
}
