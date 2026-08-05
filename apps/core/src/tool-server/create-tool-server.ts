import Elysia, { NotFoundError } from "elysia";
import {
  createLogger,
  extractAiErrorLogDetails,
  formatTaggedErrorForLog,
  getBuildInfo,
  isPanic,
  isRecord,
  isNativeSubagentProfile,
  profileIncludes,
  resolveNativeSubagentProfile,
  type CoreConfig,
  type NativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import {
  invokeLevel2Call,
  invokeLevel2Destroy,
  invokeLevel2Init,
  invokeLevel2List,
  isPluginPanic,
  opaquePluginExceptionMessage,
  safePluginExceptionCause,
  type Level2ContributionInfo,
  type ServerToolCapabilitySnapshot,
  type ServerToolListResult,
  type ToolPluginCleanupError,
  type ToolPluginCapabilityError,
  type ToolPluginInvocationError,
  type ToolPluginManagerError,
  type ToolPluginStatus,
} from "@stanley2058/lilac-plugin-runtime";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  BridgeFnRequest,
  BridgeFnResponse,
  BridgeListResponse,
  BridgeVersionResponse,
} from "./schema";
import {
  createToolServerHealthState,
  type ToolServerActiveLevel1Work,
  type ToolServerHealthCheck,
  type ToolServerHealthConfig,
  type ToolServerHealthProviderResult,
  type ToolServerHealthSnapshot,
  type ToolServerLagIncident,
} from "./health-state";
import type { RequestContext, ServerTool } from "./types";
import { ToolInputValidationError } from "./validation-error-message";

type ToolPluginManagerLike = {
  init(): Promise<Result<void, ToolPluginManagerError>>;
  destroy(): Promise<Result<void, ToolPluginCleanupError>>;
  reload(): Promise<Result<void, ToolPluginManagerError>>;
  ensureFresh(): Promise<Result<void, ToolPluginManagerError>>;
  getLevel2Tools(): readonly ServerTool[];
  getLevel2ContributionInfo?(): ReadonlyMap<ServerTool, Level2ContributionInfo>;
  getLevel2Capabilities?(): ReadonlyMap<ServerTool, ServerToolCapabilitySnapshot>;
  getStatuses?(): readonly ToolPluginStatus[];
};

type ToolCallTimeoutOptions = {
  defaultTimeoutMs?: number;
  perToolMs?: Record<string, number>;
};

type ToolJsonValue = string | number | boolean | null | ToolJsonValue[] | ToolJsonObject;
type ToolJsonObject = { readonly [key: string]: ToolJsonValue };
type FatalToolCallDefect = Panic | Error;

type ToolRequestHeaders = {
  readonly operatorToken?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly requestClient?: string;
  readonly cwd?: string;
  readonly toolCallId?: string;
  readonly controlCapability?: string;
  readonly subagentProfile?: string;
  readonly safetyMode?: string;
};

type AuthenticatedToolRequest = {
  readonly context: RequestContext;
  readonly messages: readonly unknown[] | undefined;
};

const toolJsonValueSchema: z.ZodType<ToolJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(toolJsonValueSchema),
    z.record(z.string(), toolJsonValueSchema),
  ]),
);
const toolPayloadSchema: z.ZodType<ToolJsonObject> = z.record(z.string(), toolJsonValueSchema);
const toolRequestHeadersSchema = z.object({
  "x-lilac-operator-token": z.string().optional(),
  "x-lilac-request-id": z.string().optional(),
  "x-lilac-session-id": z.string().optional(),
  "x-lilac-request-client": z.string().optional(),
  "x-lilac-cwd": z.string().optional(),
  "x-lilac-tool-call-id": z.string().optional(),
  "x-lilac-control-capability": z.string().optional(),
  "x-lilac-subagent-profile": z.string().optional(),
  "x-lilac-safety-mode": z.string().optional(),
});

const SENSITIVE_PREVIEW_KEYS = new Set([
  "authorization",
  "Authorization",
  "apiKey",
  "apikey",
  "token",
  "access",
  "refresh",
  "idToken",
  "code",
  "pkceVerifier",
  "privateKey",
  "privateKeyPem",
  "private_key",
  "pem",
  "keyPath",
  "password",
]);

class ToolServerOptionsInvalid extends TaggedError("ToolServerOptionsInvalid")<{
  readonly message: string;
}> {}

class ToolRequestHeadersInvalid extends TaggedError("ToolRequestHeadersInvalid")<{
  readonly message: string;
}> {}

class ToolPayloadInvalid extends TaggedError("ToolPayloadInvalid")<{
  readonly message: string;
}> {}

class ToolRequestAuthenticationError extends TaggedError("ToolRequestAuthenticationError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

class ToolSafetyModeResolutionError extends TaggedError("ToolSafetyModeResolutionError")<{
  readonly source: "server-provider" | "config";
  readonly sessionId?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class ToolRouteNotFound extends TaggedError("ToolRouteNotFound")<{
  readonly callableId: string;
  readonly message: string;
}> {}

function projectToolPayloadForPreview(value: ToolJsonValue): ToolJsonValue {
  if (Array.isArray(value)) return value.map(projectToolPayloadForPreview);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]): [string, ToolJsonValue] => [
      key,
      SENSITIVE_PREVIEW_KEYS.has(key) ? "<redacted>" : projectToolPayloadForPreview(nested),
    ]),
  );
}

