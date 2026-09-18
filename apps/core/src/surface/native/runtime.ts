import path from "node:path";
import { Result, type Result as ResultType } from "better-result";
import { FileSystem } from "@stanley2058/lilac-fs";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  lilacEventTypes,
  type LilacBus,
  type EventDeliveryDoneError,
  type EventDeliveryStopFailed,
  type NativeOutputFrontier,
} from "@stanley2058/lilac-event-bus";
import { discoverSkills, type DiscoveredSkill } from "@stanley2058/lilac-utils/skills";
import { toDurableResolvedModelPlan, type CoreConfig } from "@stanley2058/lilac-utils";
import type { CustomCommandManager } from "../../custom-commands/manager";
import type { ConversationThreadToolService } from "../../conversation/thread-service";
import type { McpRegistryApi } from "../../mcp/registry-types";
import type { CoreResourceService } from "../../resource";
import type { SqliteTranscriptStore } from "../../transcript/transcript-store";
import type { CoreToolPluginRuntime } from "../../plugins/types";
import type { SurfaceAdapterResolver } from "../runtime-descriptor";
import { resolveAgentRunModelResult, type NativeRunnerRequest } from "../bridge/bus-agent-runner";
import { parseNativeRequestEnvelope } from "../authenticated-request";
import { NativeSurfaceAdapter, nativeSurfaceError } from "./adapter";
import { NativeCatalogService } from "./catalogs";
import { NativeConfigService } from "./config-service";
import { createNativeExecution, type NativeRunnerControl } from "./execution";
import { nativeFailure } from "./errors";
import { createNativeGateway } from "./gateway";
import type { NativeInstallation } from "./installation";
import { nativeThreadId } from "./native-protocol";
import { createNativeOutputPublisher, createNativeBusOutputSink } from "./output";
import { projectNativeOutput } from "./output-projection";
import { NativeResourceService } from "./resources";
import { NativeLiveFileService, rewriteNativePublishedFileLinks } from "./resources-live";
import { createNativeRpcServices, nativeViewer } from "./rpc-services";
import { createNativeSurfaceRuntimeDescriptor } from "./runtime-descriptor";
import { NativeSearchService } from "./search";
import { NativeExternalThreads } from "./search-external";
import { NativeSummaryRefresher } from "./search-summary";
import { NativeSearchStore } from "./store-search";
import { NativeSummaryStore } from "./store-search-summary";
import { NativeSurfaceStore } from "./store-surface";

export function nativeRuntimeFailureToHost(error: Error): never {
  throw error;
}

export function nativeRuntimeResultToHost<T>(result: ResultType<T, Error>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeRuntimeFailureToHost(error),
  });
  return settle();
}

