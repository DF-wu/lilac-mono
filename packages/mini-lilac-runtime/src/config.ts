import { readFile } from "node:fs/promises";
import path from "node:path";

import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  MINI_LILAC_EXECUTABLE_TOOL_NAMES,
  normalizeMiniLilacToolName,
} from "@stanley2058/mini-lilac-client";
import { isPanic } from "@stanley2058/lilac-utils";

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(MINI_LILAC_EXECUTABLE_TOOL_NAMES);

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase slug");

const environmentVariableSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const modelRefSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/.+$/u, "must be a provider/model reference");

const profileSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    promptOverlay: z.string().trim().min(1).optional(),
    subagentOnly: z.boolean().default(false),
    tools: z.array(z.string().trim().min(1).transform(normalizeMiniLilacToolName)),
    execution: z.boolean(),
    workspaceWrites: z.boolean(),
    delegation: z.boolean(),
  })
  .strict();

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "::1" || normalized === "[::1]") return true;

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

export const runtimeConfigSchema = z
  .object({
    configVersion: z.literal(1),
    server: z
      .object({
        host: z.string().trim().min(1),
        port: z.number().int().min(1).max(65_535),
        authTokenEnv: environmentVariableSchema.optional(),
      })
      .strict(),
    providerConfigFile: z.string().trim().min(1),
    providerAuthFile: z.string().trim().min(1),
    agent: z
      .object({
        systemPrompt: z.string().trim().min(1),
        defaultProfile: slugSchema,
        titleModel: modelRefSchema.optional(),
        idleTimeoutMs: z
          .number()
          .int()
          .min(1_500)
          .max(86_400_000)
          .default(15 * 60 * 1000),
        compaction: z
          .object({
            model: z.union([z.literal("inherit"), modelRefSchema]).default("inherit"),
            earlyCompactionPoint: z.number().min(0.05).max(0.95).default(0.8),
          })
          .strict()
          .default({ model: "inherit", earlyCompactionPoint: 0.8 }),
        subagents: z
          .object({
            enabled: z.boolean().default(true),
            maxDepth: z.number().int().min(0).max(16).default(1),
          })
          .strict()
          .default({
            enabled: true,
            maxDepth: 1,
          }),
        profiles: z
          .record(slugSchema, profileSchema)
          .refine((profiles) => Object.keys(profiles).length > 0, {
            message: "at least one profile is required",
          }),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.server.authTokenEnv && !isLoopbackHost(config.server.host)) {
      context.addIssue({
        code: "custom",
        path: ["server", "host"],
        message: "non-loopback hosts require server.authTokenEnv",
      });
    }

    const defaultProfile = config.agent.profiles[config.agent.defaultProfile];
    if (!defaultProfile) {
      context.addIssue({
        code: "custom",
        path: ["agent", "defaultProfile"],
        message: `profile '${config.agent.defaultProfile}' is not defined`,
      });
    } else if (defaultProfile.subagentOnly) {
      context.addIssue({
        code: "custom",
        path: ["agent", "defaultProfile"],
        message: "the default profile cannot be subagent-only",
      });
    }

    for (const [profileId, profile] of Object.entries(config.agent.profiles)) {
      profile.tools.forEach((toolName, index) => {
        if (toolName !== "*" && !KNOWN_TOOL_NAMES.has(toolName)) {
          context.addIssue({
            code: "custom",
            path: ["agent", "profiles", profileId, "tools", index],
            message: `unknown tool '${toolName}'`,
          });
        }
      });
    }
  });

export type AgentProfile = z.infer<typeof profileSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type LoadedRuntimeConfig = RuntimeConfig & { configFile: string };

export type LoadRuntimeConfigOptions = {
  env?: Readonly<Record<string, string | undefined>>;
};

export class RuntimeConfigReadFailed extends TaggedError("RuntimeConfigReadFailed")<{
  readonly configFile: string;
  readonly message: string;
}> {}

export class RuntimeConfigYamlInvalid extends TaggedError("RuntimeConfigYamlInvalid")<{
  readonly configFile: string;
  readonly message: string;
}> {}

export class RuntimeConfigInvalid extends TaggedError("RuntimeConfigInvalid")<{
  readonly configFile: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class RuntimeConfigAuthTokenMissing extends TaggedError("RuntimeConfigAuthTokenMissing")<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export type LoadRuntimeConfigError =
  | RuntimeConfigReadFailed
  | RuntimeConfigYamlInvalid
  | RuntimeConfigInvalid
  | RuntimeConfigAuthTokenMissing;

type RuntimeConfigCapture<T, E> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "panic"; readonly panic: Panic };

function throwRuntimeConfigPanic(panic: Panic): never {
  throw panic;
}

function captureRuntimeConfigYaml(
  source: string,
  configFile: string,
): RuntimeConfigCapture<RuntimeConfig, RuntimeConfigYamlInvalid | RuntimeConfigInvalid> {
  try {
    const decoded = decodeRuntimeConfig(Bun.YAML.parse(source), configFile);
    if (decoded.status === "error") return { status: "error", error: decoded.error };
    return { status: "ok", value: decoded.value };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return {
      status: "error",
      error: new RuntimeConfigYamlInvalid({
        configFile,
        message: `Failed to parse YAML file '${configFile}'`,
      }),
    };
  }
}

async function captureRuntimeConfigRead(
  configFile: string,
): Promise<RuntimeConfigCapture<string, RuntimeConfigReadFailed>> {
  try {
    return { status: "ok", value: await readFile(configFile, "utf8") };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return {
      status: "error",
      error: new RuntimeConfigReadFailed({
        configFile,
        message: `Failed to read runtime config '${configFile}'`,
      }),
    };
  }
}

export function decodeRuntimeConfig(
  input: unknown,
  configFile: string,
): ResultType<RuntimeConfig, RuntimeConfigInvalid> {
  const decoded = runtimeConfigSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new RuntimeConfigInvalid({
      configFile,
      issues: decoded.error.issues.map((issue) => issue.message),
      message: `Runtime config '${configFile}' is invalid: ${z.prettifyError(decoded.error)}`,
    }),
  );
}

