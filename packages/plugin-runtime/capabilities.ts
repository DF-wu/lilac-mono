import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { ToolPluginCapabilityError, ToolPluginManagerHookError } from "./errors";
import type {
  Level1ToolFailureSummary,
  Level1ToolSpec,
  LilacToolPlugin,
  ServerTool,
  ServerToolListResult,
  ToolPluginInstance,
  ToolPluginMeta,
} from "./types";

export type DynamicToolPluginModule<TRuntimeContext> = {
  readonly default: LilacToolPlugin<TRuntimeContext, Level1ToolSpec<TRuntimeContext>, ServerTool>;
};

export type PluginFunctionCapability = (...args: unknown[]) => unknown;

type Level1EditTargetsCapability = NonNullable<Level1ToolSpec<unknown>["editTargets"]>;

export type ToolPluginMetaCapabilitySnapshot = Readonly<ToolPluginMeta>;

export type ToolPluginCapabilitySnapshot<TRuntimeContext> = {
  readonly plugin: LilacToolPlugin<TRuntimeContext, Level1ToolSpec<TRuntimeContext>, ServerTool>;
  readonly meta: ToolPluginMetaCapabilitySnapshot;
  readonly create: LilacToolPlugin<
    TRuntimeContext,
    Level1ToolSpec<TRuntimeContext>,
    ServerTool
  >["create"];
};

export type Level1ToolSpecCapabilitySnapshot<TRuntimeContext> = {
  readonly spec: Level1ToolSpec<TRuntimeContext>;
  readonly name: string;
  readonly supportsBatch?: boolean;
  readonly createTool: Level1ToolSpec<TRuntimeContext>["createTool"];
  readonly isEnabled: Level1ToolSpec<TRuntimeContext>["isEnabled"];
  readonly editTargets?: NonNullable<Level1ToolSpec<TRuntimeContext>["editTargets"]>;
  readonly formatArgs?: NonNullable<Level1ToolSpec<TRuntimeContext>["formatArgs"]>;
  readonly summarizeFailure?: NonNullable<Level1ToolSpec<TRuntimeContext>["summarizeFailure"]>;
};

export type ServerToolCapabilitySnapshot = {
  readonly tool: ServerTool;
  readonly id: string;
  readonly init: ServerTool["init"];
  readonly destroy: ServerTool["destroy"];
  readonly list: ServerTool["list"];
  readonly call: ServerTool["call"];
};

export type ToolPluginInstanceCapabilitySnapshot<TRuntimeContext> = {
  readonly instance: ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>;
  readonly level1: readonly Level1ToolSpecCapabilitySnapshot<TRuntimeContext>[];
  readonly level2: readonly ServerToolCapabilitySnapshot[];
  readonly init?: NonNullable<
    ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>["init"]
  >;
  readonly destroy?: NonNullable<
    ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>["destroy"]
  >;
};

export type DynamicToolPluginModuleCapabilitySnapshot<TRuntimeContext> = {
  readonly module: DynamicToolPluginModule<TRuntimeContext>;
  readonly plugin: ToolPluginCapabilitySnapshot<TRuntimeContext>;
};

type CapturedToolPlugin = {
  readonly meta: ToolPluginMetaCapabilitySnapshot;
  readonly create: PluginFunctionCapability;
};
type CapturedLevel1ToolSpec = Omit<Level1ToolSpecCapabilitySnapshot<unknown>, "spec">;
type CapturedServerTool = Omit<ServerToolCapabilitySnapshot, "tool">;
type CapturedToolPluginInstance = {
  readonly level1: readonly Level1ToolSpecCapabilitySnapshot<unknown>[];
  readonly level2: readonly ServerToolCapabilitySnapshot[];
  readonly init?: NonNullable<ToolPluginInstance<Level1ToolSpec<unknown>, ServerTool>["init"]>;
  readonly destroy?: NonNullable<
    ToolPluginInstance<Level1ToolSpec<unknown>, ServerTool>["destroy"]
  >;
};