function safeJsonPreview(value: ToolJsonObject, maxChars = 2000): string {
  const raw = JSON.stringify(projectToolPayloadForPreview(value));
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
}

function safeToolInputPreview(callableId: string, input: ToolJsonObject): string {
  if (callableId === "mcp.add") return "<redacted mcp.add input>";
  if (callableId.startsWith("workflow.")) return "<redacted workflow input>";
  return safeJsonPreview(input);
}

function toolCallErrorOutput(callableId: string, error: Error | string): string {
  if (callableId === "mcp.add") {
    return error instanceof ToolInputValidationError ||
      (error instanceof Error && error.name === "ToolInputValidationError")
      ? "mcp.add input validation failed"
      : "mcp.add failed without exposing sensitive configuration";
  }
  if (error instanceof Error) return error.message;
  return error;
}

function isToolInputValidationCause<TValue>(value: TValue): boolean {
  try {
    return (
      value instanceof ToolInputValidationError ||
      (value instanceof Error && value.name === "ToolInputValidationError")
    );
  } catch {
    return false;
  }
}

function frameworkErrorLogProjection<TError>(error: TError): Readonly<Record<string, string>> {
  try {
    if (TaggedError.is(error)) return formatTaggedErrorForLog(error);
    return { errorMessage: opaquePluginExceptionMessage(error) };
  } catch {
    return { errorMessage: "Unknown framework error" };
  }
}

function toolServerTaggedErrorLogProjection(
  error: ToolPluginManagerError | ToolPluginCleanupError | ToolSafetyModeResolutionError,
  context: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { ...context, ...formatTaggedErrorForLog(error) };
}

function headerStr(header: string | undefined): string | undefined {
  return header && header.length > 0 ? header : undefined;
}

function decodeToolRequestHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): ResultType<ToolRequestHeaders, ToolRequestHeadersInvalid> {
  const decoded = toolRequestHeadersSchema.safeParse(headers);
  if (!decoded.success) {
    return Result.err(
      new ToolRequestHeadersInvalid({ message: "Tool request headers are invalid" }),
    );
  }
  return Result.ok({
    operatorToken: headerStr(decoded.data["x-lilac-operator-token"]),
    requestId: headerStr(decoded.data["x-lilac-request-id"]),
    sessionId: headerStr(decoded.data["x-lilac-session-id"]),
    requestClient: headerStr(decoded.data["x-lilac-request-client"]),
    cwd: headerStr(decoded.data["x-lilac-cwd"]),
    toolCallId: headerStr(decoded.data["x-lilac-tool-call-id"]),
    controlCapability: headerStr(decoded.data["x-lilac-control-capability"]),
    subagentProfile: headerStr(decoded.data["x-lilac-subagent-profile"]),
    safetyMode: headerStr(decoded.data["x-lilac-safety-mode"]),
  });
}

function decodeToolPayload(
  input: Readonly<Record<string, unknown>>,
): ResultType<ToolJsonObject, ToolPayloadInvalid> {
  const decoded = toolPayloadSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(new ToolPayloadInvalid({ message: "Tool input must contain JSON values" }));
}

function parseRequestContext(headers: ToolRequestHeaders): RequestContext {
  return {
    requestId: headers.requestId,
    sessionId: headers.sessionId,
    requestClient: headers.requestClient,
    cwd: headers.cwd,
    toolCallId: headers.toolCallId,
    controlCapability: headers.controlCapability,
    subagentProfile: (() => {
      return isNativeSubagentProfile(headers.subagentProfile) ? headers.subagentProfile : undefined;
    })(),
    safetyMode: headers.safetyMode === "restricted" ? "restricted" : undefined,
  };
}

function authenticateRequestContext(
  context: RequestContext,
  cache: ToolServerOptions["requestMessageCache"],
): readonly unknown[] | undefined {
  if (!context.requestId) return undefined;
  const messages = cache?.get(context.requestId);
  const origin = cache?.getOrigin?.(context.requestId);
  context.serverOwnedRequest =
    messages !== undefined &&
    origin !== undefined &&
    origin.sessionId === context.sessionId &&
    origin.platform === context.requestClient;
  if (context.serverOwnedRequest && origin?.actorUserId) {
    context.authenticatedPrincipal = { platform: origin.platform, userId: origin.actorUserId };
  }
  return messages;
}

type SafetyMode = "trusted" | "restricted";

type ToolCallSuccess = {
  readonly kind: "success";
  toResponse(): { readonly isError: false; readonly output: unknown };
};

function projectToolCallSuccess<TOutput>(output: TOutput): ToolCallSuccess {
  return {
    kind: "success",
    toResponse: () => ({ isError: false, output }),
  };
}

const RESTRICTED_LEVEL2_ALLOWED = new Set([
  "fetch",
  "search",
  "discovery.search",
  "generate.image",
  "generate.video",
  "attachment.add_files",
  "attachment.download",
  "skills.list",
  "skills.brief",
  "skills.full",
  "content.inspect",
  "surface.help",
  "surface.sessions.listParticipants",
  "surface.messages.list",
  "surface.messages.read",
  "surface.messages.send",
  "surface.messages.edit",
  "surface.messages.delete",
  "surface.reactions.list",
  "surface.reactions.listDetailed",
  "surface.reactions.add",
  "surface.reactions.remove",
]);

