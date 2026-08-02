import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  createEmptyMcpConfig,
  MCP_CONFIG_FILE_NAME,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";
import { mcpServerIdSchema, parseMcpConfigYaml, serializeMcpConfigYaml } from "./config";
import { opaqueErrorMessage, rethrowPanic } from "./error-format";

const errorCodeSchema = z.object({ code: z.string() });
const mutationQueues = new Map<string, Promise<void>>();

type McpConfigFileOperation =
  | "create_parent"
  | "open_temporary"
  | "write_temporary"
  | "sync_temporary"
  | "close_temporary"
  | "rename_temporary"
  | "remove_temporary";

type McpConfigFileHandle = Pick<
  Awaited<ReturnType<typeof fs.open>>,
  "writeFile" | "sync" | "close"
>;

export type McpConfigFileDependencies = {
  readonly mkdir: typeof fs.mkdir;
  readonly open: (filePath: string, flags: string, mode: number) => Promise<McpConfigFileHandle>;
  readonly rename: typeof fs.rename;
  readonly rm: typeof fs.rm;
  readonly randomUUID: () => string;
};

const DEFAULT_FILE_DEPENDENCIES: McpConfigFileDependencies = {
  mkdir: fs.mkdir,
  open: fs.open,
  rename: fs.rename,
  rm: fs.rm,
  randomUUID,
};