const toolPluginCapabilities = new WeakMap<object, CapturedToolPlugin>();
const toolPluginMetaCapabilities = new WeakMap<object, ToolPluginMetaCapabilitySnapshot>();
const level1ToolSpecCapabilities = new WeakMap<object, CapturedLevel1ToolSpec>();
const serverToolCapabilities = new WeakMap<object, CapturedServerTool>();
const toolPluginInstanceCapabilities = new WeakMap<object, CapturedToolPluginInstance>();
const dynamicToolPluginModuleCapabilities = new WeakMap<
  object,
  CapturedToolPlugin & {
    readonly plugin: LilacToolPlugin<unknown, Level1ToolSpec<unknown>, ServerTool>;
  }
>();

export function getLevel1ToolSpecCapabilitySnapshot<TRuntimeContext>(
  spec: Level1ToolSpec<TRuntimeContext>,
): Level1ToolSpecCapabilitySnapshot<TRuntimeContext> | undefined {
  const captured = level1ToolSpecCapabilities.get(spec);
  return captured ? { spec, ...captured } : undefined;
}

export function getServerToolCapabilitySnapshot(
  tool: ServerTool,
): ServerToolCapabilitySnapshot | undefined {
  const captured = serverToolCapabilities.get(tool);
  return captured ? { tool, ...captured } : undefined;
}

export function isPluginPanic(value: unknown): value is Panic {
  return Result.try({ try: () => Panic.is(value), catch: () => undefined }).match({
    ok: (isValuePanic) => isValuePanic,
    err: () => false,
  });
}

export function isFunctionCapability(value: unknown): value is PluginFunctionCapability {
  return typeof value === "function";
}

const functionSchema = z.custom<PluginFunctionCapability>(isFunctionCapability);
const level1EditTargetsFunctionSchema = z.custom<Level1EditTargetsCapability>(isFunctionCapability);
const level1CreateToolFunctionSchema =
  z.custom<Level1ToolSpec<unknown>["createTool"]>(isFunctionCapability);
const level1IsEnabledFunctionSchema =
  z.custom<Level1ToolSpec<unknown>["isEnabled"]>(isFunctionCapability);
const level1FormatArgsFunctionSchema =
  z.custom<NonNullable<Level1ToolSpec<unknown>["formatArgs"]>>(isFunctionCapability);
const level1SummarizeFailureFunctionSchema =
  z.custom<NonNullable<Level1ToolSpec<unknown>["summarizeFailure"]>>(isFunctionCapability);
const serverToolInitFunctionSchema = z.custom<ServerTool["init"]>(isFunctionCapability);
const serverToolDestroyFunctionSchema = z.custom<ServerTool["destroy"]>(isFunctionCapability);
const serverToolListFunctionSchema = z.custom<ServerTool["list"]>(isFunctionCapability);
const serverToolCallFunctionSchema = z.custom<ServerTool["call"]>(isFunctionCapability);
const pluginInstanceInitFunctionSchema =
  z.custom<NonNullable<ToolPluginInstance<Level1ToolSpec<unknown>, ServerTool>["init"]>>(
    isFunctionCapability,
  );
const pluginInstanceDestroyFunctionSchema =
  z.custom<NonNullable<ToolPluginInstance<Level1ToolSpec<unknown>, ServerTool>["destroy"]>>(
    isFunctionCapability,
  );

const pluginMetaShapeSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

export function validateToolPluginMetaCapability(value: unknown): boolean {
  const parsed = pluginMetaShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  toolPluginMetaCapabilities.set(value, Object.freeze({ ...parsed.data }));
  return true;
}

export const toolPluginMetaSchema = z.custom<ToolPluginMeta>(validateToolPluginMetaCapability);