function isCurrentSessionScopedSurfaceCall(params: {
  callableId: string;
  input: unknown;
  sessionId?: string;
}): boolean {
  if (!params.callableId.startsWith("surface.")) return true;
  if (!params.sessionId) return false;
  if (!params.input || typeof params.input !== "object" || Array.isArray(params.input)) return true;

  const inputSessionId = Reflect.get(params.input, "sessionId");
  if (inputSessionId === undefined || inputSessionId === null || inputSessionId === "") return true;
  return inputSessionId === params.sessionId;
}

function isRestrictedCallableAllowed(params: {
  callableId: string;
  input?: unknown;
  ctx: RequestContext;
}): boolean {
  if (!RESTRICTED_LEVEL2_ALLOWED.has(params.callableId)) return false;
  return isCurrentSessionScopedSurfaceCall({
    callableId: params.callableId,
    input: params.input,
    sessionId: params.ctx.sessionId,
  });
}

function estimateJsonBytes(value: ToolJsonObject): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export type ToolServerOptions = {
  tools?: ServerTool[];
  pluginManager?: ToolPluginManagerLike;
  app?: Elysia;
  logger?: Logger;
  toolCallTimeouts?: ToolCallTimeoutOptions;
  healthConfig?: ToolServerHealthConfig;
  healthProvider?: () => ToolServerHealthProviderResult | Promise<ToolServerHealthProviderResult>;
  activeLevel1WorkProvider?: () => readonly ToolServerActiveLevel1Work[];
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  getConfig?: () => Promise<CoreConfig>;
  /** Optional cache to provide request-scoped messages to tools. */
  requestMessageCache?: {
    get(requestId: string): readonly unknown[] | undefined;
    getOrigin?(requestId: string):
      | {
          sessionId: string;
          platform: "discord" | "github";
          actorUserId: string | null;
        }
      | undefined;
  };
  canonicalWorkspaceRoot?: string;
  operatorTokenSha256?: string;
  authorizeControlRequest?: (input: {
    requestId: string;
    token: string;
    sessionId: string;
    platform: string;
    now: number;
  }) => {
    kind: "primary" | "heartbeat";
    principal: { platform: "discord" | "github"; userId: string } | null;
    allowedCallables: readonly string[] | null;
    profile: "primary" | NativeSubagentProfile;
    canonicalCwd: string;
    safetyMode: SafetyMode;
  } | null;
  resolveServerSafetyMode?: (context: RequestContext) => Promise<SafetyMode>;
  reportFatalToolCallDefect?: (defect: FatalToolCallDefect) => void;
};

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function validateToolServerOptions(
  options: ToolServerOptions,
): ResultType<string | undefined, ToolServerOptionsInvalid> {
  const operatorTokenSha256 = options.operatorTokenSha256?.trim().toLowerCase();
  if (!operatorTokenSha256 || /^[0-9a-f]{64}$/u.test(operatorTokenSha256)) {
    return Result.ok(operatorTokenSha256);
  }
  return Result.err(
    new ToolServerOptionsInvalid({
      message: "operatorTokenSha256 must be a SHA-256 hex digest",
    }),
  );
}