export function decodeRuntimeConfigYaml(
  source: string,
  configFile: string,
): ResultType<RuntimeConfig, RuntimeConfigYamlInvalid | RuntimeConfigInvalid> {
  const captured = captureRuntimeConfigYaml(source, configFile);
  if (captured.status === "panic") return throwRuntimeConfigPanic(captured.panic);
  if (captured.status === "error") return Result.err(captured.error);
  return Result.ok(captured.value);
}

export async function loadRuntimeConfigResult(
  configFile: string,
  options: LoadRuntimeConfigOptions = {},
): Promise<ResultType<LoadedRuntimeConfig, LoadRuntimeConfigError>> {
  const absoluteConfigFile = path.resolve(configFile);
  const source = await captureRuntimeConfigRead(absoluteConfigFile);
  if (source.status === "panic") return throwRuntimeConfigPanic(source.panic);
  if (source.status === "error") return Result.err(source.error);
  const decoded = decodeRuntimeConfigYaml(source.value, absoluteConfigFile);
  if (decoded.status === "error") return Result.err(decoded.error);
  const config = decoded.value;
  const env = options.env ?? process.env;

  if (config.server.authTokenEnv) {
    const token = env[config.server.authTokenEnv];
    if (!token?.trim()) {
      return Result.err(
        new RuntimeConfigAuthTokenMissing({
          environmentVariable: config.server.authTokenEnv,
          message: `Server auth token environment variable '${config.server.authTokenEnv}' is missing or empty`,
        }),
      );
    }
  }

  const configDirectory = path.dirname(absoluteConfigFile);
  return Result.ok({
    ...config,
    configFile: absoluteConfigFile,
    providerConfigFile: path.resolve(configDirectory, config.providerConfigFile),
    providerAuthFile: path.resolve(configDirectory, config.providerAuthFile),
  });
}

/** Compatibility adapter for callers that consume startup failures as rejections. */
export async function loadRuntimeConfig(
  configFile: string,
  options: LoadRuntimeConfigOptions = {},
): Promise<LoadedRuntimeConfig> {
  const loaded = await loadRuntimeConfigResult(configFile, options);
  if (loaded.status === "error") throw loaded.error;
  return loaded.value;
}