const level1ToolSpecShapeSchema = z
  .object({
    name: z.string().trim().min(1),
    supportsBatch: z.boolean().optional(),
    createTool: level1CreateToolFunctionSchema,
    isEnabled: level1IsEnabledFunctionSchema,
    editTargets: level1EditTargetsFunctionSchema.optional(),
    formatArgs: level1FormatArgsFunctionSchema.optional(),
    summarizeFailure: level1SummarizeFailureFunctionSchema.optional(),
  })
  .passthrough();

export function validateLevel1ToolSpecCapability(value: unknown): boolean {
  const parsed = level1ToolSpecShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  level1ToolSpecCapabilities.set(value, {
    name: parsed.data.name,
    supportsBatch: parsed.data.supportsBatch,
    createTool: parsed.data.createTool,
    isEnabled: parsed.data.isEnabled,
    editTargets: parsed.data.editTargets,
    formatArgs: parsed.data.formatArgs,
    summarizeFailure: parsed.data.summarizeFailure,
  });
  return true;
}

const level2ToolShapeSchema = z
  .object({
    id: z.string().trim().min(1),
    init: serverToolInitFunctionSchema,
    destroy: serverToolDestroyFunctionSchema,
    list: serverToolListFunctionSchema,
    call: serverToolCallFunctionSchema,
  })
  .passthrough();

export function validateServerToolCapability(value: unknown): boolean {
  const parsed = level2ToolShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  serverToolCapabilities.set(value, {
    id: parsed.data.id,
    init: parsed.data.init,
    destroy: parsed.data.destroy,
    list: parsed.data.list,
    call: parsed.data.call,
  });
  return true;
}

export const serverToolSchema = z.custom<ServerTool>(validateServerToolCapability);

const pluginInstanceShapeSchema = z
  .object({
    level1: z.array(z.custom<Level1ToolSpec<unknown>>(validateLevel1ToolSpecCapability)).optional(),
    level2: z.array(serverToolSchema).optional(),
    init: pluginInstanceInitFunctionSchema.optional(),
    destroy: pluginInstanceDestroyFunctionSchema.optional(),
  })
  .passthrough();

export function validateToolPluginInstanceCapability(value: unknown): boolean {
  const parsed = pluginInstanceShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  const level1: Level1ToolSpecCapabilitySnapshot<unknown>[] = [];
  for (const spec of parsed.data.level1 ?? []) {
    const captured = level1ToolSpecCapabilities.get(spec);
    if (!captured) return false;
    level1.push({ spec, ...captured });
  }
  const level2: ServerToolCapabilitySnapshot[] = [];
  for (const tool of parsed.data.level2 ?? []) {
    const captured = serverToolCapabilities.get(tool);
    if (!captured) return false;
    level2.push({ tool, ...captured });
  }
  toolPluginInstanceCapabilities.set(value, {
    level1,
    level2,
    init: parsed.data.init,
    destroy: parsed.data.destroy,
  });
  return true;
}

const toolPluginShapeSchema = z
  .object({
    meta: toolPluginMetaSchema,
    create: functionSchema,
  })
  .passthrough();

export function validateToolPluginCapability(value: unknown): boolean {
  const parsed = toolPluginShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  const meta = toolPluginMetaCapabilities.get(parsed.data.meta);
  if (!meta) return false;
  toolPluginCapabilities.set(value, {
    meta,
    create: parsed.data.create,
  });
  return true;
}

const dynamicModuleShapeSchema = z
  .object({
    default: z.custom<LilacToolPlugin<unknown, Level1ToolSpec<unknown>, ServerTool>>(
      validateToolPluginCapability,
    ),
  })
  .passthrough();

export function validateDynamicToolPluginModuleCapability(value: unknown): boolean {
  const parsed = dynamicModuleShapeSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) return false;
  const captured = toolPluginCapabilities.get(parsed.data.default);
  if (!captured) return false;
  dynamicToolPluginModuleCapabilities.set(value, {
    plugin: parsed.data.default,
    ...captured,
  });
  return true;
}

const serverToolPrimaryPositionalSchema = z.object({
  field: z.string(),
  variadic: z.boolean().optional(),
});

