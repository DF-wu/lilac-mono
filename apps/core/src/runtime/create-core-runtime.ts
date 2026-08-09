import Redis from "ioredis";
import type { LogLevel } from "@stanley2058/simple-module-logger";
import {
  createLogger,
  env,
  errorMessage,
  formatTaggedErrorForLog,
  getCoreConfig,
  getOpenObserveDiagnostics,
  isPanic,
  readCoreConfigVersionResult,
  resolveDiscordDbPath,
  resolveCoreConfigPath,
  resolveCustomCommandsDir,
  resolveDiscoveryDbPath,
  resolveDiscordSearchDbPath,
  resolveTranscriptDbPath,
  toDurableResolvedModelRequest,
  toDurableResolvedModelPlan,
  type CustomCommandDiscoveryError,
} from "@stanley2058/lilac-utils";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import {
  createLilacBus,
  createRedisStreamsBus,
  lilacEventTypes,
  RedisEventDeadLetter,
  type CreateLilacBusOptions,
  type EventDeliveryFatalReporter,
  type EventDeliveryDoneError,
  type EventDeliveryLogContext,
  type EventDeliveryLogger,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import { DiscordAdapter } from "../surface/discord/discord-adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../surface/discord/discord-runtime-descriptor";
import { GithubAdapter } from "../surface/github/github-adapter";
import {
  createConfiguredGithubSurfaceRuntimeDescriptor,
  createGithubRelayPolicy,
} from "../surface/github/github-runtime-descriptor";
import { bridgeAdapterToBus } from "../surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../surface/bridge/subscribe-from-bus";
import {
  startDiscordRequestRouter,
  type DiscordRequestRouter,
} from "../surface/discord/discord-request-router";
import {
  resolveAgentRunModel,
  resolveAgentRunModelFallbacks,
  isWorkflowAgentRecoveryEntry,
  startBusAgentRunner,
} from "../surface/bridge/bus-agent-runner";
import { startDiscordSearchIndexer } from "../surface/bridge/discord-search-indexer";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { DiscordSearchService, DiscordSearchStore } from "../surface/store/discord-search-store";
import { DiscordSurfaceStore } from "../surface/store/discord-surface-store";
import { createDiscordEntityMapper } from "../entity/entity-mapper";
import { DiscoveryService } from "../discovery/discovery-service";
import {
  createConversationThreadToolService,
  ConversationThreadService,
  type ConversationThreadRunSummarizationInput,
  type ConversationThreadToolService,
} from "../conversation/thread-service";
import { ConversationThreadStore } from "../conversation/thread-store";
import { createConversationThreadEmbeddingAdapterResolver } from "../conversation/thread-embedding";
import {
  startConversationThreadMaterializer,
  type ConversationThreadMaterializer,
} from "../conversation/thread-materializer-worker";
import {
  startConversationThreadSummarizationWorker,
  startConversationThreadWorker,
  ConversationThreadSummarizationRuntimeError,
  ConversationThreadSummarizationTransportError,
  type ConversationThreadSummarizationRuntimeOperation,
  type ConversationThreadSummarizationRunner,
} from "../conversation/thread-worker";

import { readGithubAppSecretResult } from "../github/github-app";
import { startGithubWebhookServer } from "../github/webhook/github-webhook-server";

import { SqliteTranscriptStore } from "../transcript/transcript-store";
import { isHeartbeatSessionId } from "../heartbeat/common";
import { startHeartbeatServiceResult, type HeartbeatService } from "../heartbeat/heartbeat-service";

import { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../workflow/workflow-action-resolver";
import { WorkflowProgressProjector } from "../workflow/workflow-progress-projector";
import { WorkflowEngine } from "../workflow/workflow-engine";
import { WorkflowWaitResolver } from "../workflow/workflow-wait-resolver";
import { WorkflowTriggerScheduler } from "../workflow/workflow-trigger-scheduler";
import { shouldSuppressRouterForWorkflowReply } from "../workflow/workflow-router-suppression";
import { WorkflowLiveParentBridge } from "../workflow/workflow-live-parent-bridge";
import { WorkflowSubagentDispatcher } from "../workflow/workflow-subagent-dispatcher";

import { createToolServer } from "../tool-server/create-tool-server";
import { resolveConversationThreadSummarizationToolOperation } from "../tool-server/tools/conversation-thread";
import {
  HEARTBEAT_LEVEL2_CALLABLES,
  RequestControlAuthority,
} from "../tool-server/request-control-authority";
import type {
  ToolServerHealthCheck,
  ToolServerHealthProviderResult,
  ToolServerHealthSnapshot,
} from "../tool-server/create-tool-server";
import {
  createRequestMessageCache,
  type RequestMessageCache,
} from "../tool-server/request-message-cache";
import { createCoreToolPluginManager, type CoreToolPluginManager } from "../plugins";
import { CustomCommandManager } from "../custom-commands/manager";
import { handleCoreConfigWatchEvent } from "./core-config-watch";
import { loadOrCreateCoreDeadLetterKey, type CoreDeadLetterKeyError } from "./core-dead-letter-key";
import { projectRuntimeError, safeRuntimeErrorText } from "./error-format";
import { SqliteGracefulRestartStore, type GracefulRestartSnapshot } from "./graceful-restart-store";
import {
  connectAndValidateSurfaceAdapters,
  createSurfaceAdapterMap,
  disconnectSurfaceAdapters,
  restoreSurfaceRecovery,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopIngressAndDrainSurfaceRecovery,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  stopSurfaceRequestIngress,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "./surface-runtime-lifecycle";
import {
  SurfaceRuntimeRegistry,
  type RegisteredSurfacePlatform,
  type SurfaceRelayHandle,
} from "../surface/runtime-descriptor";
import { prewarmFffFinders } from "@stanley2058/lilac-fs";
import {
  adaptToolResultArtifactStoreInitToHost,
  createToolResultArtifactStore,
} from "../artifacts/tool-result-artifact-store";
import {
  createEmptyMcpConfig,
  createMcpRegistryResult,
  McpOAuthCallbackService,
  McpOAuthProviderService,
  readMcpConfigFile,
  rethrowPanic,
  resolveMcpConfigPath,
  type McpOAuthCallbackListenerStatus,
  type McpRegistryOptionsInvalid,
  type UniversalMcpConfig,
} from "../mcp";

export type CoreRuntime = {
  start(): Promise<CoreRuntimeStartOutcome>;
  stop(priorPanic?: Panic | null): Promise<void>;
  recordUnhandledRejection(reason: Error): void;
};

class CoreRuntimeExternalFailure extends TaggedError("CoreRuntimeExternalFailure")<{
  readonly operation: "reload-config" | "start-config-watcher";
  readonly cause: Error;
  readonly message: string;
}> {}

export class CoreRuntimeCreateFailed extends TaggedError("CoreRuntimeCreateFailed")<{
  readonly operation: "event-bus" | "custom-commands" | "mcp-registry";
  readonly cause: CoreEventBusSetupError | CustomCommandDiscoveryError | McpRegistryOptionsInvalid;
  readonly message: string;
}> {}

export type CoreRuntimeCreateOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<CoreRuntime, CoreRuntimeCreateFailed>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export class CoreRuntimeStartFailed extends TaggedError("CoreRuntimeStartFailed")<{
  readonly operation: "startup" | "heartbeat";
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CoreRuntimeStartOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<void, CoreRuntimeStartFailed>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export type CoreRuntimeOptions = {
  /** Where core tools operate (fs/bash tool root). Default: $LILAC_WORKSPACE_DIR or $DATA_DIR/workspace. */
  cwd?: string;
  toolServerPort?: number;
  /** Prefix for Redis consumer group ids / subscription ids. Default: "core". */
  subscriptionPrefix?: string;
  /** Override log level. Default: LOG_LEVEL env or "info". */
  logLevel?: LogLevel;
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  reportFatalError: (error: Error) => void;
};

type CoreEventBusLogSink = {
  warn(message: string, context: EventDeliveryLogContext): void;
  error(message: string, context: EventDeliveryLogContext): void;
};

const CORE_EVENT_BUS_LOG_FIELDS = [
  "topic",
  "cursor",
  "source",
  "stage",
  "eventType",
  "mode",
  "phase",
] as const satisfies readonly (keyof EventDeliveryLogContext)[];

function redactEventDeliveryLogContext(context: EventDeliveryLogContext): EventDeliveryLogContext {
  const redacted: Record<string, string | number | boolean | undefined> = {};
  for (const field of CORE_EVENT_BUS_LOG_FIELDS) {
    if (Object.hasOwn(context, field)) redacted[field] = context[field];
  }
  return redacted;
}

export function createCoreEventBusLogger(logger: CoreEventBusLogSink): EventDeliveryLogger {
  return {
    warn(event, context) {
      logger.warn(event, redactEventDeliveryLogContext(context));
    },
    error(event, context) {
      logger.error(event, redactEventDeliveryLogContext(context));
    },
  };
}

export function createCoreEventBusFatalReporter(
  reportFatalError: (error: Error) => void,
): EventDeliveryFatalReporter {
  const reported = new WeakSet<Error>();
  const normalizedDefects = new WeakMap<object, Error>();

  return {
    report(cause) {
      let errorCause: Error | null = null;
      try {
        if (cause instanceof Error) errorCause = cause;
      } catch {
        // Hostile values are normalized below without inspecting them again.
      }

      let fatalError: Error;
      if (errorCause) {
        fatalError = errorCause;
      } else if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
        const existing = normalizedDefects.get(cause);
        fatalError = existing ?? new Panic({ message: "Event delivery defect" });
        if (!existing) normalizedDefects.set(cause, fatalError);
      } else {
        fatalError = new Panic({ message: "Event delivery defect" });
      }
      if (reported.has(fatalError)) return;
      reported.add(fatalError);
      reportFatalError(fatalError);
    },
  };
}

export function createCoreRuntimeFatalReporter(
  reportFatalError: (error: Error) => void,
): (error: Error) => void {
  const reported = new WeakSet<Error>();
  return (error) => {
    if (reported.has(error)) return;
    reported.add(error);
    reportFatalError(error);
  };
}

export async function superviseDetachedCoreConfigValidation(params: {
  readonly validate: () => Promise<void>;
  readonly reportFatalError: (error: Error) => void;
}): Promise<void> {
  const [settled] = await Promise.allSettled([params.validate()]);
  if (settled.status === "fulfilled") return;
  if (isPanic(settled.reason)) {
    params.reportFatalError(settled.reason);
    return;
  }
  if (settled.reason instanceof Error) {
    params.reportFatalError(settled.reason);
    return;
  }
  params.reportFatalError(
    new Panic({ message: "Core config validation rejected", cause: settled.reason }),
  );
}

function normalizeRouterDoneDefect(cause: unknown): Error {
  if (isPanic(cause)) return cause;
  if (cause instanceof Error) return cause;
  return new Panic({ message: "Discord request router subscription rejected" });
}

export function superviseCoreRouterDone(params: {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  readonly isStopping: () => boolean;
  readonly markUnhealthy: () => void;
  readonly reportFatalError: (error: Error) => void;
}): Promise<void> {
  return supervise();

  async function supervise(): Promise<void> {
    const [settled] = await Promise.allSettled([params.done]);
    if (params.isStopping()) return;
    params.markUnhealthy();
    if (settled.status === "rejected") {
      params.reportFatalError(normalizeRouterDoneDefect(settled.reason));
      return;
    }
    if (settled.value.status === "error") {
      params.reportFatalError(settled.value.error);
      return;
    }
    params.reportFatalError(
      new Panic({ message: "Discord request router subscriptions completed unexpectedly" }),
    );
  }
}

export function createCoreEventBusDeliveryOptions(params: {
  readonly redis: Redis;
  readonly deadLetterEncryptionKey: Uint8Array;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
}): CreateLilacBusOptions {
  return {
    deadLetter: new RedisEventDeadLetter({
      redis: params.redis,
      encryptionKey: params.deadLetterEncryptionKey,
    }),
    logger: createCoreEventBusLogger(params.logger),
    reportFatal: createCoreEventBusFatalReporter(params.reportFatalError),
  };
}

type CoreEventBusRaw = ReturnType<typeof createRedisStreamsBus>;

export class CoreEventBusSetupFailed extends TaggedError("CoreEventBusSetupFailed")<{
  readonly operation:
    | "read-config"
    | "create-redis"
    | "prepare-workspace"
    | "load-dead-letter-key"
    | "ping-redis"
    | "create-raw-bus"
    | "create-lilac-bus";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreEventBusCleanupFailed extends TaggedError("CoreEventBusCleanupFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreEventBusSetupAndCleanupFailed extends TaggedError(
  "CoreEventBusSetupAndCleanupFailed",
)<{
  readonly setup: CoreEventBusSetupFailed;
  readonly cleanup: CoreEventBusCleanupFailed;
  readonly message: string;
}> {}

type CoreEventBusSetupError = CoreEventBusSetupFailed | CoreEventBusSetupAndCleanupFailed;

export type CoreEventBusSetupOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<CoreEventBusResources, CoreEventBusSetupError>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

type CoreEventBusResources = {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw;
  readonly bus: LilacBus;
  readonly canonicalWorkspaceRoot: string;
};

type CoreEventBusOwnership = {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw | null;
  readonly bus: LilacBus | null;
};

function captureCoreRedisConstruction(
  redisUrl: string,
): ResultType<Redis, CoreEventBusSetupFailed> {
  try {
    return Result.ok(new Redis(redisUrl));
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusSetupFailed({
        operation: "create-redis",
        cause,
        message: "Core event bus setup failed during create-redis",
      }),
    );
  }
}

async function captureCoreWorkspacePreparation(
  cwd: string,
): Promise<ResultType<string, CoreEventBusSetupFailed>> {
  try {
    await fs.mkdir(cwd, { recursive: true });
    return Result.ok(await fs.realpath(cwd));
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusSetupFailed({
        operation: "prepare-workspace",
        cause,
        message: "Core event bus setup failed during prepare-workspace",
      }),
    );
  }
}

async function captureCoreRedisConnection(
  redis: Redis,
): Promise<ResultType<void, CoreEventBusSetupFailed>> {
  try {
    await redis.ping();
    return Result.ok(undefined);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusSetupFailed({
        operation: "ping-redis",
        cause,
        message: "Core event bus setup failed during ping-redis",
      }),
    );
  }
}

function captureCoreRawBusConstruction(
  redis: Redis,
): ResultType<CoreEventBusRaw, CoreEventBusSetupFailed> {
  try {
    return Result.ok(
      createRedisStreamsBus({
        redis,
        ownsRedis: true,
        subscriberPool: {
          // Blocking XREAD/XREADGROUP calls use capped, prewarmed dedicated connections.
          max: 16,
          warm: 8,
          autoscale: {
            enabled: true,
            min: 16,
            cap: 256,
            cooldownMs: 30_000,
          },
        },
      }),
    );
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusSetupFailed({
        operation: "create-raw-bus",
        cause,
        message: "Core event bus setup failed during create-raw-bus",
      }),
    );
  }
}