function adaptToolServerOptionsResultToHost(
  result: ResultType<string | undefined, ToolServerOptionsInvalid>,
): string | undefined {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function adaptToolAuthenticationResultToElysia(
  result: ResultType<AuthenticatedToolRequest, ToolRequestAuthenticationError>,
): AuthenticatedToolRequest {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function adaptToolRequestHeadersResultToElysia(
  result: ResultType<ToolRequestHeaders, ToolRequestHeadersInvalid>,
): ToolRequestHeaders {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function adaptToolPayloadResultToElysia(
  result: ResultType<ToolJsonObject, ToolPayloadInvalid>,
): ToolJsonObject {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function adaptSafetyModeResultToElysia(
  result: ResultType<SafetyMode, ToolSafetyModeResolutionError>,
): SafetyMode {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function adaptToolRouteResultToElysia<TValue>(
  result: ResultType<TValue, ToolRouteNotFound>,
): TValue {
  if (result.status === "ok") return result.value;
  throw new NotFoundError(result.error.message);
}

function adaptPluginLifecycleResultToHost(
  operation: string,
  result: ResultType<void, ToolPluginManagerError | ToolPluginCleanupError>,
): void {
  if (result.status === "ok") return;
  const formatted = formatTaggedErrorForLog(result.error);
  throw new Error(`Tool plugin ${operation} failed: ${formatted.errorMessage}`);
}

function adaptPluginListResultToElysia(
  result: ResultType<ServerToolListResult, ToolPluginInvocationError | ToolPluginCapabilityError>,
): ServerToolListResult {
  if (result.status === "ok") return result.value;
  const formatted = formatTaggedErrorForLog(result.error);
  throw new Error(`Tool plugin level2.list failed: ${formatted.errorMessage}`);
}

function adaptPanicToToolServerHost(panic: Panic): never {
  throw panic;
}

function projectUnhandledRejectionReason(reason: unknown): string {
  return opaquePluginExceptionMessage(reason);
}

function createDeadlineSignal(timeoutMs: number): {
  signal: AbortSignal;
  cancel(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool call exceeded deadline (${timeoutMs}ms)`));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
  };
}

function timeoutForTool(toolId: string, options?: ToolCallTimeoutOptions): number {
  return options?.perToolMs?.[toolId] ?? options?.defaultTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

function countLoadedExternalPlugins(statuses: readonly ToolPluginStatus[] | undefined): number {
  if (!statuses) return 0;
  return statuses.filter((status) => status.source === "external" && status.state === "loaded")
    .length;
}

function projectFatalToolCallDefect(reason: unknown): FatalToolCallDefect {
  if (isPluginPanic(reason)) return reason;
  return safePluginExceptionCause(reason);
}

function signalFatalToolCallDefectToProcess(defect: FatalToolCallDefect): void {
  queueMicrotask(() => {
    throw defect;
  });
}

function observeToolCallRejection(
  context: {
    readonly didTimeout: () => boolean;
    readonly report: (defect: FatalToolCallDefect) => void;
  },
  defect: FatalToolCallDefect,
): void {
  if (!context.didTimeout() && !isPluginPanic(defect)) return;
  context.report(defect);
}

function superviseToolCallRejections(context: {
  readonly didTimeout: () => boolean;
  readonly promise: Promise<unknown>;
  readonly report: (defect: FatalToolCallDefect) => void;
}): void {
  const defect = context.promise.then(() => null, projectFatalToolCallDefect);
  void defect.then((reason) => {
    if (reason === null) return;
    observeToolCallRejection(
      {
        didTimeout: context.didTimeout,
        report: context.report,
      },
      reason,
    );
  });
}

export function createToolServer(options: ToolServerOptions) {
  const operatorTokenSha256 = adaptToolServerOptionsResultToHost(
    validateToolServerOptions(options),
  );
  const logger =
    options.logger ??
    createLogger({
      module: "tool-server",
    });

  const staticTools = options.tools ?? [];
  const serverStartedAt = Date.now();

  let callMapping = new Map<string, ServerTool>();
  let level2ContributionMapping = new Map<string, Level2ContributionInfo>();
  const healthState = createToolServerHealthState({
    logger,
    pluginManager: options.pluginManager,
    externalHealthProvider: options.healthProvider,
    activeLevel1WorkProvider: options.activeLevel1WorkProvider,
    onUnhealthy: options.onUnhealthy,
    ...options.healthConfig,
  });

  function logPluginError(
    operation: string,
    error: ToolPluginManagerError | ToolPluginCleanupError,
    context: Readonly<Record<string, unknown>> = {},
  ): void {
    logger.error(
      "tool plugin operation failed",
      toolServerTaggedErrorLogProjection(error, { operation, ...context }),
    );
  }

  function pluginCallCompatibilityError(
    error: ToolPluginInvocationError | ToolPluginCapabilityError,
  ): Error {
    if (error._tag !== "ToolPluginHookError") {
      return new Error(formatTaggedErrorForLog(error).errorMessage);
    }
    const compatibilityError = new Error(opaquePluginExceptionMessage(error.cause));
    if (isToolInputValidationCause(error.cause))
      compatibilityError.name = "ToolInputValidationError";
    return compatibilityError;
  }

  async function requirePluginLifecycle(
    operation: "init" | "reload" | "ensureFresh",
    run: () => Promise<Result<void, ToolPluginManagerError>>,
  ): Promise<ResultType<void, ToolPluginManagerError>> {
    const result = await run();
    if (result.status === "ok") return result;
    logPluginError(operation, result.error);
    if (result.error._tag === "ToolPluginReloadCommittedCleanupError") return Result.ok();
    return result;
  }

  function contributionForTool(tool: ServerTool): Level2ContributionInfo {
    return (
      options.pluginManager?.getLevel2ContributionInfo?.().get(tool) ?? {
        pluginId: `static:${toolId(tool)}`,
        source: "builtin",
      }
    );
  }

  function toolId(tool: ServerTool): string {
    return options.pluginManager?.getLevel2Capabilities?.().get(tool)?.id ?? tool.id;
  }

  async function listTool(tool: ServerTool) {
    const contribution = contributionForTool(tool);
    return invokeLevel2List({
      pluginId: contribution.pluginId,
      source: contribution.source,
      tool,
      capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
    });
  }

  async function runStaticToolLifecycle(
    operation: "level2.init" | "level2.destroy",
  ): Promise<void> {
    const settledResults = await Promise.allSettled(
      staticTools.map((tool) => {
        const contribution = contributionForTool(tool);
        const params = {
          pluginId: contribution.pluginId,
          source: contribution.source,
          tool,
          capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
        };
        return operation === "level2.init" ? invokeLevel2Init(params) : invokeLevel2Destroy(params);
      }),
    );
    let panic: Panic | undefined;
    for (const settled of settledResults) {
      if (settled.status === "rejected") {
        if (!isPluginPanic(settled.reason)) {
          return adaptPanicToToolServerHost(
            new Panic({
              message: `Unexpected ${operation} cleanup rejection`,
              cause: settled.reason,
            }),
          );
        }
        if (panic === undefined) panic = settled.reason;
      } else if (settled.value.status === "error") {
        logPluginError(operation, settled.value.error);
      }
    }
    if (panic) return adaptPanicToToolServerHost(panic);
  }

  async function getActiveTools(): Promise<readonly ServerTool[]> {
    const pluginManager = options.pluginManager;
    if (pluginManager) {
      adaptPluginLifecycleResultToHost(
        "ensureFresh",
        await requirePluginLifecycle("ensureFresh", () => pluginManager.ensureFresh()),
      );
      return pluginManager.getLevel2Tools();
    }
    return staticTools;
  }

  async function refreshToolMapping() {
    const nextCallMapping = new Map<string, ServerTool>();
    const nextContributionMapping = new Map<string, Level2ContributionInfo>();
    const activeTools = await getActiveTools();
    const contributionByTool = options.pluginManager?.getLevel2ContributionInfo?.();
    for (const tool of activeTools) {
      const listed = await listTool(tool);
      if (listed.status === "error") {
        logPluginError("level2.list", listed.error, { toolId: toolId(tool) });
        continue;
      }
      for (const { callableId } of listed.value) {
        nextCallMapping.set(callableId, tool);
        const contribution = contributionByTool?.get(tool);
        if (contribution) nextContributionMapping.set(callableId, contribution);
      }
    }
    callMapping = nextCallMapping;
    level2ContributionMapping = nextContributionMapping;
  }

  async function ensureFreshToolMapping() {
    await refreshToolMapping();
  }

  async function captureSafetyModeProvider<TValue extends SafetyMode | CoreConfig>(
    ctx: RequestContext,
    source: "server-provider" | "config",
    provider: () => Promise<TValue>,
  ): Promise<ResultType<TValue, ToolSafetyModeResolutionError>> {
    return Result.tryPromise({
      try: provider,
      catch: <TCause>(cause: TCause) => {
        if (isPanic(cause)) return adaptPanicToToolServerHost(cause);
        return new ToolSafetyModeResolutionError({
          source,
          sessionId: ctx.sessionId,
          cause: safePluginExceptionCause(cause),
          message: opaquePluginExceptionMessage(cause),
        });
      },
    });
  }

  function captureAuthenticationOperation<TValue>(
    run: () => TValue,
  ): Promise<ResultType<Awaited<TValue>, ToolRequestAuthenticationError>> {
    return Result.tryPromise({
      try: () => Promise.resolve(run()),
      catch: <TCause>(cause: TCause) => {
        if (isPanic(cause)) return adaptPanicToToolServerHost(cause);
        return new ToolRequestAuthenticationError({
          cause: safePluginExceptionCause(cause),
          message: opaquePluginExceptionMessage(cause),
        });
      },
    });
  }

  async function resolveSafetyMode(
    ctx: RequestContext,
  ): Promise<ResultType<SafetyMode, ToolSafetyModeResolutionError>> {
    if (ctx.operator) return Result.ok("trusted");
    if (ctx.controlPolicy) return Result.ok(ctx.safetyMode ?? "restricted");
    if (ctx.safetyMode === "restricted") return Result.ok("restricted");
    const serverSafetyModeProvider = options.resolveServerSafetyMode;
    if (serverSafetyModeProvider) {
      const resolved = await captureSafetyModeProvider(ctx, "server-provider", () =>
        serverSafetyModeProvider(ctx),
      );
      if (resolved.status === "error") return resolved;
      return Result.ok(resolved.value);
    }
    const sessionId = ctx.sessionId;
    if (!sessionId || !options.getConfig) return Result.ok("trusted");
    const loaded = await captureSafetyModeProvider(ctx, "config", options.getConfig);
    if (loaded.status === "error") return loaded;
    return Result.ok(loaded.value.surface.router.sessionModes[sessionId]?.safetyMode ?? "trusted");
  }

  function resolveSafetyModeFailClosed(
    result: ResultType<SafetyMode, ToolSafetyModeResolutionError>,
  ): SafetyMode {
    if (result.status === "ok") return result.value;
    if (result.error.source === "server-provider") {
      return adaptSafetyModeResultToElysia(result);
    }
    logger.warn(
      "failed to resolve tool request safety mode",
      toolServerTaggedErrorLogProjection(result.error),
    );
    return "restricted";
  }

  async function listToolsForContext(ctx: RequestContext) {
    const safetyMode = resolveSafetyModeFailClosed(await resolveSafetyMode(ctx));
    const tools = await getActiveTools();
    const toolDescs = await Promise.all(tools.map((tool) => listTool(tool)));

    const visible: Array<{
      callableId: string;
      name: string;
      description: string;
      shortInput: string[];
      primaryPositional?: import("@stanley2058/lilac-plugin-runtime").ServerToolPrimaryPositional;
      hidden?: boolean;
    }> = [];
    for (const result of toolDescs) {
      if (result.status === "error") {
        logPluginError("level2.list", result.error);
        continue;
      }
      for (const entry of result.value) {
        if (!isCallableAllowedForControlCapability(entry.callableId, ctx)) continue;
        if (!(await isCallableAllowedForNativeProfile(entry.callableId, ctx))) continue;
        if (
          safetyMode === "restricted" &&
          !isRestrictedCallableAllowed({ callableId: entry.callableId, ctx })
        ) {
          continue;
        }
        visible.push({
          callableId: entry.callableId,
          name: entry.name,
          description: entry.description,
          shortInput: entry.shortInput,
          primaryPositional: entry.primaryPositional,
          hidden: entry.hidden,
        });
      }
    }
    return { tools: visible };
  }

  async function isCallableAllowedForNativeProfile(
    callableId: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    if (!ctx.subagentProfile) return true;
    if (!options.getConfig) return options.pluginManager === undefined;
    const contribution = level2ContributionMapping.get(callableId);
    if (!contribution) return false;
    const profile = resolveNativeSubagentProfile(await options.getConfig(), ctx.subagentProfile);
    return (
      profileIncludes(profile.level2.plugins, contribution.pluginId) &&
      profileIncludes(profile.level2.callables, callableId)
    );
  }

  function isCallableAllowedForControlCapability(callableId: string, ctx: RequestContext): boolean {
    if (ctx.controlPolicy?.kind !== "heartbeat") return true;
    return ctx.controlPolicy.allowedCallables?.includes(callableId) === true;
  }

  async function authenticateContext(
    headers: ToolRequestHeaders,
  ): Promise<ResultType<AuthenticatedToolRequest, ToolRequestAuthenticationError>> {
    const operatorToken = headers.operatorToken;
    if (operatorToken) {
      if (!operatorTokenSha256) {
        return Result.err(
          new ToolRequestAuthenticationError({ message: "Operator access is unavailable" }),
        );
      }
      const suppliedHash = createHash("sha256").update(operatorToken).digest();
      const expectedHash = Buffer.from(operatorTokenSha256, "hex");
      if (!timingSafeEqual(suppliedHash, expectedHash)) {
        return Result.err(
          new ToolRequestAuthenticationError({ message: "Operator token is invalid" }),
        );
      }
      if (!options.canonicalWorkspaceRoot) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Operator access requires a canonical workspace root",
          }),
        );
      }
      return Result.ok({
        context: {
          requestId: headers.requestId,
          toolCallId: headers.toolCallId,
          cwd: options.canonicalWorkspaceRoot,
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
        messages: undefined,
      });
    }
    const context = parseRequestContext(headers);
    const cachedMessages = await captureAuthenticationOperation(() =>
      authenticateRequestContext(context, options.requestMessageCache),
    );
    if (cachedMessages.status === "error") return cachedMessages;
    const messages = cachedMessages.value;
    if (options.authorizeControlRequest) {
      const authorizeControlRequest = options.authorizeControlRequest;
      if (
        !context.controlCapability ||
        !context.requestId ||
        !context.sessionId ||
        !context.requestClient ||
        !context.cwd
      ) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Level-2 tools require an active server-issued request capability",
          }),
        );
      }
      const requestId = context.requestId;
      const controlCapability = context.controlCapability;
      const sessionId = context.sessionId;
      const requestClient = context.requestClient;
      const authorization = await captureAuthenticationOperation(() =>
        authorizeControlRequest({
          requestId,
          token: controlCapability,
          sessionId,
          platform: requestClient,
          now: Date.now(),
        }),
      );
      if (authorization.status === "error") return authorization;
      const authorized = authorization.value;
      if (!authorized) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Request control capability is invalid or expired",
          }),
        );
      }
      context.serverOwnedRequest = true;
      context.cwd = authorized.canonicalCwd;
      context.safetyMode = authorized.safetyMode;
      context.controlPolicy = {
        kind: authorized.kind,
        allowedCallables: authorized.allowedCallables,
      };
      context.subagentProfile = authorized.profile === "primary" ? undefined : authorized.profile;
      if (authorized.principal) context.authenticatedPrincipal = authorized.principal;
    }
    return Result.ok({ context, messages });
  }

  function lookupTool(callableId: string): ResultType<ServerTool, ToolRouteNotFound> {
    const tool = callMapping.get(callableId);
    if (tool) return Result.ok(tool);
    return Result.err(
      new ToolRouteNotFound({
        callableId,
        message: `Unknown callable ID '${callableId}'`,
      }),
    );
  }

  async function lookupHelpTool(params: {
    readonly callableId: string;
    readonly context: RequestContext;
    readonly safetyMode: SafetyMode;
  }): Promise<ResultType<ServerTool, ToolRouteNotFound>> {
    if (
      !isCallableAllowedForControlCapability(params.callableId, params.context) ||
      !(await isCallableAllowedForNativeProfile(params.callableId, params.context)) ||
      (params.safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: params.callableId, ctx: params.context }))
    ) {
      return Result.err(
        new ToolRouteNotFound({
          callableId: params.callableId,
          message: `Unknown callable ID '${params.callableId}'`,
        }),
      );
    }
    return lookupTool(params.callableId);
  }

  const app = options.app ?? new Elysia();

  app.onError(({ code, error }) => {
    logger.error("tool-server error", { code, ...frameworkErrorLogProjection(error) });
  });

  app.get("/health", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.live) set.status = 503;
    return snapshot;
  });

  app.get("/healthz", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.live) set.status = 503;
    return snapshot;
  });

  app.get("/readyz", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.ready) set.status = 503;
    return snapshot;
  });

  app.get(
    "/versionz",
    async () => {
      if (options.pluginManager) {
        const pluginManager = options.pluginManager;
        adaptPluginLifecycleResultToHost(
          "ensureFresh",
          await requirePluginLifecycle("ensureFresh", () => pluginManager.ensureFresh()),
        );
      }

      const buildInfo = getBuildInfo({ cwd: MODULE_DIR });
      const loadedExternalPlugins = countLoadedExternalPlugins(
        options.pluginManager?.getStatuses?.(),
      );

      return {
        ok: true as const,
        version: buildInfo.version,
        commit: buildInfo.commit,
        dirty: buildInfo.dirty,
        builtAt: buildInfo.builtAt,
        plugins: {
          loadedExternal: loadedExternalPlugins,
        },
        startedAt: serverStartedAt,
        pid: process.pid,
      };
    },
    {
      response: BridgeVersionResponse,
    },
  );

  app.get(
    "/list",
    async ({ headers }) => {
      await ensureFreshToolMapping();
      const decodedHeaders = adaptToolRequestHeadersResultToElysia(
        decodeToolRequestHeaders(headers),
      );
      const { context } = adaptToolAuthenticationResultToElysia(
        await authenticateContext(decodedHeaders),
      );
      return await listToolsForContext(context);
    },
    {
      response: BridgeListResponse,
    },
  );

  app.post("/reload", async () => {
    if (options.pluginManager) {
      const pluginManager = options.pluginManager;
      adaptPluginLifecycleResultToHost(
        "reload",
        await requirePluginLifecycle("reload", () => pluginManager.reload()),
      );
    } else {
      await runStaticToolLifecycle("level2.destroy");
      await runStaticToolLifecycle("level2.init");
    }
    await refreshToolMapping();
    return { ok: true as const };
  });

  app.get("/help/:callableId", async ({ params, headers }) => {
    await ensureFreshToolMapping();
    const decodedHeaders = adaptToolRequestHeadersResultToElysia(decodeToolRequestHeaders(headers));
    const { context: ctx } = adaptToolAuthenticationResultToElysia(
      await authenticateContext(decodedHeaders),
    );
    const safetyMode = resolveSafetyModeFailClosed(await resolveSafetyMode(ctx));
    const tool = adaptToolRouteResultToElysia(
      await lookupHelpTool({ callableId: params.callableId, context: ctx, safetyMode }),
    );
    const listed = await listTool(tool);
    if (listed.status === "error") {
      logPluginError("level2.list", listed.error, { toolId: toolId(tool) });
    }
    const desc = adaptPluginListResultToElysia(listed);
    const output = desc.find(
      (entry: Awaited<ReturnType<ServerTool["list"]>>[number]) =>
        entry.callableId === params.callableId,
    );
    if (!output) {
      return adaptToolRouteResultToElysia(
        Result.err(
          new ToolRouteNotFound({
            callableId: params.callableId,
            message: `Unknown callable ID '${params.callableId}'`,
          }),
        ),
      );
    }
    return output;
  });

  app.post(
    "/call",
    async ({ body, request, headers }) => {
      await ensureFreshToolMapping();
      const startedAt = Date.now();

      const tool = adaptToolRouteResultToElysia(lookupTool(body.callableId));

      const decodedHeaders = adaptToolRequestHeadersResultToElysia(
        decodeToolRequestHeaders(headers),
      );
      const { context: ctx, messages } = adaptToolAuthenticationResultToElysia(
        await authenticateContext(decodedHeaders),
      );
      const input = adaptToolPayloadResultToElysia(decodeToolPayload(body.input));
      const safetyMode = resolveSafetyModeFailClosed(await resolveSafetyMode(ctx));
      ctx.safetyMode = safetyMode;
      if (
        ctx.controlPolicy?.kind === "heartbeat" &&
        body.callableId === "surface.messages.send" &&
        isRecord(input) &&
        ["paths", "filenames", "mimeTypes"].some((key) => input[key] !== undefined)
      ) {
        return {
          isError: true,
          output: "Heartbeat surface messages are text-only and cannot include attachments",
        };
      }
      if (!isCallableAllowedForControlCapability(body.callableId, ctx)) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is outside the internal request capability`,
        };
      }
      if (!(await isCallableAllowedForNativeProfile(body.callableId, ctx))) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is not enabled for this subagent profile`,
        };
      }
      if (
        safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: body.callableId, input, ctx })
      ) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is not allowed in restricted public-session mode`,
        };
      }
      const inputBytes = estimateJsonBytes(input);
      const capturedToolId = toolId(tool);
      const timeoutMs = timeoutForTool(capturedToolId, options.toolCallTimeouts);
      const deadlineAt = Date.now() + timeoutMs;
      const timeoutSignal = createDeadlineSignal(timeoutMs);
      const combinedSignal = AbortSignal.any([request.signal, timeoutSignal.signal]);
      const callToken = healthState.beginToolCall({
        toolId: capturedToolId,
        callableId: body.callableId,
        deadlineAt,
        requestId: ctx.requestId,
      });

      logger.debug("tool call", {
        callableId: body.callableId,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        requestClient: ctx.requestClient,
        operator: ctx.operator === true,
        cwd: ctx.cwd,
        inputBytes,
        timeoutMs,
      });

      logger.debug("tool call input", {
        callableId: body.callableId,
        input: safeToolInputPreview(body.callableId, input),
      });

      const toolErrorResponse = (error: Error) => {
        const errorLogDetails = {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          inputBytes,
          durationMs: Date.now() - startedAt,
          timeoutMs,
          ok: false,
          errorClass: error.name,
          cancelled: combinedSignal.aborted,
        };
        if (body.callableId === "mcp.add") {
          // mcp.add accepts arbitrary credential-bearing strings. Do not inspect or serialize
          // unexpected failures because providers may echo partial command-line values.
          logger.error("tool.call.result", {
            ...errorLogDetails,
            errorClass: error.name === "ToolInputValidationError" ? error.name : "McpAddError",
          });
        } else {
          logger.error(
            "tool.call.result",
            {
              ...errorLogDetails,
              ...extractAiErrorLogDetails(error),
            },
            error,
          );
        }
        return {
          isError: true,
          output: toolCallErrorOutput(body.callableId, error),
        };
      };

      if (!ctx.operator && (!ctx.requestId || !ctx.sessionId || !ctx.requestClient)) {
        logger.warn("tool.call.context_missing", {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          hasRequestId: Boolean(ctx.requestId),
          hasSessionId: Boolean(ctx.sessionId),
          hasRequestClient: Boolean(ctx.requestClient),
        });
      }

      const contribution = contributionForTool(tool);
      let toolCallTimedOut = false;
      const callResult = Promise.resolve()
        .then(() =>
          invokeLevel2Call({
            pluginId: contribution.pluginId,
            source: contribution.source,
            tool,
            capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
            callableId: body.callableId,
            input,
            opts: {
              signal: combinedSignal,
              context: ctx,
              messages,
            },
          }),
        )
        .then((output) => {
          const success = output.map(projectToolCallSuccess);
          if (success.status === "ok") return success.value;
          if (body.callableId !== "mcp.add") {
            logPluginError("level2.call", success.error, {
              toolId: capturedToolId,
              callableId: body.callableId,
            });
          }
          return {
            kind: "error" as const,
            error: pluginCallCompatibilityError(success.error),
          };
        })
        .finally(() => {
          healthState.endToolCall(callToken, {
            settled: true,
          });
        })
        .finally(() => {
          timeoutSignal.cancel();
        });
      superviseToolCallRejections({
        didTimeout: () => toolCallTimedOut,
        promise: callResult,
        report: options.reportFatalToolCallDefect ?? signalFatalToolCallDefectToProcess,
      });

      const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutSignal.signal.addEventListener(
          "abort",
          () => {
            toolCallTimedOut = true;
            resolve({ kind: "timeout" });
          },
          { once: true },
        );
      });

      const result = await Promise.race([callResult, timeoutResult]);

      if (result.kind === "timeout") {
        healthState.endToolCall(callToken, {
          settled: false,
          timedOut: true,
          failed: true,
          cancelled: true,
        });
        logger.error("tool.call.result", {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          inputBytes,
          durationMs: Date.now() - startedAt,
          ok: false,
          timeoutMs,
          timedOut: true,
        });
        return {
          isError: true,
          output: `Tool call timed out after ${timeoutMs}ms`,
        };
      }

      if (result.kind === "error") {
        return toolErrorResponse(result.error);
      }

      logger.info("tool.call.result", {
        callableId: body.callableId,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        requestClient: ctx.requestClient,
        hasMessagesContext: Array.isArray(messages) && messages.length > 0,
        inputBytes,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        ok: true,
      });
      return result.toResponse();
    },
    {
      body: BridgeFnRequest,
      response: {
        200: BridgeFnResponse,
      },
    },
  );

  let started = false;

  function recordUnhandledRejectionAtBoundary(reason: unknown): void {
    healthState.recordUnhandledRejection(projectUnhandledRejectionReason(reason));
  }

  return {
    app,
    init: async () => {
      if (options.pluginManager) {
        const pluginManager = options.pluginManager;
        adaptPluginLifecycleResultToHost(
          "init",
          await requirePluginLifecycle("init", () => pluginManager.init()),
        );
      } else {
        await runStaticToolLifecycle("level2.init");
      }
      await refreshToolMapping();
      healthState.markInitialized(true);
    },
    start: async (port: number) => {
      if (started) return;
      started = true;
      healthState.startMonitoring();

      // Elysia listen is sync-ish, but server becomes available shortly after.
      app.listen(port);
      healthState.markListening(true);
      logger.info(`Tool server listening on port ${app.server?.hostname}:${app.server?.port}`);
    },
    stop: async () => {
      healthState.markListening(false);
      healthState.markInitialized(false);
      healthState.stopMonitoring();
      try {
        if (options.pluginManager) {
          const destroyed = await options.pluginManager.destroy();
          if (destroyed.status === "error") logPluginError("destroy", destroyed.error);
        } else {
          await runStaticToolLifecycle("level2.destroy");
        }
      } finally {
        if (started) app.stop();
        started = false;
      }
    },
    getHealthSnapshot: async () => await healthState.getSnapshot(),
    recordUnhandledRejection: recordUnhandledRejectionAtBoundary,
  };
}

export type {
  ToolServerActiveLevel1Work,
  ToolServerHealthCheck,
  ToolServerHealthConfig,
  ToolServerHealthProviderResult,
  ToolServerHealthSnapshot,
  ToolServerLagIncident,
};