const serverToolHelpEntrySchema = z.object({
  callableId: z.string(),
  name: z.string(),
  description: z.string(),
  shortInput: z.array(z.string()),
  input: z.array(z.string()).optional(),
  primaryPositional: serverToolPrimaryPositionalSchema.optional(),
  hidden: z.boolean().optional(),
});

const serverToolListResultShapeSchema = z.array(serverToolHelpEntrySchema);

export function validateServerToolListResultCapability(value: unknown): boolean {
  return serverToolListResultShapeSchema.safeParse(value).success;
}

export const serverToolListResultSchema = z.custom<ServerToolListResult>(
  validateServerToolListResultCapability,
);

const level1FailureSummaryShapeSchema = z.object({
  ok: z.boolean(),
  failureKind: z.enum(["hard", "soft"]).optional(),
  failureClass: z
    .enum(["input", "policy", "environment", "timeout", "cancelled", "tool", "unknown"])
    .optional(),
  failureCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .optional(),
  retryable: z.boolean().optional(),
  exitCode: z.number().int().finite().optional(),
  error: z.string().optional(),
});

export function validateLevel1ToolFailureSummaryCapability(value: unknown): boolean {
  return level1FailureSummaryShapeSchema.safeParse(value).success;
}

export const level1ToolFailureSummarySchema = z.custom<Level1ToolFailureSummary>(
  validateLevel1ToolFailureSummaryCapability,
);

const voidHookResultSchema = z.undefined();
const booleanHookResultSchema = z.boolean();
const stringHookResultSchema = z.string();
const stringArrayHookResultSchema = z.array(z.string());
const disabledPluginIdsSchema = z.array(z.string());
const level1RegistrationKeySchema = z.string().min(1);
const level1ExecutableMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

export type Level1ExecutableMetadata = z.output<typeof level1ExecutableMetadataSchema>;

function validationIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${location}${issue.message}`;
  });
}

function capabilityError(params: {
  capability: ConstructorParameters<typeof ToolPluginCapabilityError>[0]["capability"];
  pluginId?: string;
  error: z.ZodError;
}): ToolPluginCapabilityError {
  const issues = validationIssues(params.error);
  return new ToolPluginCapabilityError({
    capability: params.capability,
    pluginId: params.pluginId,
    issues,
    cause: params.error,
    message: `Invalid ${params.capability} capability${params.pluginId ? ` for plugin '${params.pluginId}'` : ""}: ${issues.join("; ")}`,
  });
}

const MAX_PLUGIN_EXCEPTION_MESSAGE_LENGTH = 1_000;
const SENSITIVE_PLUGIN_TEXT_RE =
  /((?:["'])?(?:authorization|api[_-]?key|client[_-]?secret|token|secret|password|cookie)(?:["'])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu;
const CREDENTIAL_PLUGIN_TEXT_RE =
  /\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gu;

function redactAndBoundPluginExceptionMessage(value: string): string {
  const redacted = value
    .replace(SENSITIVE_PLUGIN_TEXT_RE, "$1<redacted>")
    .replace(CREDENTIAL_PLUGIN_TEXT_RE, "<redacted>");
  if (redacted.length <= MAX_PLUGIN_EXCEPTION_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_PLUGIN_EXCEPTION_MESSAGE_LENGTH - 3)}...`;
}

export function opaquePluginExceptionMessage(cause: unknown): string {
  const tagged = Result.try({ try: () => TaggedError.is(cause), catch: () => undefined });
  const isTagged = tagged.match({ ok: (value) => value, err: () => undefined });
  if (isTagged === undefined) return "Unknown plugin exception";
  if (isTagged) return "External tagged error";

  if (typeof cause === "string") return redactAndBoundPluginExceptionMessage(cause);
  const errorMessage = Result.try({
    try: () => {
      if (!(cause instanceof Error)) return undefined;
      const message = cause.message;
      return typeof message === "string" && message.length > 0
        ? redactAndBoundPluginExceptionMessage(message)
        : "External Error";
    },
    catch: () => undefined,
  });
  const projected = errorMessage.match({ ok: (value) => value, err: () => null });
  if (projected === null) return "Unknown plugin exception";
  if (projected !== undefined) return projected;
  return Result.try({
    try: () => redactAndBoundPluginExceptionMessage(String(cause)),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => "Unknown plugin exception" });
}