type NativeOutputSubscription = {
  done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export type NativeRuntimeOptions = {
  installation: NativeInstallation;
  bus: LilacBus;
  blobs: BlobStore;
  transcript: SqliteTranscriptStore;
  resourceAccess: CoreResourceService;
  getConfig: () => CoreConfig;
  dataDir: string;
  workspaceRoot: string;
  denyPaths: readonly string[];
  subscriptionPrefix: string;
  customCommands: CustomCommandManager;
  mcpRegistry: Pick<McpRegistryApi, "reload">;
  adapters: SurfaceAdapterResolver;
  conversationThreads: () => ConversationThreadToolService | undefined;
  runner: () => NativeRunnerControl | undefined;
  deliveryState: (
    id: string,
  ) => ResultType<"missing" | "owned" | "completed" | "failed" | "cancelled", Error>;
  reportFatalError: (error: Error) => void;
  warn: (message: string, error: Error) => void;
  publishableKey?: string;
};

export async function createNativeRuntime(options: NativeRuntimeOptions) {
  const { store, database, auth, clerk, login } = options.installation;
  let skills: readonly DiscoveredSkill[] = (
    await discoverSkills({ workspaceRoot: options.workspaceRoot, dataDir: options.dataDir })
  ).skills;
  const catalogs = new NativeCatalogService({
    config: options.getConfig(),
    skills,
    commands: options.customCommands.list().map((entry) => entry.def),
  });
  const resources = new NativeResourceService({
    native: store,
    resources: options.transcript,
    access: options.resourceAccess,
    blobs: options.blobs,
  });
  const liveFiles = new NativeLiveFileService({
    native: store,
    filesystem: new FileSystem(options.workspaceRoot, { denyPaths: options.denyPaths }),
    toolRoot: options.workspaceRoot,
    remoteDenyPaths: options.denyPaths,
  });
  const execution = createNativeExecution({
    store,
    bus: options.bus,
    transcriptStore: options.transcript,
    runner: options.runner,
    customCommands: options.customCommands,
    validateSkill: (id) => skills.some((skill) => skill.name === id),
    deliveryState: options.deliveryState,
    getOldMessageSelectionMaxAgeMs: () =>
      options.getConfig().surface.native.oldMessageSelectionMaxAgeMs ?? undefined,
  });
  const surface = new NativeSurfaceStore(database, store, async (actorId, input) =>
    (
      await options.bus.publish(
        lilacEventTypes.EvtAdapterActionInvoked,
        {
          actionId: input.actionId,
          platform: "native",
          userId: actorId,
          messageRef: { platform: "native", channelId: input.threadId, messageId: input.messageId },
          ts: Date.now(),
        },
        {
          headers: {
            request_id: input.requestId,
            session_id: `native:${input.threadId}`,
            request_client: "native",
          },
        },
      )
    )
      .map(() => undefined)
      .mapError(() => nativeFailure("sqlite", "Native action publication failed")),
  );
  const initialized = surface
    .initialize()
    .andThen(() => resources.reconcileReferences())
    .map(() => undefined);
  const initializationError = initialized.match({ ok: () => null, err: (error) => error });
  if (initializationError) return Result.err(initializationError);
  const kick = (threadId: string) => {
    void execution.kick(threadId).then((result) =>
      result.match({
        ok: () => undefined,
        err: (error) => options.warn("Native input admission deferred", error),
      }),
    );
  };
  const resolveModel = (modelId?: string) => {
    const cfg = options.getConfig();
    return resolveAgentRunModelResult({
      cfg,
      runProfile: "primary",
      requestModelOverride: modelId,
    }).map((plan) => toDurableResolvedModelPlan(plan, cfg.agent.reasoningDisplay));
  };
  const adapter = new NativeSurfaceAdapter({
    store,
    surface,
    resources,
    resolveModel,
    shouldTriggerRun: () => options.getConfig().surface.native.crossThreadSend.triggerRun,
    streamingMode: () => options.getConfig().surface.native.outputStreaming,
    kick,
  });
  const descriptor = createNativeSurfaceRuntimeDescriptor({
    adapter,
    resolveWorkflowAdapter: (threadId) =>
      store
        .getThreadRecord(nativeThreadId(threadId))
        .map((thread) =>
          adapter.forRequest({ principalId: thread.starterId, sourceThreadId: thread.id }),
        )
        .mapError((error) => nativeSurfaceError("send-message", error)),
  });
  const searchStore = new NativeSearchStore({ db: database, store });
  const summaries = new NativeSummaryStore({ db: database, store });
  const summaryInitialization = summaries.initialize();
  const summaryError = summaryInitialization.match({ ok: () => null, err: (error) => error });
  if (summaryError) return Result.err(summaryError);
  const search = new NativeSearchService({
    store,
    searchStore,
    summaries,
    get planner() {
      return options.conversationThreads();
    },
    get externalThreads() {
      return options.conversationThreads();
    },
  });
  const summaryRefresher = new NativeSummaryRefresher({
    store,
    search: searchStore,
    summaries,
    getConfig: options.getConfig,
  });
  const summaryAbort = new AbortController();
  const external = new NativeExternalThreads({
    getUser: (id) => store.getUser(id),
    adapters: options.adapters,
    knownSessions: () =>
      options.transcript
        .listDiscoveryRecords()
        .flatMap((row) =>
          row.surfaceRefs
            .filter((ref) => ref.platform !== "native")
            .map((ref) => ({ ref, kind: "thread" as const })),
        ),
  });
  const config = new NativeConfigService({
    dataDir: options.dataDir,
    ownerId: options.getConfig().surface.native.auth.ownerId,
    registry: options.mcpRegistry,
  });
  const nativeConfig = options.getConfig().surface.native;
  const services = createNativeRpcServices({
    store,
    auth,
    installationId: nativeConfig.installationId!,
    catalogs,
    config,
    execution,
    resolveModel,
    resources,
    search: searchStore,
    external,
    surface,
    ...(clerk ? { lookupUser: clerk.lookupUser } : {}),
  });
  const gateway = createNativeGateway({
    reportFatalError: options.reportFatalError,
    hostname: nativeConfig.host,
    port: nativeConfig.port,
    auth,
    publicAuth: {
      provider: nativeConfig.auth.provider,
      ...(options.publishableKey ? { publishableKey: options.publishableKey } : {}),
    },
    ...(login ? { login } : {}),
    services,
    getViewer: (id) => store.getUser(id).map(nativeViewer),
    resources: {
      async handle(request, actorId) {
        return (await resources.handle(request, actorId)) ?? liveFiles.handle(request, actorId);
      },
    },
    webRoot: path.resolve(import.meta.dir, "../../../../web/dist"),
  });
  let output: NativeOutputSubscription | undefined;
  let outputStopping = false;
  let unsubscribe: (() => void) | undefined;
  const nativeAdapterForContext: NonNullable<CoreToolPluginRuntime["nativeAdapterForContext"]> = (
    context,
  ) => {
    const principal = context.requestInitiator;
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!context.serverOwnedRequest || principal?.platform !== "native" || !threadId)
      return Result.err(
        nativeSurfaceError(
          "list-sessions",
          nativeFailure("forbidden", "Native tools require starter authority"),
        ),
      );
    return Result.ok(
      adapter.forRequest({
        principalId: principal.userId,
        sourceThreadId: nativeThreadId(threadId),
        requestId: context.requestId,
      }),
    );
  };

  const resourceAccessForContext: NonNullable<CoreToolPluginRuntime["resourceAccessForContext"]> = (
    context,
  ) => {
    const principal = context?.requestInitiator;
    if (context?.requestClient !== "native" && principal?.platform !== "native")
      return options.resourceAccess;
    if (!context?.serverOwnedRequest || principal?.platform !== "native") return undefined;
    const threadId = context.requestInitiatorSessionId ?? context.sessionId;
    if (!threadId) return undefined;
    const allowed = store
      .getThreadRecord(nativeThreadId(threadId))
      .andThen((thread) =>
        store
          .authorizeThread(principal.userId, thread.id)
          .map(() => thread.starterId === principal.userId),
      )
      .match({ ok: (value) => value, err: () => false });
    return allowed ? resources.scopedAccess(principal.userId) : undefined;
  };

  async function startOutput() {
    outputStopping = false;
    const started = await options.bus.subscribeTopic(
      "evt.native.output",
      {
        mode: "fanout",
        startFrom: "beginning",
        subscriptionId: `${options.subscriptionPrefix}:native-output`,
        consumerId: `${options.subscriptionPrefix}:native-output:${process.pid}`,
      },
      async (message) =>
        store.projectTurn(
          message.data.threadId,
          message.data.generation,
          message.data.eventId,
          message.data.turnId,
          (slot, projection) =>
            Result.gen(function* () {
              const event = message.data;
              if (event.payload.type !== "text")
                return Result.ok(projectNativeOutput(slot, event, projection));
              const thread = yield* store.getThreadRecord(event.threadId);
              const text = yield* rewriteNativePublishedFileLinks({
                text: event.payload.text,
                threadId: thread.id,
                actorId: thread.starterId,
                cwd: options.workspaceRoot,
                register: (actorId, threadId, target, cwd) =>
                  store.registerPublishedPath(actorId, threadId, target, cwd),
              });
              return Result.ok(
                projectNativeOutput(
                  slot,
                  { ...event, payload: { ...event.payload, text } },
                  projection,
                ),
              );
            }),
        ),
      (error) =>
        error._tag === "NativeStoreFailure" && error.code === "stale" ? "commit" : "retry",
    );
    return started.map((handle) => {
      output = handle;
      void handle.done.then((done) =>
        done.match({
          ok: () => undefined,
          err: (error) => {
            if (!outputStopping) options.reportFatalError(error);
          },
        }),
      );
    });
  }

  function createOutput(input: {
    requestId: string;
    requestClient: string;
    recoveryOutputFrontier?: NativeOutputFrontier;
  }) {
    if (input.requestClient !== "native") return undefined;
    const attempt = nativeRuntimeResultToHost(store.beginOutputAttempt(input.requestId));
    return createNativeOutputPublisher({
      ...attempt,
      requestId: input.requestId,
      mode: options.getConfig().surface.native.outputStreaming,
      publish: createNativeBusOutputSink(options.bus),
      recoveryFrontier: input.recoveryOutputFrontier,
    });
  }

  async function recover() {
    return Result.gen(async function* () {
      yield* Result.await(execution.recoverMutations());
      yield* Result.await(execution.kick());
      return Result.ok(undefined);
    });
  }

  function startIngress() {
    const started = gateway.start();
    return started.map((address) => {
      unsubscribe = store.subscribeChanges(kick);
      return address;
    });
  }

  async function stopIngress() {
    summaryAbort.abort();
    unsubscribe?.();
    unsubscribe = undefined;
    await gateway.stop();
    const uploads = await resources.stop();
    const publications = await execution.drainPublications();
    nativeRuntimeResultToHost(Result.all([uploads, publications]));
  }
  async function stopOutput() {
    outputStopping = true;
    const active = output;
    output = undefined;
    if (active) nativeRuntimeResultToHost(await active.stop());
  }
  async function updateCatalog() {
    skills = (
      await discoverSkills({ workspaceRoot: options.workspaceRoot, dataDir: options.dataDir })
    ).skills;
    catalogs.update({
      config: options.getConfig(),
      skills,
      commands: options.customCommands.list().map((entry) => entry.def),
    });
  }
  async function maintain() {
    return Result.gen(async function* () {
      const config = options.getConfig();
      const maxAge = config.surface.native.storageRetentionMaxAgeMs;
      if (maxAge !== null) {
        const expired = yield* store.listExpiredThreadIds(Date.now() - maxAge, 10);
        for (const threadId of expired)
          yield* Result.await(
            execution.deleteThread(config.surface.native.auth.ownerId, {
              threadId,
              commandId: `retention:${threadId}`,
            }),
          );
      }
      yield* resources.reconcileReferences();
      yield* surface.pruneDeleted();
      yield* summaries.pruneDeleted();
      yield* store.pruneReplay();

      return Result.ok(undefined);
    });
  }
  async function refreshSummaries(input: { limit?: number } = {}) {
    if (
      summaryAbort.signal.aborted ||
      !options.getConfig().conversation.thread.summarization.enabled
    )
      return Result.ok({ refreshed: 0, discarded: 0 });
    return summaryRefresher.refresh({ ...input, abortSignal: summaryAbort.signal });
  }
  function scopedResources(request: NativeRunnerRequest) {
    return resources.scopedAccess(parseNativeRequestEnvelope(request)?.starterUserId ?? "");
  }
  function scopedThreads(request: NativeRunnerRequest) {
    return search.forThread(parseNativeRequestEnvelope(request)?.threadId ?? "");
  }
  return Result.ok({
    descriptor,
    adapter,
    execution,
    resources,
    search,
    nativeAdapterForContext,
    resourceAccessForContext,
    createOutput,
    scopedResources,
    scopedThreads,
    startOutput,
    startIngress,
    stopIngress,
    stopOutput,
    recover,
    maintain,
    refreshSummaries,
    updateCatalog,
  });
}

export type NativeRuntime = NonNullable<
  ReturnType<typeof createNativeRuntime> extends Promise<ResultType<infer Value, Error>>
    ? Value
    : never
>;