function captureCoreLilacBusConstruction(params: {
  readonly redis: Redis;
  readonly raw: CoreEventBusRaw;
  readonly deadLetterEncryptionKey: Uint8Array;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
}): ResultType<LilacBus, CoreEventBusSetupFailed> {
  try {
    return Result.ok(
      createLilacBus(
        params.raw,
        createCoreEventBusDeliveryOptions({
          redis: params.redis,
          deadLetterEncryptionKey: params.deadLetterEncryptionKey,
          logger: params.logger,
          reportFatalError: params.reportFatalError,
        }),
      ),
    );
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusSetupFailed({
        operation: "create-lilac-bus",
        cause,
        message: "Core event bus setup failed during create-lilac-bus",
      }),
    );
  }
}

export async function captureCoreEventBusCleanup(
  ownership: CoreEventBusOwnership,
): Promise<ResultType<void, CoreEventBusCleanupFailed>> {
  try {
    if (ownership.bus) {
      const closed = await ownership.bus.close();
      if (closed.status === "error") {
        return Result.err(
          new CoreEventBusCleanupFailed({
            cause: closed.error,
            message: "Core event bus cleanup failed",
          }),
        );
      }
    } else if (ownership.raw) {
      await ownership.raw.close();
    } else {
      await ownership.redis.quit();
    }
    return Result.ok(undefined);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new CoreEventBusCleanupFailed({
        cause,
        message: "Core event bus cleanup failed",
      }),
    );
  }
}

async function coreEventBusSetupFailureWithCleanup(
  setup: CoreEventBusSetupFailed,
  ownership: CoreEventBusOwnership,
): Promise<ResultType<never, CoreEventBusSetupError>> {
  const cleanup = await captureCoreEventBusCleanup(ownership);
  if (cleanup.status === "ok") return Result.err(setup);
  return Result.err(
    new CoreEventBusSetupAndCleanupFailed({
      setup,
      cleanup: cleanup.error,
      message: `${setup.message}; cleanup also failed`,
    }),
  );
}

export async function setupCoreEventBusResources(params: {
  readonly redisUrl: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly logger: CoreEventBusLogSink;
  readonly reportFatalError: (error: Error) => void;
  readonly dependencies?: {
    readonly captureRedisConstruction?: typeof captureCoreRedisConstruction;
    readonly loadDeadLetterKey?: (options: {
      readonly dataDir: string;
    }) => Promise<ResultType<Uint8Array, CoreDeadLetterKeyError>>;
  };
}): Promise<CoreEventBusSetupOutcome> {
  let redis: Redis | null = null;
  let raw: CoreEventBusRaw | null = null;
  let bus: LilacBus | null = null;
  let cleanupAttempted = false;

  const setup = await Result.tryPromise({
    try: async () => {
      const redisCreated = (
        params.dependencies?.captureRedisConstruction ?? captureCoreRedisConstruction
      )(params.redisUrl);
      if (redisCreated.status === "error") return Result.err(redisCreated.error);
      redis = redisCreated.value;

      const workspacePrepared = await captureCoreWorkspacePreparation(params.cwd);
      if (workspacePrepared.status === "error") {
        cleanupAttempted = true;
        return await coreEventBusSetupFailureWithCleanup(workspacePrepared.error, {
          redis,
          raw,
          bus,
        });
      }

      const deadLetterKey = await (
        params.dependencies?.loadDeadLetterKey ?? loadOrCreateCoreDeadLetterKey
      )({ dataDir: params.dataDir });
      if (deadLetterKey.status === "error") {
        const setupError = new CoreEventBusSetupFailed({
          operation: "load-dead-letter-key",
          cause: deadLetterKey.error,
          message: "Core event bus setup failed during load-dead-letter-key",
        });
        cleanupAttempted = true;
        return await coreEventBusSetupFailureWithCleanup(setupError, { redis, raw, bus });
      }

      const redisConnected = await captureCoreRedisConnection(redis);
      if (redisConnected.status === "error") {
        cleanupAttempted = true;
        return await coreEventBusSetupFailureWithCleanup(redisConnected.error, { redis, raw, bus });
      }

      const rawCreated = captureCoreRawBusConstruction(redis);
      if (rawCreated.status === "error") {
        cleanupAttempted = true;
        return await coreEventBusSetupFailureWithCleanup(rawCreated.error, { redis, raw, bus });
      }
      raw = rawCreated.value;

      const busCreated = captureCoreLilacBusConstruction({
        redis,
        raw,
        deadLetterEncryptionKey: deadLetterKey.value,
        logger: params.logger,
        reportFatalError: params.reportFatalError,
      });
      if (busCreated.status === "error") {
        cleanupAttempted = true;
        return await coreEventBusSetupFailureWithCleanup(busCreated.error, { redis, raw, bus });
      }
      bus = busCreated.value;

      return Result.ok({
        redis,
        raw,
        bus,
        canonicalWorkspaceRoot: workspacePrepared.value,
      });
    },
    catch: projectRuntimeError("Unexpected Core event bus setup rejection"),
  });
  if (setup.status === "ok") return { kind: "result", result: setup.value };

  const cause = isPanic(setup.error)
    ? setup.error
    : new Panic({ message: "Unexpected Core event bus setup rejection" });
  if (!redis || cleanupAttempted) return { kind: "panic", panic: cause };
  const ownedRedis = redis;
  const cleanup = createCoreRuntimeCleanupSupervisor(cause);
  await cleanup.run("eventBus.setup.close", async () => {
    adaptCoreEventBusCleanupResultToHost(
      await captureCoreEventBusCleanup({ redis: ownedRedis, raw, bus }),
    );
  });
  if (cleanup.failures.length > 0) {
    params.logger.error("event_bus.setup_cleanup_failed", {
      failureCount: cleanup.failures.length,
    });
  }
  cleanup.finish();
  return { kind: "panic", panic: cause };
}