export function safePluginExceptionCause(cause: unknown): Error {
  const safeCause = new Error(opaquePluginExceptionMessage(cause));
  const name = Result.try({
    try: () =>
      cause instanceof Error && cause.name === "ToolInputValidationError"
        ? "ToolInputValidationError"
        : safeCause.name,
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => "Error" });
  safeCause.name = name;
  return safeCause;
}

export function mapCapabilityInspectionException(params: {
  capability: ConstructorParameters<typeof ToolPluginCapabilityError>[0]["capability"];
  pluginId?: string;
  cause: Error;
}): ToolPluginCapabilityError {
  return new ToolPluginCapabilityError({
    capability: params.capability,
    pluginId: params.pluginId,
    issues: [params.cause.message],
    cause: params.cause,
    message: `Failed to inspect ${params.capability} capability${params.pluginId ? ` for plugin '${params.pluginId}'` : ""}`,
  });
}

function invalidCapabilityResult<T>(params: {
  parsed: z.ZodSafeParseError<unknown>;
  capability: ConstructorParameters<typeof ToolPluginCapabilityError>[0]["capability"];
  pluginId?: string;
}): ResultType<T, ToolPluginCapabilityError> {
  return Result.err(
    capabilityError({
      capability: params.capability,
      pluginId: params.pluginId,
      error: params.parsed.error,
    }),
  );
}

function missingCapabilitySnapshot<T>(
  capability: ConstructorParameters<typeof ToolPluginCapabilityError>[0]["capability"],
  pluginId?: string,
): ResultType<T, ToolPluginCapabilityError> {
  return Result.err(
    new ToolPluginCapabilityError({
      capability,
      pluginId,
      issues: ["validated capability snapshot was unavailable"],
      message: `Failed to capture ${capability} capability${pluginId ? ` for plugin '${pluginId}'` : ""}`,
    }),
  );
}

function capturePluginInspection<T, E>(params: {
  run: () => ResultType<T, E>;
  mapException: (cause: Error) => E;
}): ResultType<T, E> {
  const captured = Result.try({ try: params.run, catch: (cause) => ({ cause }) });
  const outcome = captured.match<
    { readonly result: ResultType<T, E> } | { readonly cause: unknown }
  >({
    ok: (result) => ({ result }),
    err: ({ cause }) => ({ cause }),
  });
  if ("result" in outcome) return outcome.result;
  if (isPluginPanic(outcome.cause)) throw outcome.cause;
  return Result.err(params.mapException(safePluginExceptionCause(outcome.cause)));
}

export function decodeDynamicToolPluginModule<TRuntimeContext>(
  value: unknown,
): ResultType<
  DynamicToolPluginModuleCapabilitySnapshot<TRuntimeContext>,
  ToolPluginCapabilityError
> {
  const schema = z.custom<DynamicToolPluginModule<TRuntimeContext>>(
    validateDynamicToolPluginModuleCapability,
  );
  return capturePluginInspection({
    run: () => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        const captured = dynamicToolPluginModuleCapabilities.get(parsed.data);
        if (captured) {
          // The complete validator already captured this exact receiver; only its generic runtime
          // parameter is restored here without reading plugin-owned properties again.
          const plugin = z
            .custom<LilacToolPlugin<TRuntimeContext, Level1ToolSpec<TRuntimeContext>, ServerTool>>()
            .parse(captured.plugin);
          const create = z
            .custom<
              LilacToolPlugin<
                TRuntimeContext,
                Level1ToolSpec<TRuntimeContext>,
                ServerTool
              >["create"]
            >()
            .parse(captured.create);
          return Result.ok({
            module: parsed.data,
            plugin: { plugin, meta: captured.meta, create },
          });
        }
        return missingCapabilitySnapshot("module");
      }
      return invalidCapabilityResult({ parsed, capability: "module" });
    },
    mapException: (cause) => mapCapabilityInspectionException({ capability: "module", cause }),
  });
}