export class McpConfigError extends TaggedError("McpConfigError")<{
  readonly configPath: string;
  readonly issues: readonly string[];
  readonly cause?: unknown;
  readonly message: string;
}> {
  constructor(options: {
    readonly configPath: string;
    readonly issues: readonly string[];
    readonly cause?: unknown;
  }) {
    super({
      ...options,
      message: `Invalid MCP configuration at ${options.configPath}:\n${options.issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    });
  }
}

export class McpConfigSerializationError extends TaggedError("McpConfigSerializationError")<{
  readonly configPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpConfigMutationValidationError extends TaggedError(
  "McpConfigMutationValidationError",
)<{
  readonly configPath: string;
  readonly serverId: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class McpConfigFileOperationError extends TaggedError("McpConfigFileOperationError")<{
  readonly configPath: string;
  readonly operation: McpConfigFileOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpConfigFileOperationAndCleanupError extends TaggedError(
  "McpConfigFileOperationAndCleanupError",
)<{
  readonly configPath: string;
  readonly primary: McpConfigWriteError;
  readonly cleanup: McpConfigFileOperationError;
  readonly message: string;
}> {}

class McpConfigFileMissingError extends TaggedError("McpConfigFileMissingError")<{
  readonly configPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type McpConfigReadError = McpConfigError;
export type McpConfigWriteError =
  | McpConfigSerializationError
  | McpConfigFileOperationError
  | McpConfigFileOperationAndCleanupError;
export type McpConfigMutationError =
  | McpConfigReadError
  | McpConfigMutationValidationError
  | McpConfigWriteError;

export type McpConfigFileSnapshot = {
  readonly configPath: string;
  readonly exists: boolean;
  readonly config: UniversalMcpConfig;
};

export type McpConfigFileResult = ResultType<McpConfigFileSnapshot, McpConfigReadError>;

export type McpConfigMutation =
  | { readonly type: "upsert"; readonly server: McpServerDefinition }
  | { readonly type: "remove"; readonly serverId: string };

export type McpConfigMutationResult = {
  readonly configPath: string;
  readonly changed: boolean;
  readonly previousConfig: UniversalMcpConfig;
  readonly config: UniversalMcpConfig;
};

function isMissingFileError(error: unknown): boolean {
  const parsed = errorCodeSchema.safeParse(error);
  return parsed.success && (parsed.data.code === "ENOENT" || parsed.data.code === "ENOTDIR");
}

function enqueueMutation<T, E>(
  configPath: string,
  operation: () => Promise<ResultType<T, E>>,
): Promise<ResultType<T, E>> {
  const previous = mutationQueues.get(configPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(configPath, settled);

  return result.finally(() => {
    if (mutationQueues.get(configPath) === settled) mutationQueues.delete(configPath);
  });
}

function captureFileOperation<T>(options: {
  readonly configPath: string;
  readonly operation: McpConfigFileOperation;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, McpConfigFileOperationError>> {
  return Result.tryPromise({
    try: options.run,
    catch: (cause) => {
      rethrowPanic(cause);
      return new McpConfigFileOperationError({
        configPath: options.configPath,
        operation: options.operation,
        cause,
        message: `Failed to ${options.operation.replaceAll("_", " ")} for MCP configuration at ${options.configPath}: ${opaqueErrorMessage(cause)}`,
      });
    },
  });
}

function serializeConfig(
  configPath: string,
  config: UniversalMcpConfig,
): ResultType<string, McpConfigSerializationError> {
  return Result.try({
    try: () => serializeMcpConfigYaml(config),
    catch: (cause) => {
      rethrowPanic(cause);
      return new McpConfigSerializationError({
        configPath,
        cause,
        message: `Failed to serialize MCP configuration at ${configPath}: ${opaqueErrorMessage(cause)}`,
      });
    },
  });
}

function combineOperationAndCleanup(
  configPath: string,
  primary: ResultType<void, McpConfigWriteError>,
  cleanup: ResultType<void, McpConfigFileOperationError>,
): ResultType<void, McpConfigWriteError> {
  if (primary.status === "ok") return cleanup;
  if (cleanup.status === "ok") return primary;
  return Result.err(
    new McpConfigFileOperationAndCleanupError({
      configPath,
      primary: primary.error,
      cleanup: cleanup.error,
      message: `${primary.error.message}; cleanup also failed: ${cleanup.error.message}`,
    }),
  );
}

function validateMutationServerId(
  configPath: string,
  serverId: string,
): ResultType<void, McpConfigMutationValidationError> {
  const parsed = mcpServerIdSchema.safeParse(serverId);
  if (parsed.success) return Result.ok();
  const issues = parsed.error.issues.map((issue) => issue.message);
  return Result.err(
    new McpConfigMutationValidationError({
      configPath,
      serverId,
      issues,
      message: `Invalid MCP server ID ${JSON.stringify(serverId)}: ${issues.join("; ")}`,
    }),
  );
}

export function resolveMcpConfigPath(options: { dataDir: string }): string {
  return path.join(options.dataDir, MCP_CONFIG_FILE_NAME);
}

export async function readMcpConfigFile(configPath: string): Promise<McpConfigFileResult> {
  const source = await Result.tryPromise({
    try: () => fs.readFile(configPath, "utf8"),
    catch: (cause) => {
      rethrowPanic(cause);
      if (isMissingFileError(cause)) {
        return new McpConfigFileMissingError({
          configPath,
          cause,
          message: `MCP configuration does not exist at ${configPath}`,
        });
      }
      return new McpConfigError({
        configPath,
        issues: [`<root>: failed to read file: ${opaqueErrorMessage(cause)}`],
        cause,
      });
    },
  });
  if (source.status === "error") {
    if (McpConfigFileMissingError.is(source.error)) {
      return Result.ok({ configPath, exists: false, config: createEmptyMcpConfig() });
    }
    return Result.err(source.error);
  }

  const parsed = parseMcpConfigYaml(source.value);
  if (!parsed.ok) return Result.err(new McpConfigError({ configPath, issues: parsed.issues }));
  return Result.ok({ configPath, exists: true, config: parsed.config });
}

/** Write a complete validated config through a same-directory rename. */
export async function writeMcpConfigFileAtomic(
  configPath: string,
  config: UniversalMcpConfig,
  dependencies: McpConfigFileDependencies = DEFAULT_FILE_DEPENDENCIES,
): Promise<ResultType<void, McpConfigWriteError>> {
  const source = serializeConfig(configPath, config);
  if (source.status === "error") return source;

  const parent = path.dirname(configPath);
  const parentResult = await captureFileOperation({
    configPath,
    operation: "create_parent",
    run: () => dependencies.mkdir(parent, { recursive: true }).then(() => undefined),
  });
  if (parentResult.status === "error") return parentResult;

  const temporaryPath = path.join(
    parent,
    `.${path.basename(configPath)}.${dependencies.randomUUID()}.tmp`,
  );
  const removeTemporary = () =>
    captureFileOperation({
      configPath,
      operation: "remove_temporary",
      run: () => dependencies.rm(temporaryPath, { force: true }),
    });

  let openCompleted = false;
  let opened: ResultType<McpConfigFileHandle, McpConfigFileOperationError>;
  try {
    opened = await captureFileOperation({
      configPath,
      operation: "open_temporary",
      run: () => dependencies.open(temporaryPath, "wx", 0o600),
    });
    openCompleted = true;
  } finally {
    if (!openCompleted) await removeTemporary();
  }
  if (opened.status === "error") {
    return combineOperationAndCleanup(configPath, opened, await removeTemporary());
  }

  const handle = opened.value;
  const closeTemporary = () =>
    captureFileOperation({
      configPath,
      operation: "close_temporary",
      run: () => handle.close(),
    });
  let writeCompleted = false;
  let written: ResultType<void, McpConfigFileOperationError>;
  try {
    written = await Result.gen(async function* () {
      yield* Result.await(
        captureFileOperation({
          configPath,
          operation: "write_temporary",
          run: () => handle.writeFile(source.value, "utf8"),
        }),
      );
      yield* Result.await(
        captureFileOperation({
          configPath,
          operation: "sync_temporary",
          run: () => handle.sync(),
        }),
      );
      return Result.ok();
    });
    writeCompleted = true;
  } finally {
    if (!writeCompleted) {
      try {
        await closeTemporary();
      } finally {
        await removeTemporary();
      }
    }
  }

  let closeCompleted = false;
  let closed: ResultType<void, McpConfigFileOperationError>;
  try {
    closed = await closeTemporary();
    closeCompleted = true;
  } finally {
    if (!closeCompleted) await removeTemporary();
  }
  const prepared = combineOperationAndCleanup(configPath, written, closed);
  if (prepared.status === "error") {
    return combineOperationAndCleanup(configPath, prepared, await removeTemporary());
  }

  let renameCompleted = false;
  let renamed: ResultType<void, McpConfigFileOperationError>;
  try {
    renamed = await captureFileOperation({
      configPath,
      operation: "rename_temporary",
      run: () => dependencies.rename(temporaryPath, configPath),
    });
    renameCompleted = true;
  } finally {
    if (!renameCompleted) await removeTemporary();
  }
  if (renamed.status === "error") {
    return combineOperationAndCleanup(configPath, renamed, await removeTemporary());
  }
  return Result.ok();
}

/**
 * Apply one add/replace/remove operation against the latest file contents.
 * Mutations to the same path are serialized within the Core process.
 */
export function mutateMcpConfigFile(options: {
  readonly configPath: string;
  readonly mutation: McpConfigMutation;
  readonly fileDependencies?: McpConfigFileDependencies;
}): Promise<ResultType<McpConfigMutationResult, McpConfigMutationError>> {
  return enqueueMutation(options.configPath, async () =>
    Result.gen(async function* () {
      const snapshot = yield* Result.await(readMcpConfigFile(options.configPath));
      const previousConfig = snapshot.config;
      const servers = { ...previousConfig.servers };

      switch (options.mutation.type) {
        case "upsert": {
          yield* validateMutationServerId(options.configPath, options.mutation.server.id);
          servers[options.mutation.server.id] = options.mutation.server;
          break;
        }
        case "remove": {
          yield* validateMutationServerId(options.configPath, options.mutation.serverId);
          delete servers[options.mutation.serverId];
          break;
        }
      }

      const config: UniversalMcpConfig = {
        configVersion: previousConfig.configVersion,
        servers,
      };
      const previousSource = yield* serializeConfig(options.configPath, previousConfig);
      const nextSource = yield* serializeConfig(options.configPath, config);
      const changed = previousSource !== nextSource;
      if (changed) {
        yield* Result.await(
          writeMcpConfigFileAtomic(options.configPath, config, options.fileDependencies),
        );
      }

      return Result.ok({ configPath: options.configPath, changed, previousConfig, config });
    }),
  );
}