export function adaptCoreEventBusSetupResultToStartup(
  result: ResultType<CoreEventBusResources, CoreEventBusSetupError>,
): CoreEventBusResources {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

export function adaptCoreEventBusCleanupResultToHost(
  result: ResultType<void, CoreEventBusCleanupFailed>,
): void {
  if (result.status === "error") throw new Error(result.error.message);
}

export function adaptCustomCommandInitializationResultToStartup(
  result: ResultType<void, CustomCommandDiscoveryError>,
  manager: CustomCommandManager,
): CustomCommandManager {
  if (result.status === "ok") return manager;
  throw new Error(result.error.message);
}

export type CoreRuntimeCleanupFailure = {
  readonly label: string;
  readonly error: string;
  readonly panic: boolean;
};

function logGracefulRestartSnapshotSaved(
  logger: ReturnType<typeof createLogger>,
  details: {
    readonly drainDeadlineMs: number;
    readonly snapshotTtlMs: number;
    readonly agentEntries: number;
    readonly relayEntries: number;
  },
): void {
  logger.info("Saved graceful restart snapshot", details);
}

export type CoreRuntimeCleanupSupervisor = {
  readonly failures: readonly CoreRuntimeCleanupFailure[];
  run(label: string, cleanup: (() => Promise<void>) | undefined): Promise<void>;
  runOutcome(
    label: string,
    cleanup:
      | (() => Promise<
          | { readonly kind: "result"; readonly result: ResultType<void, unknown> }
          | { readonly kind: "panic"; readonly panic: Panic }
        >)
      | undefined,
  ): Promise<void>;
  finish(): void;
};

export function createCoreRuntimeCleanupSupervisor(
  priorPanic: Panic | null,
): CoreRuntimeCleanupSupervisor {
  const failures: CoreRuntimeCleanupFailure[] = [];
  let cleanupPanic: Panic | null = null;

  async function run(label: string, cleanup: (() => Promise<void>) | undefined): Promise<void> {
    if (!cleanup) return;
    try {
      await cleanup();
    } catch (cause) {
      const panic = isPanic(cause);
      if (panic && !cleanupPanic) cleanupPanic = cause;
      failures.push({
        label,
        error: safeRuntimeErrorText(cause, "Opaque cleanup failure"),
        panic,
      });
    }
  }

  async function runOutcome(
    label: string,
    cleanup:
      | (() => Promise<
          | { readonly kind: "result"; readonly result: ResultType<void, unknown> }
          | { readonly kind: "panic"; readonly panic: Panic }
        >)
      | undefined,
  ): Promise<void> {
    if (!cleanup) return;
    const outcome = await cleanup();
    if (outcome.kind === "panic") {
      if (!cleanupPanic) cleanupPanic = outcome.panic;
      failures.push({
        label,
        error: safeRuntimeErrorText(outcome.panic, "Opaque cleanup panic"),
        panic: true,
      });
      return;
    }
    if (outcome.result.status === "error") {
      failures.push({
        label,
        error: safeRuntimeErrorText(outcome.result.error, "Opaque cleanup failure"),
        panic: false,
      });
    }
  }

  function finish(): void {
    if (!priorPanic && cleanupPanic) throw cleanupPanic;
  }

  return { failures, run, runOutcome, finish };
}

type CoreMcpStartupLogger = {
  info(message: string, details: Readonly<Record<string, unknown>>): void;
  warn(message: string, details: Readonly<Record<string, unknown>>): void;
  error(message: string, details: Readonly<Record<string, unknown>>): void;
};

export type CoreMcpStartupOptions = {
  readonly configPath: string;
  readonly providers: { reconcile(config: UniversalMcpConfig): void };
  readonly registry: { init(): Promise<void> };
  readonly callback: { start(): McpOAuthCallbackListenerStatus };
  readonly logger: CoreMcpStartupLogger;
  readonly readConfig?: typeof readMcpConfigFile;
};

export async function startCoreMcpServices(
  options: CoreMcpStartupOptions,
): Promise<{ readonly registryInit: Promise<void> }> {
  let config = createEmptyMcpConfig();
  const configResult = await (options.readConfig ?? readMcpConfigFile)(options.configPath);
  if (configResult.status === "ok") {
    config = configResult.value.config;
  } else {
    options.logger.warn("MCP OAuth providers reconciled to empty configuration", {
      path: options.configPath,
      error: formatTaggedErrorForLog(configResult.error).errorMessage,
    });
  }
  options.providers.reconcile(config);

  const callbackStatus = options.callback.start();
  if (callbackStatus.status === "unavailable") {
    options.logger.warn("MCP OAuth callback listener unavailable", callbackStatus);
  } else {
    options.logger.info("MCP OAuth callback listener started", callbackStatus);
  }

  const registryInit = Promise.resolve()
    .then(() => options.registry.init())
    .catch((error: unknown) => {
      options.logger.error("MCP registry background initialization failed", {
        path: options.configPath,
        error: errorMessage(error),
      });
      rethrowPanic(error);
    });

  return { registryInit };
}

function subId(prefix: string, name: string): string {
  return `${prefix}:${name}`;
}

function surfaceRelayHandle<P extends RegisteredSurfacePlatform>(
  platform: P,
  relay: Awaited<ReturnType<typeof bridgeBusToAdapter>>,
): SurfaceRelayHandle<P> {
  return {
    platform,
    beginDrain: (options) => relay.beginDrain(options),
    snapshotRelays: () => relay.snapshotRelays().map((snapshot) => ({ ...snapshot, platform })),
    restoreRelays: (snapshots) => relay.restoreRelays(snapshots),
    stop: () => relay.stop(),
  };
}

function runtimeFsDenyPaths(): readonly string[] {
  const home = process.env.HOME;
  return [
    path.resolve(env.dataDir, "secret"),
    path.resolve(env.dataDir, "tool-results"),
    ...(home ? [path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg")] : []),
  ];
}

function fffCacheDir(): string {
  return path.join(env.dataDir, ".cache", "fff");
}

export async function createCoreRuntime(
  opts: CoreRuntimeOptions,
): Promise<CoreRuntimeCreateOutcome> {
  const logger = createLogger({
    logLevel: opts.logLevel,
    module: "core-runtime",
  });

  const subscriptionPrefix = opts.subscriptionPrefix ?? "core";
  const cwd =
    opts.cwd ??
    process.env.LILAC_WORKSPACE_DIR ??
    path.resolve(process.cwd(), env.dataDir, "workspace");
  const toolServerPort = opts.toolServerPort ?? Number(env.toolServer.port ?? 8080);
  const reportFatalError = createCoreRuntimeFatalReporter(opts.reportFatalError);

  logger.info("Core runtime init", {
    cwd,
    toolServerPort,
    subscriptionPrefix,
  });

  const redisUrl = env.redisUrl;
  let eventBusSetup: CoreEventBusSetupOutcome;
  if (!redisUrl) {
    logger.error("Missing REDIS_URL env var (required)");
    eventBusSetup = {
      kind: "result",
      result: Result.err(
        new CoreEventBusSetupFailed({
          operation: "read-config",
          cause: undefined,
          message: "REDIS_URL must be set",
        }),
      ),
    };
  } else {
    eventBusSetup = await setupCoreEventBusResources({
      redisUrl,
      cwd,
      dataDir: env.dataDir,
      logger,
      reportFatalError,
    });
  }
  if (eventBusSetup.kind === "panic") return eventBusSetup;
  if (eventBusSetup.result.status === "error") {
    return {
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "event-bus",
          cause: eventBusSetup.result.error,
          message: eventBusSetup.result.error.message,
        }),
      ),
    };
  }
  const eventBusResources = eventBusSetup.result.value;
  const { redis, raw, bus, canonicalWorkspaceRoot } = eventBusResources;

  const customCommandManager = new CustomCommandManager(env.dataDir);
  const customCommandsInitialized = await customCommandManager.init();
  if (customCommandsInitialized.status === "error") {
    return {
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "custom-commands",
          cause: customCommandsInitialized.error,
          message: customCommandsInitialized.error.message,
        }),
      ),
    };
  }
  const customCommands = customCommandManager;
  const loadedCustomCommands = customCommands.list();
  const customCommandWarnings = customCommands.listWarnings();
  logger.debug("custom commands initialized", {
    dataDir: env.dataDir,
    commandsDir: resolveCustomCommandsDir(env.dataDir),
    discoveredCount: loadedCustomCommands.length + customCommandWarnings.length,
    loadedCount: loadedCustomCommands.length,
    warningCount: customCommandWarnings.length,
    loadedNames: loadedCustomCommands.map((command) => command.def.name),
  });
  for (const warning of customCommandWarnings) {
    logger.warn("custom command skipped", { warning });
  }

  const adapter = new DiscordAdapter({ customCommands, reportFatalPanic: reportFatalError });
  const githubAdapter = new GithubAdapter();
  const durableWorkflowStore = new DurableWorkflowStore();

  let transcriptStore: SqliteTranscriptStore | null = null;
  let discordSearchStore: DiscordSearchStore | null = null;
  let discordSurfaceStore: DiscordSurfaceStore | null = null;
  let discordSearchService: DiscordSearchService | null = null;
  let discoveryService: DiscoveryService | null = null;
  let conversationThreadStore: ConversationThreadStore | null = null;
  let conversationThreadService: ConversationThreadService | null = null;
  let conversationThreadMaterializer: ConversationThreadMaterializer | null = null;

  let started = false;

  const connectedSurfaceAdapters: ConnectedSurfaceAdapters = new Map();
  const surfaceAdapterIngressHandles: SurfaceAdapterIngressHandles = new Map();
  const surfaceRequestIngressHandles: SurfaceRequestIngressHandles = new Map();
  const surfaceRelayHandles: SurfaceRelayHandles = new Map();
  let stopDiscordSearchIndexer: { stop(): Promise<void> } | null = null;
  let stopRouter: DiscordRequestRouter | null = null;
  let routerSupervision: Promise<void> | null = null;
  let stopWorkflowActionResolver: { stop(): Promise<void> } | null = null;
  let workflowProgressProjector: WorkflowProgressProjector | null = null;
  let workflowEngine: WorkflowEngine | null = null;
  let workflowWaitResolver: WorkflowWaitResolver | null = null;
  let workflowTriggerScheduler: WorkflowTriggerScheduler | null = null;
  let workflowLiveParentBridge: WorkflowLiveParentBridge | null = null;
  let workflowSubagentDispatcher: WorkflowSubagentDispatcher | null = null;
  let stopAgentRunner: Awaited<ReturnType<typeof startBusAgentRunner>> | null = null;
  let stopHeartbeat: HeartbeatService | null = null;
  let stopConversationThreadWorker: Awaited<
    ReturnType<typeof startConversationThreadWorker>
  > | null = null;
  let stopConversationThreadSummarizationWorker: Awaited<
    ReturnType<typeof startConversationThreadSummarizationWorker>
  > | null = null;
  let conversationThreadSummarizationRunner: ConversationThreadSummarizationRunner | null = null;
  let conversationThreadSummarizationStopping = false;

  let requestMessageCache: RequestMessageCache | null = null;
  const requestControlAuthority = new RequestControlAuthority();
  let gracefulRestartStore: SqliteGracefulRestartStore | null = null;
  let pluginManager: CoreToolPluginManager | null = null;
  const toolResultArtifacts = createToolResultArtifactStore(path.join(env.dataDir, "tool-results"));
  const mcpConfigPath = resolveMcpConfigPath({ dataDir: env.dataDir });
  const mcpOAuthProviders = new McpOAuthProviderService({
    dataDir: env.dataDir,
    configBaseDir: path.dirname(mcpConfigPath),
  });
  const mcpOAuthCallback = new McpOAuthCallbackService({ providers: mcpOAuthProviders });
  const mcpRegistryCreated = createMcpRegistryResult({
    configPath: mcpConfigPath,
    reportFatalError,
    dependencies: {
      createAuthProvider: ({ server }) => mcpOAuthProviders.getProvider(server.id),
    },
  });
  if (mcpRegistryCreated.status === "error") {
    return {
      kind: "result",
      result: Result.err(
        new CoreRuntimeCreateFailed({
          operation: "mcp-registry",
          cause: mcpRegistryCreated.error,
          message: mcpRegistryCreated.error.message,
        }),
      ),
    };
  }
  const mcpRegistry = mcpRegistryCreated.value;
  function composeSurfaceRuntimeRegistry(appCredentialsAvailable: boolean) {
    const discordRelayPolicy = createDiscordRelayPolicy(adapter);
    const githubRelayPolicy = createGithubRelayPolicy();
    return SurfaceRuntimeRegistry.create([
      createDiscordSurfaceRuntimeDescriptor({
        adapter,
        adapterIngress: {
          start: async () => {
            const handle = await bridgeAdapterToBus({
              adapter,
              bus,
              subscriptionId: subId(subscriptionPrefix, "adapter-to-bus"),
              transcriptStore: transcriptStore ?? undefined,
            });
            logger.debug("bridgeAdapterToBus started", {
              subscriptionId: subId(subscriptionPrefix, "adapter-to-bus"),
            });
            return { platform: "discord", stop: () => handle.stop() };
          },
        },
        relay: {
          ...discordRelayPolicy,
          lifecycle: {
            platform: "discord",
            start: async () => {
              const relay = await bridgeBusToAdapter({
                adapter,
                bus,
                platform: "discord",
                policy: discordRelayPolicy,
                subscriptionId: subId(subscriptionPrefix, "bus-to-adapter"),
                transcriptStore: transcriptStore ?? undefined,
              });
              logger.debug("bridgeBusToAdapter started", {
                subscriptionId: subId(subscriptionPrefix, "bus-to-adapter"),
              });
              return surfaceRelayHandle("discord", relay);
            },
          },
        },
      }),
      createConfiguredGithubSurfaceRuntimeDescriptor({
        adapter: githubAdapter,
        webhookSecret: env.github.webhookSecret,
        appCredentialsAvailable,
        logger,
        requestIngress: {
          start: async () => {
            return await startGithubWebhookServer({
              bus,
              subscriptionId: subId(subscriptionPrefix, "github-webhook"),
              reportFatalError,
            });
          },
        },
        relay: {
          ...githubRelayPolicy,
          lifecycle: {
            platform: "github",
            start: async () => {
              const relay = await bridgeBusToAdapter({
                adapter: githubAdapter,
                bus,
                platform: "github",
                policy: githubRelayPolicy,
                subscriptionId: subId(subscriptionPrefix, "bus-to-github"),
                transcriptStore: transcriptStore ?? undefined,
              });
              logger.debug("GitHub output relay started", {
                subscriptionId: subId(subscriptionPrefix, "bus-to-github"),
              });
              return surfaceRelayHandle("github", relay);
            },
          },
        },
      }),
    ]);
  }
  let surfaceRuntimeRegistry: SurfaceRuntimeRegistry | null = null;
  let runtimeFullyStarted = false;
  let routerSubscriptionHealthy = true;
  let mcpRegistryInitPromise: Promise<void> | null = null;
  let coreConfigWatcher: FSWatcher | null = null;
  let coreConfigValidationTimer: ReturnType<typeof setTimeout> | null = null;
  let coreConfigValidationHadError = false;
  let lastCoreConfigValidationError: string | null = null;

  async function readCoreConfigParserVersion(configPath: string): Promise<number | "unknown"> {
    const loaded = await Result.tryPromise({
      try: async (): Promise<number | "unknown"> => {
        const version = readCoreConfigVersionResult(
          Bun.YAML.parse(await fs.readFile(configPath, "utf8")),
        );
        return version.status === "ok" ? version.value : "unknown";
      },
      catch: projectRuntimeError("Core config version read failed"),
    });
    if (loaded.status === "error") {
      if (isPanic(loaded.error)) throw loaded.error;
      return "unknown";
    }
    return loaded.value;
  }

  let toolServer: {
    init(): Promise<void>;
    start(port: number): Promise<void>;
    stop(): Promise<void>;
    recordUnhandledRejection(reason: Error): void;
  } | null = null;

  // How long shutdown waits for active runs/relays before forcing snapshot + exit.
  const GRACEFUL_DRAIN_DEADLINE_MS = 3_000;
  // How long a saved snapshot remains valid for restore on next boot.
  const GRACEFUL_SNAPSHOT_TTL_MS = 120_000;
  const REDIS_HEALTH_TIMEOUT_MS = 1_000;
  const DISCORD_DISCONNECT_GRACE_MS = 60_000;
  const DISCORD_GATEWAY_STALE_MS = 60_000;

  async function probeRedisHealth(): Promise<{
    ok: boolean;
    durationMs: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pinged = await Result.tryPromise({
      try: async () => {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`redis ping timed out after ${REDIS_HEALTH_TIMEOUT_MS}ms`));
          }, REDIS_HEALTH_TIMEOUT_MS);
          timer.unref?.();
        });
        await Promise.race([redis.ping(), timeout]);
      },
      catch: projectRuntimeError("Redis health probe failed"),
    });
    if (timer) clearTimeout(timer);
    if (pinged.status === "ok") {
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
      };
    }
    if (isPanic(pinged.error)) throw pinged.error;
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: errorMessage(pinged.error),
    };
  }

  async function getRuntimeHealthReport(
    options: { includeMemoryDiagnostics?: boolean } = {},
  ): Promise<ToolServerHealthProviderResult> {
    const now = Date.now();
    const checks: ToolServerHealthCheck[] = [
      {
        name: "runtime.started",
        ok: runtimeFullyStarted,
        impact: "ready",
        reason: runtimeFullyStarted ? undefined : "core runtime has not completed startup",
      },
      {
        name: "runtime.router-subscriptions",
        ok: !started || routerSubscriptionHealthy,
        impact: "live",
        reason:
          !started || routerSubscriptionHealthy
            ? undefined
            : "Discord request router subscriptions terminated unexpectedly",
      },
    ];

    const discord = adapter.getHealthSnapshot({
      includeCache: options.includeMemoryDiagnostics,
    });
    const disconnectedForMs = discord.lastDisconnectAt ? now - discord.lastDisconnectAt : 0;
    checks.push({
      name: "discord.ready",
      ok: !runtimeFullyStarted || discord.isReady,
      impact: "ready",
      reason: !runtimeFullyStarted || discord.isReady ? undefined : "discord gateway is not ready",
      details: discord,
    });
    checks.push({
      name: "discord.connection",
      ok:
        !runtimeFullyStarted || discord.isReady || disconnectedForMs < DISCORD_DISCONNECT_GRACE_MS,
      impact: "live",
      reason:
        !runtimeFullyStarted || discord.isReady || disconnectedForMs < DISCORD_DISCONNECT_GRACE_MS
          ? undefined
          : `discord gateway disconnected for ${disconnectedForMs}ms`,
      details: {
        connectionState: discord.connectionState,
        disconnectedForMs,
        thresholdMs: DISCORD_DISCONNECT_GRACE_MS,
      },
    });

    const gatewayEventStaleForMs = discord.lastGatewayEventAt
      ? now - discord.lastGatewayEventAt
      : null;
    const gatewayPingStaleForMs = discord.lastGatewayPingAt
      ? now - discord.lastGatewayPingAt
      : null;
    const gatewayEventFresh =
      gatewayEventStaleForMs !== null && gatewayEventStaleForMs < DISCORD_GATEWAY_STALE_MS;
    const gatewayPingFresh =
      Number.isFinite(discord.gatewayPingMs) &&
      gatewayPingStaleForMs !== null &&
      gatewayPingStaleForMs < DISCORD_GATEWAY_STALE_MS;
    checks.push({
      name: "discord.gateway",
      ok: !runtimeFullyStarted || !discord.isReady || gatewayEventFresh || gatewayPingFresh,
      impact: "live",
      reason:
        !runtimeFullyStarted || !discord.isReady || gatewayEventFresh || gatewayPingFresh
          ? undefined
          : `discord gateway dispatches and heartbeat acknowledgements are stale (event=${gatewayEventStaleForMs ?? "unknown"}ms, ping=${gatewayPingStaleForMs ?? "unknown"}ms)`,
      details: {
        lastGatewayEventAt: discord.lastGatewayEventAt,
        lastGatewayPingAt: discord.lastGatewayPingAt,
        gatewayPingMs: discord.gatewayPingMs,
        eventStaleForMs: gatewayEventStaleForMs,
        pingStaleForMs: gatewayPingStaleForMs,
        thresholdMs: DISCORD_GATEWAY_STALE_MS,
      },
    });

    const redisHealth = await probeRedisHealth();
    checks.push({
      name: "redis.ping",
      ok: redisHealth.ok,
      impact: "live",
      reason: redisHealth.ok ? undefined : redisHealth.error,
      details: redisHealth,
    });

    return {
      checks,
      ...(options.includeMemoryDiagnostics
        ? {
            memoryDiagnostics: {
              discord: discord.cache,
              openObserve: getOpenObserveDiagnostics(),
            },
          }
        : {}),
      info: {
        runtime: {
          started,
          runtimeFullyStarted,
          mcpRegistryInitPending: mcpRegistryInitPromise !== null,
          mcpOAuthCallback: mcpOAuthCallback.getStatus(),
        },
        discord,
        redis: redisHealth,
      },
    };
  }

  async function validateCoreConfigOnChange(reason: "watch"): Promise<void> {
    const configPath = resolveCoreConfigPath();

    const loaded = await Result.tryPromise({
      try: () => getCoreConfig({ forceReload: true }),
      catch: projectRuntimeError("Core config reload failed"),
    });
    if (loaded.status === "ok") {
      const config = loaded.value;

      if (coreConfigValidationHadError) {
        logger.info("core-config hot-reload validation recovered", {
          reason,
          path: configPath,
          parserVersion: config.configVersion,
        });
      } else {
        logger.info("core-config hot-reload validation succeeded", {
          reason,
          path: configPath,
          parserVersion: config.configVersion,
        });
      }

      coreConfigValidationHadError = false;
      lastCoreConfigValidationError = null;
      await adapter.refreshCoreConfig();
      conversationThreadMaterializer?.markAllDirty();
    } else {
      const e = loaded.error;
      if (isPanic(e)) throw e;
      const failure = new CoreRuntimeExternalFailure({
        operation: "reload-config",
        cause: e,
        message: "Core config reload failed",
      });
      const logError = formatTaggedErrorForLog(failure);
      const msg = logError.errorMessage;
      if (!coreConfigValidationHadError || lastCoreConfigValidationError !== msg) {
        const parserVersion = await readCoreConfigParserVersion(configPath);
        logger.warn("core-config hot-reload validation failed", {
          reason,
          path: configPath,
          parserVersion,
          error: msg,
        });
      }

      coreConfigValidationHadError = true;
      lastCoreConfigValidationError = msg;
    }
  }

  function scheduleCoreConfigValidation(reason: "watch"): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
    }

    coreConfigValidationTimer = setTimeout(() => {
      coreConfigValidationTimer = null;
      void superviseDetachedCoreConfigValidation({
        validate: () => validateCoreConfigOnChange(reason),
        reportFatalError,
      });
    }, 200);
  }

  async function startCoreConfigWatcher(): Promise<void> {
    const configPath = resolveCoreConfigPath();
    const configDir = path.dirname(configPath);
    const configFileName = path.basename(configPath);

    const startedWatcher = await Result.tryPromise({
      try: async () => {
        const watchState = {
          lastContent: await fs.readFile(configPath, "utf8"),
        };
        coreConfigWatcher = watch(configDir, (eventType, filename) => {
          void handleCoreConfigWatchEvent({
            configPath,
            configFileName,
            eventType,
            filename,
            state: watchState,
            logger,
            scheduleValidation: scheduleCoreConfigValidation,
          });
        });

        coreConfigWatcher.on("error", (error: Error) => {
          logger.warn("core-config watcher error", {
            path: configPath,
            error: safeRuntimeErrorText(error, "Opaque core-config watcher failure"),
          });
        });

        logger.debug("Core config hot-reload validator started", {
          path: configPath,
          parserVersion: await readCoreConfigParserVersion(configPath),
        });
      },
      catch: projectRuntimeError("Core config watcher startup failed"),
    });
    if (startedWatcher.status === "error") {
      const e = startedWatcher.error;
      if (isPanic(e)) throw e;
      const failure = new CoreRuntimeExternalFailure({
        operation: "start-config-watcher",
        cause: e,
        message: "Core config watcher startup failed",
      });
      logger.warn("Core config hot-reload validator disabled", {
        path: configPath,
        ...formatTaggedErrorForLog(failure),
      });
      coreConfigWatcher = null;
    }
  }

  function stopCoreConfigWatcher(): void {
    if (coreConfigValidationTimer) {
      clearTimeout(coreConfigValidationTimer);
      coreConfigValidationTimer = null;
    }
    coreConfigWatcher?.close();
    coreConfigWatcher = null;
  }

  async function restoreGracefulSnapshot(
    snapshot: GracefulRestartSnapshot,
    registry: SurfaceRuntimeRegistry,
  ) {
    logger.info("Restoring graceful restart snapshot", {
      createdAt: snapshot.createdAt,
      agentEntries: snapshot.agent.length,
      relayEntries: snapshot.relays.length,
    });

    await restoreSurfaceRecovery({
      registry,
      snapshot,
      relays: surfaceRelayHandles,
      agentRunner: stopAgentRunner,
    });

    logger.info("Graceful restart snapshot restored", {
      agentEntries: snapshot.agent.length,
      relayEntries: snapshot.relays.length,
    });
  }

  async function start(): Promise<CoreRuntimeStartOutcome> {
    if (started) return { kind: "result", result: Result.ok(undefined) };
    started = true;
    routerSubscriptionHealthy = true;
    conversationThreadSummarizationStopping = false;

    const startup = await Result.tryPromise({
      try: async (): Promise<CoreRuntimeStartOutcome> => {
        // Ensure data dir exists before creating sqlite-backed stores.
        await fs.mkdir(env.dataDir, { recursive: true });
        const artifactStoreInit = await toolResultArtifacts.init();
        adaptToolResultArtifactStoreInitToHost(artifactStoreInit);

        const mcpStartup = await startCoreMcpServices({
          configPath: mcpConfigPath,
          providers: mcpOAuthProviders,
          registry: mcpRegistry,
          callback: mcpOAuthCallback,
          logger,
        });
        const registryInitPromise = mcpStartup.registryInit.finally(() => {
          if (mcpRegistryInitPromise === registryInitPromise) mcpRegistryInitPromise = null;
        });
        mcpRegistryInitPromise = registryInitPromise;

        const startupConfig = await getCoreConfig();
        const githubAppSecret = await readGithubAppSecretResult(env.dataDir);
        if (githubAppSecret.status === "error") {
          return {
            kind: "result",
            result: Result.err(
              new CoreRuntimeStartFailed({
                operation: "startup",
                cause: githubAppSecret.error,
                message: githubAppSecret.error.message,
              }),
            ),
          };
        }
        const registryCreated = composeSurfaceRuntimeRegistry(githubAppSecret.value !== null);
        if (registryCreated.status === "error") {
          return {
            kind: "result",
            result: Result.err(
              new CoreRuntimeStartFailed({
                operation: "startup",
                cause: registryCreated.error,
                message: registryCreated.error.message,
              }),
            ),
          };
        }
        const registry = registryCreated.value;
        surfaceRuntimeRegistry = registry;
        const workflowAdapters = createSurfaceAdapterMap(registry);
        if (startupConfig.tools.fsBackend === "fff") {
          void prewarmFffFinders({
            basePaths: ["/data", "/data/workspace", "/app", cwd],
            denyPaths: runtimeFsDenyPaths(),
            cacheDir: fffCacheDir(),
          }).then((results) => {
            logger.debug("fff finder prewarm completed", {
              results,
            });
          });
        }

        await startCoreConfigWatcher();

        gracefulRestartStore = new SqliteGracefulRestartStore(
          path.join(env.dataDir, "graceful-restart.db"),
        );

        const discordSearchDbPath = resolveDiscordSearchDbPath();
        const discordSurfaceDbPath = resolveDiscordDbPath(startupConfig);
        transcriptStore = new SqliteTranscriptStore(resolveTranscriptDbPath());
        discordSearchStore = new DiscordSearchStore(discordSearchDbPath);
        discordSurfaceStore = new DiscordSurfaceStore(discordSurfaceDbPath);
        conversationThreadStore = new ConversationThreadStore(discordSearchDbPath, {
          surfaceDbPath: discordSurfaceDbPath,
          mainAgentUserNames: [startupConfig.surface.discord.botName],
        });
        const conversationThreadEntityMapper = createDiscordEntityMapper({
          cfg: startupConfig,
          store: discordSurfaceStore,
        });
        const getConversationThreadEmbeddingAdapter =
          createConversationThreadEmbeddingAdapterResolver(() => getCoreConfig());
        conversationThreadMaterializer = startConversationThreadMaterializer({
          searchDbPath: discordSearchDbPath,
          surfaceDbPath: discordSurfaceDbPath,
        });
        discordSearchService = new DiscordSearchService({
          adapter,
          store: discordSearchStore,
          onMessagesIndexed(channelId) {
            conversationThreadMaterializer?.markDirty({ channelId, kind: "topology" });
          },
        });
        const threadService = new ConversationThreadService({
          store: conversationThreadStore,
          getConfig: () => getCoreConfig(),
          getEmbeddingAdapter: getConversationThreadEmbeddingAdapter,
          entityMapper: conversationThreadEntityMapper,
        });
        conversationThreadService = threadService;
        const captureSummarizationRuntimeOperation = async <T>(
          operation: ConversationThreadSummarizationRuntimeOperation,
          effect: () => Promise<T>,
        ): Promise<ResultType<T, ConversationThreadSummarizationRuntimeError>> => {
          try {
            return Result.ok(await effect());
          } catch (cause) {
            rethrowPanic(cause);
            return Result.err(
              new ConversationThreadSummarizationRuntimeError({
                operation,
                cause,
                message: errorMessage(cause),
              }),
            );
          }
        };
        const runInProcessSummarization = (input: ConversationThreadRunSummarizationInput = {}) =>
          captureSummarizationRuntimeOperation("in-process", () =>
            threadService.runSummarization(input),
          );
        stopConversationThreadSummarizationWorker = startConversationThreadSummarizationWorker({
          searchDbPath: discordSearchDbPath,
          surfaceDbPath: discordSurfaceDbPath,
        });
        conversationThreadSummarizationRunner = {
          async runSummarization(input) {
            if (conversationThreadSummarizationStopping) {
              return Result.err(
                new ConversationThreadSummarizationTransportError({
                  operation: "stopped",
                  message: "conversation thread summarization is stopping",
                }),
              );
            }
            const trigger = input?.trigger ?? "manual";
            const flushed = await captureSummarizationRuntimeOperation(
              "materializer-flush",
              async () => {
                await conversationThreadMaterializer?.flush();
              },
            );
            if (flushed.status === "error") return Result.err(flushed.error);
            if (conversationThreadSummarizationStopping) {
              return Result.err(
                new ConversationThreadSummarizationTransportError({
                  operation: "stopped",
                  message: "conversation thread summarization is stopping",
                }),
              );
            }
            if (trigger === "periodic") {
              const config = await captureSummarizationRuntimeOperation("configuration", () =>
                getCoreConfig(),
              );
              if (config.status === "error") return Result.err(config.error);
              if (config.value.conversation.thread.summarization.enabled !== true) {
                return Result.ok({
                  dryRun: false,
                  refreshed: { channels: 0, threads: 0, messages: 0 },
                  eligible: 0,
                  eligibleTotal: 0,
                  eligibility: { summary: 0, embeddingOnly: 0, reasons: {} },
                  cleared: 0,
                  summarized: 0,
                  failed: 0,
                  failures: [],
                  threadIds: [],
                });
              }
            }
            if (input?.dryRun === true || !stopConversationThreadSummarizationWorker) {
              return await runInProcessSummarization(input);
            }
            return await stopConversationThreadSummarizationWorker.runSummarization(input);
          },
        };
        discoveryService = new DiscoveryService({
          dbPath: resolveDiscoveryDbPath(),
          dataDir: env.dataDir,
          discordSearchStore,
          transcriptStore,
          getConfig: () => getCoreConfig(),
        });

        stopDiscordSearchIndexer = await startDiscordSearchIndexer({
          adapter,
          search: discordSearchService,
          getConfig: () => getCoreConfig(),
          materializer: conversationThreadMaterializer,
        });

        logger.debug("Discord search indexer started", {
          dbPath: discordSearchDbPath,
        });

        // Subscribe to adapter events before connecting, so we don't miss early messages.
        await startSurfaceAdapterIngress({
          registry,
          handles: surfaceAdapterIngressHandles,
        });

        requestMessageCache = await createRequestMessageCache({
          bus,
          subscriptionId: subId(subscriptionPrefix, "tool-request-cache"),
        });

        logger.debug("Request message cache started", {
          subscriptionId: subId(subscriptionPrefix, "tool-request-cache"),
        });

        stopWorkflowActionResolver = await startWorkflowActionResolver({
          bus,
          store: durableWorkflowStore,
          subscriptionId: subId(subscriptionPrefix, "workflow-actions"),
        });

        // Subscribe durably before adapter.connect() so replies around startup replay.
        workflowWaitResolver = new WorkflowWaitResolver({
          bus,
          store: durableWorkflowStore,
          subscriptionId: subId(subscriptionPrefix, "workflow-waits"),
          confirmLegacyGroupSingleVersionRollout:
            process.env.LILAC_CONFIRM_SINGLE_VERSION_WORKFLOW_WAIT_RESOLVER === "1",
        });
        await workflowWaitResolver.start();

        await connectAndValidateSurfaceAdapters({
          registry,
          connected: connectedSurfaceAdapters,
        });

        logger.debug("Surface adapter connected", {
          platform: "discord",
        });

        workflowProgressProjector = new WorkflowProgressProjector({
          bus,
          store: durableWorkflowStore,
          adapters: workflowAdapters,
          subscriptionId: subId(subscriptionPrefix, "workflow-progress"),
          reportFatalPanic: reportFatalError,
        });
        await workflowProgressProjector.start();

        workflowTriggerScheduler = new WorkflowTriggerScheduler({
          bus,
          store: durableWorkflowStore,
          progressCards: workflowProgressProjector,
          getMaxActiveRuns: async () => (await getCoreConfig()).workflows.maxActiveRuns,
          reportFatalPanic: reportFatalError,
        });
        await workflowTriggerScheduler.start();

        workflowLiveParentBridge = new WorkflowLiveParentBridge({
          bus,
          store: durableWorkflowStore,
          subscriptionId: subId(subscriptionPrefix, "workflow-live-parents"),
          dataDir: env.dataDir,
          toolResultArtifacts,
        });
        await workflowLiveParentBridge.start();

        workflowSubagentDispatcher = await WorkflowSubagentDispatcher.create({
          store: durableWorkflowStore,
          dataDir: env.dataDir,
          toolResultArtifacts,
          getMaxActiveRuns: async () => (await getCoreConfig()).workflows.maxActiveRuns,
          onRunCreated: async (run) => {
            adaptEventPublishResultToHost(
              await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
                runId: run.runId,
                revisionId: run.revisionId,
                state: run.state,
                ts: Date.now(),
              }),
            );
          },
          onRunCancelled: async (run, previousState) => {
            adaptEventPublishResultToHost(
              await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
                runId: run.runId,
                revisionId: run.revisionId,
                state: "cancelled",
                previousState,
                detail: run.terminalDetail ?? undefined,
                ts: Date.now(),
              }),
            );
            adaptEventPublishResultToHost(
              await bus.publish(lilacEventTypes.EvtWorkflowResultReady, {
                runId: run.runId,
                revisionId: run.revisionId,
                state: "cancelled",
                summary: run.terminalDetail ?? undefined,
                ts: Date.now(),
              }),
            );
          },
        });

        stopRouter = await startDiscordRequestRouter({
          adapter,
          bus,
          subscriptionId: subId(subscriptionPrefix, "router"),
          customCommands,
          shouldSuppressAdapterEvent: async ({ evt }) =>
            shouldSuppressRouterForWorkflowReply({ store: durableWorkflowStore, event: evt }),
          transcriptStore: transcriptStore ?? undefined,
        });
        routerSupervision = superviseCoreRouterDone({
          done: stopRouter.done,
          isStopping: () => !started,
          markUnhealthy: () => {
            routerSubscriptionHealthy = false;
            runtimeFullyStarted = false;
          },
          reportFatalError,
        });

        logger.debug("Discord request router started", {
          subscriptionId: subId(subscriptionPrefix, "router"),
        });

        const conversationThreadToolService: ConversationThreadToolService | undefined =
          conversationThreadService
            ? (() => {
                const service = conversationThreadService;
                const summarizationRunner = conversationThreadSummarizationRunner;
                const toolService = createConversationThreadToolService(service);
                return {
                  ...toolService,
                  runSummarization: (input) =>
                    resolveConversationThreadSummarizationToolOperation(
                      summarizationRunner
                        ? summarizationRunner.runSummarization(input)
                        : captureSummarizationRuntimeOperation("in-process", () =>
                            service.runSummarization(input),
                          ),
                    ),
                };
              })()
            : undefined;

        pluginManager = createCoreToolPluginManager({
          runtime: {
            bus,
            adapter,
            getConfig: () => getCoreConfig(),
            discovery: discoveryService ?? undefined,
            conversationThreads: conversationThreadToolService,
            discordSearch: discordSearchService ?? undefined,
            transcriptStore: transcriptStore ?? undefined,
            toolResultArtifacts,
            durableWorkflowStore,
            workflowProgressCards: workflowProgressProjector,
            mcpRegistry,
            mcpOAuthProviders,
            mcpOAuthCallback,
            mcpConfigPath,
          },
          dataDir: env.dataDir,
        });

        toolServer = createToolServer({
          pluginManager,
          reportFatalToolCallDefect: reportFatalError,
          logger: createLogger({
            module: "tool-server",
          }),
          healthProvider: getRuntimeHealthReport,
          activeLevel1WorkProvider: () => stopAgentRunner?.getActiveLevel1Work() ?? [],
          onUnhealthy: opts.onUnhealthy,
          getConfig: () => getCoreConfig(),
          requestMessageCache: {
            get: requestMessageCache.get,
            getOrigin: requestMessageCache.getOrigin,
          },
          canonicalWorkspaceRoot,
          operatorTokenSha256: process.env.LILAC_OPERATOR_TOKEN_SHA256,
          authorizeControlRequest: (input) => requestControlAuthority.authorize(input),
          resolveServerSafetyMode: async (context) => {
            if (context.serverOwnedRequest && context.requestClient === "github") return "trusted";
            if (context.requestClient !== "discord" || !context.sessionId) return "restricted";
            const config = await getCoreConfig();
            const session = discordSurfaceStore?.getSession(context.sessionId);
            if (!session) return "restricted";
            return (
              config.surface.router.sessionModes[context.sessionId]?.safetyMode ??
              (session.parent_channel_id
                ? config.surface.router.sessionModes[session.parent_channel_id]?.safetyMode
                : undefined) ??
              "trusted"
            );
          },
        });

        await toolServer.init();
        await toolServer.start(toolServerPort);

        await startSurfaceOutputs({
          registry,
          requestIngress: surfaceRequestIngressHandles,
          relays: surfaceRelayHandles,
        });

        const restartLoadResult = gracefulRestartStore?.loadAndConsumeCompletedSnapshot();
        const restartLoad =
          restartLoadResult?.status === "ok"
            ? restartLoadResult.value
            : ({ state: "absent", provenance: "missing-defaulted" } as const);
        if (restartLoadResult?.status === "error") {
          logger.warn(
            "Graceful restart snapshot load failed",
            formatTaggedErrorForLog(restartLoadResult.error),
          );
        }
        const restartSnapshot = restartLoad.state === "loaded" ? restartLoad.snapshot : null;

        const initialHeartbeatExternalState = restartSnapshot
          ? {
              activeRequestIds: restartSnapshot.agent
                .filter(
                  (entry) => entry.kind === "active" && !isHeartbeatSessionId(entry.sessionId),
                )
                .map((entry) => entry.requestId),
            }
          : undefined;

        if (restartLoad.state === "stale") {
          logger.warn("Graceful restart snapshot discarded (stale)", {
            createdAt: restartLoad.createdAt,
            ageMs: restartLoad.ageMs,
            deadlineMs: restartLoad.deadlineMs,
          });
        }

        const recoverableRootParentRequestIds =
          restartSnapshot?.agent
            .filter(
              (entry) =>
                entry.kind === "active" &&
                !isHeartbeatSessionId(entry.sessionId) &&
                !isWorkflowAgentRecoveryEntry(entry),
            )
            .map((entry) => entry.requestId) ?? [];
        const remainingSnapshotProtectionMs = restartSnapshot
          ? Math.max(1, restartSnapshot.createdAt + restartSnapshot.deadlineMs - Date.now())
          : GRACEFUL_SNAPSHOT_TTL_MS;
        await workflowLiveParentBridge.enableOrphanHandling({
          protectedParentRequestIds: recoverableRootParentRequestIds,
          protectionMs: remainingSnapshotProtectionMs,
        });

        // Start agent runner last so it can't publish replies before relay is online.
        stopAgentRunner = await startBusAgentRunner({
          bus,
          subscriptionId: subId(subscriptionPrefix, "agent-runner"),
          reportFatalPanic: reportFatalError,
          pluginManager,
          customCommands,
          cwd: canonicalWorkspaceRoot,
          transcriptStore: transcriptStore ?? undefined,
          conversationThreads: conversationThreadToolService,
          toolResultArtifacts,
          workflowLiveParentBridge,
          workflowSubagentDispatcher,
          durableWorkflowStore,
          issueControlCapability: async (input) => {
            let origin = requestMessageCache?.getOrigin(input.requestId);
            for (let attempt = 0; !origin && attempt < 20; attempt += 1) {
              await Bun.sleep(5);
              origin = requestMessageCache?.getOrigin(input.requestId);
            }
            const originPrincipal =
              origin?.actorUserId &&
              origin.sessionId === input.sessionId &&
              origin.platform === input.requestClient
                ? { platform: origin.platform, userId: origin.actorUserId }
                : null;
            const policy = {
              kind: "primary",
              requestId: input.requestId,
              sessionId: input.sessionId,
              platform: input.requestClient,
              principal: input.principal ?? originPrincipal,
              allowedCallables: null,
              profile: input.profile,
              canonicalCwd: input.canonicalCwd,
              safetyMode: input.safetyMode,
              expiresAt: input.expiresAt,
            } as const;
            return {
              capability: requestControlAuthority.issue(policy),
              principal: policy.principal,
            };
          },
          issueHeartbeatCapability: (input) =>
            requestControlAuthority.issue({
              kind: "heartbeat",
              requestId: input.requestId,
              sessionId: input.sessionId,
              platform: input.requestClient,
              principal: null,
              allowedCallables: HEARTBEAT_LEVEL2_CALLABLES,
              profile: "primary",
              canonicalCwd: input.canonicalCwd,
              safetyMode: "trusted",
              expiresAt: input.expiresAt,
            }),
          expireControlCapability: (requestId) => requestControlAuthority.expire(requestId),
          resolveParentChannelId: (sessionId) => {
            const session = discordSurfaceStore?.getSession(sessionId);
            return session ? session.parent_channel_id : undefined;
          },
        });

        logger.debug("Bus agent runner started", {
          subscriptionId: subId(subscriptionPrefix, "agent-runner"),
          cwd: canonicalWorkspaceRoot,
        });

        if (restartSnapshot) {
          const restored = await Result.tryPromise({
            try: () => restoreGracefulSnapshot(restartSnapshot, registry),
            catch: projectRuntimeError("Graceful restart snapshot restore failed"),
          });
          if (restored.status === "error") {
            if (isPanic(restored.error)) return { kind: "panic", panic: restored.error };
            logger.error("Failed to restore graceful restart snapshot", {
              error: restored.error.message,
            });
          }
        }

        workflowEngine = new WorkflowEngine({
          bus,
          store: durableWorkflowStore,
          dataDir: env.dataDir,
          subscriptionId: subId(subscriptionPrefix, "workflow-engine"),
          reportFatalPanic: reportFatalError,
          validateAgentSelection: async ({ profile, model, reasoning }) => {
            const cfg = await getCoreConfig();
            const resolved = resolveAgentRunModel({
              cfg,
              runProfile: profile,
              ...(model ? { requestModelOverride: model } : {}),
              ...(reasoning ? { reasoningOverride: reasoning } : {}),
            });
            return {
              model: resolved.head.spec,
              reasoning: resolved.head.reasoning ?? null,
              request: toDurableResolvedModelPlan(resolved, cfg.agent.reasoningDisplay),
            };
          },
          resolveAgentFallbacks: async ({ profile, model, reasoning }) => {
            const cfg = await getCoreConfig();
            return resolveAgentRunModelFallbacks({
              cfg,
              runProfile: profile,
              ...(model ? { requestModelOverride: model } : {}),
              ...(reasoning ? { reasoningOverride: reasoning } : {}),
            }).map((fallback) =>
              toDurableResolvedModelRequest(fallback, cfg.agent.reasoningDisplay),
            );
          },
        });
        await workflowEngine.start();

        logger.debug("Unified workflow engine started", {
          subscriptionId: subId(subscriptionPrefix, "workflow-engine"),
        });

        const heartbeatStarted = await startHeartbeatServiceResult({
          bus,
          subscriptionId: subId(subscriptionPrefix, "heartbeat"),
          initialExternalState: initialHeartbeatExternalState,
        });
        if (heartbeatStarted.status === "error") {
          return {
            kind: "result",
            result: Result.err(
              new CoreRuntimeStartFailed({
                operation: "heartbeat",
                cause: heartbeatStarted.error,
                message: "Core runtime heartbeat startup failed",
              }),
            ),
          };
        }
        stopHeartbeat = heartbeatStarted.value;

        logger.debug("Heartbeat service started", {
          subscriptionId: subId(subscriptionPrefix, "heartbeat"),
        });

        if (conversationThreadSummarizationRunner) {
          stopConversationThreadWorker = startConversationThreadWorker({
            runner: conversationThreadSummarizationRunner,
            getConfig: () => getCoreConfig(),
          });
          logger.debug("Conversation thread worker started");
        }

        runtimeFullyStarted = routerSubscriptionHealthy;

        logger.info(
          `Core runtime started (tool-server port=${toolServerPort}, subscriptionPrefix=${subscriptionPrefix})`,
        );
        return { kind: "result", result: Result.ok(undefined) };
      },
      catch: projectRuntimeError("Core runtime startup failed"),
    });
    let outcome: CoreRuntimeStartOutcome;
    if (startup.status === "ok") {
      outcome = startup.value;
    } else if (isPanic(startup.error)) {
      outcome = { kind: "panic", panic: startup.error };
    } else {
      outcome = {
        kind: "result",
        result: Result.err(
          new CoreRuntimeStartFailed({
            operation: "startup",
            cause: startup.error,
            message: startup.error.message,
          }),
        ),
      };
    }
    if (outcome.kind === "panic") {
      logger.error("Core runtime start failed with Panic");
      await stop(outcome.panic);
      return outcome;
    }
    if (outcome.result.status === "ok") return outcome;
    logger.error("Core runtime start failed", {
      ...formatTaggedErrorForLog(outcome.result.error),
    });
    await stop();
    return outcome;
  }

  async function stop(priorPanic: Panic | null = null): Promise<void> {
    if (!started) return;
    started = false;
    conversationThreadSummarizationStopping = true;

    const cleanup = createCoreRuntimeCleanupSupervisor(priorPanic);
    const safe = cleanup.run;

    if (runtimeFullyStarted && stopAgentRunner && gracefulRestartStore && surfaceRuntimeRegistry) {
      const agentRunner = stopAgentRunner;
      const registry = surfaceRuntimeRegistry;

      const recoverables = await stopIngressAndDrainSurfaceRecovery({
        registry,
        stopAdapterIngress: async () => {
          await stopSurfaceAdapterIngress({
            registry,
            handles: surfaceAdapterIngressHandles,
            runCleanup: safe,
            graceful: true,
          });
        },
        stopRouterIngress: async () => {
          await safe("graceful.ingress.router.stop", () => stopRouter?.stop() ?? Promise.resolve());
          stopRouter = null;
          await safe("graceful.ingress.router.done", () => routerSupervision ?? Promise.resolve());
          routerSupervision = null;
        },
        stopWorkflowRequestProducers: async () => {
          await safe(
            "graceful.ingress.workflowWaitResolver.stop",
            () => workflowWaitResolver?.stop() ?? Promise.resolve(),
          );
          workflowWaitResolver = null;

          await safe(
            "graceful.ingress.workflowTriggerScheduler.stop",
            () => workflowTriggerScheduler?.stop() ?? Promise.resolve(),
          );
          workflowTriggerScheduler = null;

          await safe(
            "graceful.ingress.workflowActions.stop",
            () => stopWorkflowActionResolver?.stop() ?? Promise.resolve(),
          );
          stopWorkflowActionResolver = null;

          await safe(
            "graceful.ingress.workflowEngine.stop",
            () => workflowEngine?.stop() ?? Promise.resolve(),
          );
          workflowEngine = null;
        },
        stopRequestIngress: async () => {
          await stopSurfaceRequestIngress({
            registry,
            handles: surfaceRequestIngressHandles,
            runCleanup: safe,
            graceful: true,
          });
        },
        stopRemainingRequestProducers: async () => {
          const gracefulHeartbeat = stopHeartbeat;
          await cleanup.runOutcome(
            "graceful.heartbeat.stop",
            gracefulHeartbeat ? () => gracefulHeartbeat.stopOutcome() : undefined,
          );
          stopHeartbeat = null;

          await safe(
            "graceful.conversationThreadWorker.stop",
            () => stopConversationThreadWorker?.stop() ?? Promise.resolve(),
          );
          stopConversationThreadWorker = null;

          await safe(
            "graceful.conversationThreadSummarizationWorker.stop",
            () => stopConversationThreadSummarizationWorker?.stop() ?? Promise.resolve(),
          );
          stopConversationThreadSummarizationWorker = null;
          conversationThreadSummarizationRunner = null;
        },
        deadlineMs: GRACEFUL_DRAIN_DEADLINE_MS,
        runCleanup: safe,
        agentRunner,
        relays: surfaceRelayHandles,
      });
      const agentRecoverables = recoverables.agent;
      const relayRecoverables = recoverables.relays;

      if (agentRecoverables.length > 0 || relayRecoverables.length > 0) {
        await safe("graceful.store.saveCompletedSnapshot", async () => {
          const saved = gracefulRestartStore?.saveCompletedSnapshot({
            version: 2,
            createdAt: Date.now(),
            deadlineMs: GRACEFUL_SNAPSHOT_TTL_MS,
            agent: agentRecoverables,
            relays: relayRecoverables,
          });
          if (saved?.status === "error") {
            logger.warn(
              "Graceful restart snapshot save failed",
              formatTaggedErrorForLog(saved.error),
            );
            return;
          }

          logGracefulRestartSnapshotSaved(logger, {
            drainDeadlineMs: GRACEFUL_DRAIN_DEADLINE_MS,
            snapshotTtlMs: GRACEFUL_SNAPSHOT_TTL_MS,
            agentEntries: agentRecoverables.length,
            relayEntries: relayRecoverables.length,
          });
        });
      } else {
        await safe("graceful.store.clear", async () => {
          const cleared = gracefulRestartStore?.clear();
          if (cleared?.status === "error") {
            logger.warn(
              "Graceful restart snapshot clear failed",
              formatTaggedErrorForLog(cleared.error),
            );
          }
        });
      }
    }

    // Stop in reverse order (best-effort).
    await safe("agentRunner.stop", () => stopAgentRunner?.stop() ?? Promise.resolve());
    await safe(
      "workflowLiveParentBridge.stop",
      () => workflowLiveParentBridge?.stop() ?? Promise.resolve(),
    );
    workflowLiveParentBridge = null;
    workflowSubagentDispatcher = null;
    await safe(
      "conversationThreadWorker.stop",
      () => stopConversationThreadWorker?.stop() ?? Promise.resolve(),
    );
    await safe(
      "conversationThreadSummarizationWorker.stop",
      () => stopConversationThreadSummarizationWorker?.stop() ?? Promise.resolve(),
    );
    conversationThreadSummarizationRunner = null;
    const heartbeat = stopHeartbeat;
    await cleanup.runOutcome(
      "heartbeat.stop",
      heartbeat ? () => heartbeat.stopOutcome() : undefined,
    );
    await safe(
      "workflowTriggerScheduler.stop",
      () => workflowTriggerScheduler?.stop() ?? Promise.resolve(),
    );
    workflowTriggerScheduler = null;
    await safe(
      "workflowWaitResolver.stop",
      () => workflowWaitResolver?.stop() ?? Promise.resolve(),
    );
    workflowWaitResolver = null;
    await safe("workflowEngine.stop", () => workflowEngine?.stop() ?? Promise.resolve());
    workflowEngine = null;
    await safe(
      "workflowProgressProjector.stop",
      () => workflowProgressProjector?.stop() ?? Promise.resolve(),
    );
    workflowProgressProjector = null;
    await safe(
      "discordSearchIndexer.stop",
      () => stopDiscordSearchIndexer?.stop() ?? Promise.resolve(),
    );
    stopDiscordSearchIndexer = null;
    const registry = surfaceRuntimeRegistry;
    if (registry) {
      await stopSurfaceOutputs({
        registry,
        runCleanup: safe,
        relays: surfaceRelayHandles,
        requestIngress: surfaceRequestIngressHandles,
      });
    }

    await safe("toolServer.stop", () => toolServer?.stop() ?? Promise.resolve());
    await safe(
      "conversationThreadMaterializer.stop",
      () => conversationThreadMaterializer?.stop() ?? Promise.resolve(),
    );
    conversationThreadMaterializer = null;
    await safe("mcpOAuthCallback.stop", () => mcpOAuthCallback.stop());
    await safe("mcpRegistry.shutdown", () => mcpRegistry.shutdown());
    await safe("requestMessageCache.stop", () => requestMessageCache?.stop() ?? Promise.resolve());

    await safe("router.stop", () => stopRouter?.stop() ?? Promise.resolve());
    stopRouter = null;
    await safe("router.done", () => routerSupervision ?? Promise.resolve());
    routerSupervision = null;
    await safe(
      "workflowActions.stop",
      () => stopWorkflowActionResolver?.stop() ?? Promise.resolve(),
    );
    stopWorkflowActionResolver = null;
    if (registry) {
      await stopSurfaceAdapterIngress({
        registry,
        handles: surfaceAdapterIngressHandles,
        runCleanup: safe,
        graceful: false,
      });

      await disconnectSurfaceAdapters({
        registry,
        runCleanup: safe,
        connected: connectedSurfaceAdapters,
      });
      surfaceRuntimeRegistry = null;
    }
    await safe("durableWorkflowStore.close", async () => durableWorkflowStore.close());
    await safe("discoveryService.close", async () => {
      discoveryService?.close();
      discoveryService = null;
    });
    await safe("transcriptStore.close", async () => {
      transcriptStore?.close();
      transcriptStore = null;
    });
    await safe("discordSearchStore.close", async () => {
      discordSearchStore?.close();
      discordSearchStore = null;
      discordSearchService = null;
    });
    await safe("discordSurfaceStore.close", async () => {
      discordSurfaceStore?.close();
      discordSurfaceStore = null;
    });
    await safe("conversationThreadStore.close", async () => {
      conversationThreadStore?.close();
      conversationThreadStore = null;
      conversationThreadService = null;
    });
    await safe("gracefulRestartStore.close", async () => {
      gracefulRestartStore?.close();
      gracefulRestartStore = null;
    });
    await safe("coreConfigWatcher.stop", async () => {
      stopCoreConfigWatcher();
    });
    await safe("bus.close", async () => {
      adaptCoreEventBusCleanupResultToHost(await captureCoreEventBusCleanup({ redis, raw, bus }));
    });

    runtimeFullyStarted = false;

    if (cleanup.failures.length > 0) {
      for (const failure of cleanup.failures) {
        logger.error(
          `Core runtime cleanup failed [${failure.label}]${failure.panic ? " (panic)" : ""}: ${failure.error}`,
        );
      }
    }

    cleanup.finish();
    logger.info("Core runtime stopped");
  }

  return {
    kind: "result",
    result: Result.ok({
      start,
      stop,
      recordUnhandledRejection(reason: Error) {
        toolServer?.recordUnhandledRejection(reason);
      },
    }),
  };
}