export function decodeToolPlugin<TRuntimeContext>(
  value: unknown,
): ResultType<ToolPluginCapabilitySnapshot<TRuntimeContext>, ToolPluginCapabilityError> {
  const schema = z.custom<
    LilacToolPlugin<TRuntimeContext, Level1ToolSpec<TRuntimeContext>, ServerTool>
  >(validateToolPluginCapability);
  return capturePluginInspection({
    run: () => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        const captured = toolPluginCapabilities.get(parsed.data);
        if (captured) {
          const create = z
            .custom<
              LilacToolPlugin<
                TRuntimeContext,
                Level1ToolSpec<TRuntimeContext>,
                ServerTool
              >["create"]
            >()
            .parse(captured.create);
          return Result.ok({ plugin: parsed.data, meta: captured.meta, create });
        }
        return missingCapabilitySnapshot("plugin");
      }
      return invalidCapabilityResult({ parsed, capability: "plugin" });
    },
    mapException: (cause) => mapCapabilityInspectionException({ capability: "plugin", cause }),
  });
}

export function decodeToolPluginInstance<TRuntimeContext>(
  pluginId: string,
  value: unknown,
): ResultType<ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>, ToolPluginCapabilityError> {
  const schema = z.custom<ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>>(
    validateToolPluginInstanceCapability,
  );
  return capturePluginInspection({
    run: () => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        const captured = toolPluginInstanceCapabilities.get(parsed.data);
        if (captured) {
          const level1 = captured.level1.map((snapshot) => ({
            ...snapshot,
            spec: z.custom<Level1ToolSpec<TRuntimeContext>>().parse(snapshot.spec),
          }));
          return Result.ok({
            instance: parsed.data,
            level1,
            level2: captured.level2,
            init: captured.init,
            destroy: captured.destroy,
          });
        }
        return missingCapabilitySnapshot("instance", pluginId);
      }
      return invalidCapabilityResult({ parsed, capability: "instance", pluginId });
    },
    mapException: (cause) =>
      mapCapabilityInspectionException({ capability: "instance", pluginId, cause }),
  });
}

export function decodeLevel1ToolSpec<TRuntimeContext>(
  pluginId: string,
  value: unknown,
): ResultType<Level1ToolSpecCapabilitySnapshot<TRuntimeContext>, ToolPluginCapabilityError> {
  const schema = z.custom<Level1ToolSpec<TRuntimeContext>>(validateLevel1ToolSpecCapability);
  return capturePluginInspection({
    run: () => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        const captured = level1ToolSpecCapabilities.get(parsed.data);
        if (captured) return Result.ok({ spec: parsed.data, ...captured });
        return missingCapabilitySnapshot("level1", pluginId);
      }
      return invalidCapabilityResult({ parsed, capability: "level1", pluginId });
    },
    mapException: (cause) =>
      mapCapabilityInspectionException({ capability: "level1", pluginId, cause }),
  });
}

export function decodeServerTool(
  pluginId: string,
  value: unknown,
): ResultType<ServerToolCapabilitySnapshot, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = serverToolSchema.safeParse(value);
      if (parsed.success) {
        const captured = serverToolCapabilities.get(parsed.data);
        if (captured) return Result.ok({ tool: parsed.data, ...captured });
        return missingCapabilitySnapshot("level2", pluginId);
      }
      return invalidCapabilityResult({ parsed, capability: "level2", pluginId });
    },
    mapException: (cause) =>
      mapCapabilityInspectionException({ capability: "level2", pluginId, cause }),
  });
}

export function invalidHookResult(params: {
  pluginId: string;
  issues: readonly string[];
}): ToolPluginCapabilityError {
  return new ToolPluginCapabilityError({
    capability: "hook_result",
    pluginId: params.pluginId,
    issues: params.issues,
    message: `Invalid hook result for plugin '${params.pluginId}': ${params.issues.join("; ")}`,
  });
}

export function mapHookResultInspectionException(
  pluginId: string,
  cause: Error,
): ToolPluginCapabilityError {
  const issues = [cause.message];
  return new ToolPluginCapabilityError({
    capability: "hook_result",
    pluginId,
    issues,
    cause,
    message: `Invalid hook result for plugin '${pluginId}': ${issues.join("; ")}`,
  });
}

export function decodeLevel1ExecutableMetadata(
  pluginId: string,
  value: unknown,
): ResultType<Level1ExecutableMetadata, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = level1ExecutableMetadataSchema.safeParse(value);
      return Result.ok(parsed.success ? parsed.data : {});
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeVoidHookResult(
  pluginId: string,
  value: unknown,
): ResultType<void, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = voidHookResultSchema.safeParse(value);
      return parsed.success
        ? Result.ok()
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeBooleanHookResult(
  pluginId: string,
  value: unknown,
): ResultType<boolean, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = booleanHookResultSchema.safeParse(value);
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeStringHookResult(
  pluginId: string,
  value: unknown,
): ResultType<string, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = stringHookResultSchema.safeParse(value);
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeStringArrayHookResult(
  pluginId: string,
  value: unknown,
): ResultType<readonly string[], ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = stringArrayHookResultSchema.safeParse(value);
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeServerToolListResult(
  pluginId: string,
  value: unknown,
): ResultType<ServerToolListResult, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = serverToolListResultShapeSchema.safeParse(value);
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeLevel1ToolFailureSummary(
  pluginId: string,
  value: unknown,
): ResultType<Level1ToolFailureSummary, ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = level1FailureSummaryShapeSchema.safeParse(value);
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(invalidHookResult({ pluginId, issues: [parsed.error.message] }));
    },
    mapException: (cause) => mapHookResultInspectionException(pluginId, cause),
  });
}

export function decodeDisabledPluginIds(
  value: unknown,
): ResultType<readonly string[], ToolPluginCapabilityError> {
  return capturePluginInspection({
    run: () => {
      const parsed = disabledPluginIdsSchema.safeParse(value);
      if (parsed.success) return Result.ok(parsed.data);
      return Result.err(
        new ToolPluginCapabilityError({
          capability: "hook_result",
          issues: [parsed.error.message],
          cause: parsed.error,
          message: `Invalid getDisabledPluginIds result: ${parsed.error.message}`,
        }),
      );
    },
    mapException: (cause) =>
      new ToolPluginCapabilityError({
        capability: "hook_result",
        issues: [cause.message],
        cause,
        message: `Invalid getDisabledPluginIds result: ${cause.message}`,
      }),
  });
}

export function decodeLevel1RegistrationKey(
  pluginId: string,
  value: unknown,
): ResultType<string, ToolPluginManagerHookError> {
  return capturePluginInspection({
    run: () => {
      const parsed = level1RegistrationKeySchema.safeParse(value);
      if (parsed.success) return Result.ok(parsed.data);
      return Result.err(
        new ToolPluginManagerHookError({
          hook: "getLevel1RegistrationKey",
          pluginId,
          cause: parsed.error,
          message: `Plugin manager getLevel1RegistrationKey failed for '${pluginId}': ${parsed.error.message}`,
        }),
      );
    },
    mapException: (cause) =>
      new ToolPluginManagerHookError({
        hook: "getLevel1RegistrationKey",
        pluginId,
        cause,
        message: `Plugin manager getLevel1RegistrationKey failed for '${pluginId}': ${cause.message}`,
      }),
  });
}
