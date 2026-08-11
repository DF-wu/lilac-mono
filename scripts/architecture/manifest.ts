import { createHash } from "node:crypto";

import { ARCHITECTURE_RULES, type ArchitectureRule } from "./model.ts";
import {
  CORE_FINAL_BOUNDARY_IDENTITIES,
  CORE_FINAL_CAPABILITY_IDENTITIES,
  CORE_FINAL_REVIEWED_OPAQUE_IDENTITIES,
} from "./core-final-boundary-identities.ts";
import {
  CORE_FATAL_SIGNAL_IDENTITIES,
  CORE_REVIEWED_PANIC_IDENTITIES,
  PRECISE_EXCEPTION_IDENTITIES,
  type PreciseExceptionIdentity,
} from "./precise-exception-identities.ts";

export type BoundaryCategory = "request" | "wire" | "persistence" | "projection" | "plugin";
export type CompatibilityCategory =
  | "http"
  | "redis"
  | "worker"
  | "subprocess"
  | "persistence"
  | "tool"
  | "plugin";
export type ExceptionAdapterCategory =
  | "external-to-result"
  | "result-to-framework"
  | "rollback"
  | "compatibility"
  | "defect-supervisor";
export type ExceptionDirection = "capture-external" | "signal-host" | "observe-panic";

export interface SymbolIdentity {
  readonly module: string;
  readonly exportName: string;
}

export interface PackageSymbolIdentity extends SymbolIdentity {
  readonly package?: string;
}

export interface ExternalSymbolIdentity {
  readonly package: string;
  readonly exportName: string;
}

export type CompatibilitySink =
  | ({ readonly kind: "external" } & ExternalSymbolIdentity)
  | ({ readonly kind: "local" } & SymbolIdentity);

export interface BoundaryDecoder {
  readonly identity: SymbolIdentity;
  readonly category: BoundaryCategory;
}

export interface ReasonedSymbolException {
  readonly identity: SymbolIdentity;
  readonly reason: string;
}

export interface CompatibilityOutput {
  readonly sink: CompatibilitySink;
  readonly category: CompatibilityCategory;
  readonly reason: string;
}

export interface StructuredLogger {
  readonly sink: CompatibilitySink;
  readonly reason: string;
}

export interface ExceptionAdapter {
  readonly identity: SymbolIdentity;
  readonly category: ExceptionAdapterCategory;
  readonly externalApi: ExternalSymbolIdentity;
  readonly direction: ExceptionDirection;
  readonly reason: string;
}

export type ExceptionAdapterSyntaxKind =
  | "catch-clause"
  | "rejection-callback"
  | "throw-statement"
  | "host-rejection-call"
  | "registered-host-signal-call"
  | "panic-observation";

export type ExceptionAdapterProvenance =
  | "precise-exception-identities"
  | "core-reviewed-panic-identities"
  | "core-fatal-signal-identities"
  | "reviewed-injected-external-effect"
  | "workspace-reviewed-manifest";

export type ExceptionAdapterRelationship =
  | "external-package"
  | "external-rejection"
  | "host-contract"
  | "injected-external-effect"
  | "language-runtime"
  | "panic-brand";

export interface ApprovedExceptionAdapter {
  readonly workspace: string;
  readonly callable: SymbolIdentity;
  readonly category: ExceptionAdapterCategory;
  readonly externalApi: ExternalSymbolIdentity;
  readonly mode: ExceptionDirection;
  readonly syntaxKinds: readonly ExceptionAdapterSyntaxKind[];
  readonly relationship: ExceptionAdapterRelationship;
  readonly provenance: ExceptionAdapterProvenance;
  readonly reason: string;
}

export interface OpenProtocolAdapter {
  readonly identity: SymbolIdentity;
  readonly externalProtocol: ExternalSymbolIdentity;
  readonly protocolParameter: number;
  readonly fallbackVariant: {
    readonly discriminant: string;
    readonly value: string;
  };
  readonly reason: string;
}

export interface PanicSite {
  readonly fingerprint: string;
  readonly reason: string;
}

export interface RuleZone {
  readonly include: string;
}

export interface EventCodecRegistryRegistration {
  readonly identity: SymbolIdentity;
  readonly catalog: SymbolIdentity;
  readonly catalogHelper: SymbolIdentity;
  readonly registryHelper: SymbolIdentity;
}

export interface ToolCodecRegistryRegistration {
  readonly identity: SymbolIdentity;
  readonly aliases: readonly SymbolIdentity[];
  readonly canonicalTools: PackageSymbolIdentity;
}

export interface ResultDecoderRegistration {
  readonly identity: SymbolIdentity;
  readonly category: BoundaryCategory;
  readonly inputParameter: number;
}

export interface UnknownFreeModuleRegistration {
  readonly module: string;
}

export const PERSISTED_CODEC_FIXTURE_CASES = [
  "current",
  "legacy",
  "missing-defaulted",
  "unsupported-version",
  "malformed-serialization",
  "corrupt-fields",
] as const;

export type PersistedCodecFixtureCase = (typeof PERSISTED_CODEC_FIXTURE_CASES)[number];
export type PersistedValueProvenance = "current" | "migrated" | "missing-defaulted";
export type PersistedMissingOutcome = "missing-defaulted" | "missing-rejected";

export interface PersistedCodecRegistration {
  readonly identity: SymbolIdentity;
  readonly inputParameter: number;
  readonly fixtureCatalog: SymbolIdentity;
  readonly provenance: readonly PersistedValueProvenance[];
  readonly missingOutcomes?: Readonly<Record<string, PersistedMissingOutcome>>;
}

export interface PersistedStoreConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly codecs: readonly PackageSymbolIdentity[];
}

export interface SqliteTransactionAdapterRegistration {
  readonly identity: SymbolIdentity;
  readonly databaseParameter: number;
  readonly operationParameter: number;
  readonly rollbackSentinel: SymbolIdentity;
  readonly panicClassifier: ExternalSymbolIdentity;
  readonly driverErrorClassifier: SymbolIdentity;
}

export interface SqliteTransactionConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly adapter: PackageSymbolIdentity;
}

export interface RawEventMessageBoundaryRegistration {
  readonly identity: SymbolIdentity;
  readonly messageType: ExternalSymbolIdentity;
  readonly handlerParameter: number;
  readonly messageParameter: number;
  readonly contextParameter: number;
}

export interface EventDeliveryApiRegistration {
  readonly identity: SymbolIdentity;
  readonly handlerParameter: number;
  readonly handlerMessageParameter: number;
  readonly handlerContextParameter: number;
  readonly deliveryPolicy: SymbolIdentity;
  readonly deliveryErrorParameter: number;
}

export type EventDeliveryOperation = "subscribeTopic" | "fetchTopic";

export interface EventDeliveryConsumerRegistration {
  readonly identity: SymbolIdentity;
  readonly apiPackage: string;
  readonly operations: readonly EventDeliveryOperation[];
}

export interface WorkspaceArchitecture {
  readonly name: string;
  readonly packageName: string;
  readonly root: string;
  readonly tsconfig: string;
  readonly ruleZones: Partial<Readonly<Record<ArchitectureRule, readonly RuleZone[]>>>;
  readonly boundaryDecoders: readonly BoundaryDecoder[];
  readonly opaqueUnknown: readonly ReasonedSymbolException[];
  readonly capabilityPredicates: readonly ReasonedSymbolException[];
  readonly exceptionAdapters: readonly ExceptionAdapter[];
  readonly openProtocolAdapters: readonly OpenProtocolAdapter[];
  readonly panicSites: readonly PanicSite[];
  readonly compatibilityOutputs: readonly CompatibilityOutput[];
  readonly structuredLoggers: readonly StructuredLogger[];
  readonly taggedErrorFormatters: readonly CompatibilitySink[];
  readonly operationalResultApis: readonly SymbolIdentity[];
  readonly eventCodecRegistries: readonly EventCodecRegistryRegistration[];
  readonly toolCodecRegistries: readonly ToolCodecRegistryRegistration[];
  readonly resultDecoders: readonly ResultDecoderRegistration[];
  readonly unknownFreeModules: readonly UnknownFreeModuleRegistration[];
  readonly persistedCodecs: readonly PersistedCodecRegistration[];
  readonly persistedStoreConsumers: readonly PersistedStoreConsumerRegistration[];
  readonly sqliteTransactionAdapters: readonly SqliteTransactionAdapterRegistration[];
  readonly sqliteTransactionConsumers: readonly SqliteTransactionConsumerRegistration[];
  readonly rawEventMessageBoundaries: readonly RawEventMessageBoundaryRegistration[];
  readonly eventDeliveryApis: readonly EventDeliveryApiRegistration[];
  readonly eventDeliveryConsumers: readonly EventDeliveryConsumerRegistration[];
}

type WorkspaceArchitectureWithoutExceptionAdapters = Omit<
  WorkspaceArchitecture,
  "exceptionAdapters"
> & {
  readonly exceptionAdapters: readonly [];
};

export type ArchitectureManifest =
  | {
      readonly version: 1;
      readonly approvedExceptionAdapters?: undefined;
      readonly approvedExceptionAdapterCatalogSha256?: undefined;
      readonly workspaces: readonly WorkspaceArchitectureWithoutExceptionAdapters[];
    }
  | {
      readonly version: 1;
      readonly approvedExceptionAdapters: readonly ApprovedExceptionAdapter[];
      readonly approvedExceptionAdapterCatalogSha256: string;
      readonly workspaces: readonly WorkspaceArchitecture[];
    };

export const EXACT_REGISTRATION_ARCHITECTURE_RULES = new Set<ArchitectureRule>([
  "architecture/open-protocol-normalization",
  "architecture/raw-event-message-boundary",
  "architecture/complete-event-codec-registry",
  "architecture/complete-tool-codec-registry",
  "architecture/result-decoder-contract",
  "architecture/unknown-free-module",
  "architecture/persisted-codec-contract",
  "architecture/persisted-codec-fixture-catalog",
  "architecture/sqlite-transaction-adapter-contract",
  "architecture/sqlite-transaction-consumer",
  "architecture/no-result-err-in-sqlite-callback",
  "architecture/event-handler-result",
  "architecture/event-delivery-policy-exhaustiveness",
]);

export const FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES = [
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
  "architecture/no-unknown-member-read",
  "architecture/no-unregistered-custom-decoder",
  "architecture/closed-union-exhaustiveness",
  "architecture/closed-union-map-exhaustiveness",
  "architecture/no-production-unwrap",
  "architecture/no-unmapped-result-capture",
  "architecture/no-unhandled-exception-contract",
  "architecture/registered-panic-site",
  "architecture/no-result-wire-leak",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
] as const satisfies readonly ArchitectureRule[];

const DEFAULT_RULE_ZONES = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [
    rule,
    EXACT_REGISTRATION_ARCHITECTURE_RULES.has(rule) ? [] : [{ include: "**" }],
  ]),
);

const EMPTY_POLICY = {
  ruleZones: DEFAULT_RULE_ZONES,
  boundaryDecoders: [],
  opaqueUnknown: [],
  capabilityPredicates: [],
  exceptionAdapters: [],
  openProtocolAdapters: [],
  panicSites: [],
  compatibilityOutputs: [],
  structuredLoggers: [],
  taggedErrorFormatters: [],
  operationalResultApis: [],
  eventCodecRegistries: [],
  toolCodecRegistries: [],
  resultDecoders: [],
  unknownFreeModules: [],
  persistedCodecs: [],
  persistedStoreConsumers: [],
  sqliteTransactionAdapters: [],
  sqliteTransactionConsumers: [],
  rawEventMessageBoundaries: [],
  eventDeliveryApis: [],
  eventDeliveryConsumers: [],
} as const;

export const ACTIVE_WORKSPACES = [
  ["apps/acp-controller", "@stanley2058/lilac-acp-controller"],
  ["apps/core", "@stanley2058/lilac-core"],
  ["apps/mini-lilac", "@stanley2058/mini-lilac"],
  ["apps/mini-lilac-server", "@stanley2058/mini-lilac-server"],
  ["apps/mini-lilac-tui", "@stanley2058/mini-lilac-tui"],
  ["apps/tool-bridge", "@stanley2058/lilac-tool-bridge"],
  ["packages/agent", "@stanley2058/lilac-agent"],
  ["packages/bash-safety", "@stanley2058/lilac-bash-safety"],
  ["packages/claude-code-bridge", "@stanley2058/lilac-claude-code-bridge"],
  ["packages/coding-tools", "@stanley2058/lilac-coding-tools"],
  ["packages/event-bus", "@stanley2058/lilac-event-bus"],
  ["packages/fs", "@stanley2058/lilac-fs"],
  ["packages/mini-lilac-client", "@stanley2058/mini-lilac-client"],
  ["packages/mini-lilac-runtime", "@stanley2058/mini-lilac-runtime"],
  ["packages/plugin-runtime", "@stanley2058/lilac-plugin-runtime"],
  ["packages/remote-fs-runner", "@stanley2058/lilac-remote-fs-runner"],
  ["packages/tool-results", "@stanley2058/lilac-tool-results"],
  ["packages/utils", "@stanley2058/lilac-utils"],
] as const;

export type ActiveWorkspaceRoot = (typeof ACTIVE_WORKSPACES)[number][0];

const STAGE_3_OPERATIONAL_RESULT_APIS = new Map<string, readonly SymbolIdentity[]>([
  [
    "packages/bash-safety",
    [
      { module: "src/analyze/analyze-command.ts", exportName: "parseBashCommand" },
      { module: "src/rules-rm.ts", exportName: "resolveRmPaths" },
    ],
  ],
  [
    "apps/core",
    [
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationWorkerRequest",
      },
      {
        module: "src/conversation/thread-summarization-worker-protocol.ts",
        exportName: "decodeThreadSummarizationWorkerResponse",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "ConversationThreadSummarizationRunner.runSummarization",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "startConversationThreadSummarizationWorker.postRequest",
      },
      {
        module: "src/conversation/thread-worker.ts",
        exportName: "startConversationThreadSummarizationWorker.runSummarization",
      },
      ...["importCustomCommandModule", "invokeCustomCommand", "settleCustomCommand"].map(
        (exportName) => ({ module: "src/custom-commands/manager.ts", exportName }),
      ),
      { module: "src/custom-commands/manager.ts", exportName: "CustomCommandManager.execute" },
      {
        module: "src/heartbeat/heartbeat-service.ts",
        exportName: "startHeartbeatServiceResult.startHeartbeatLifecycleResult",
      },
      {
        module: "src/heartbeat/heartbeat-service.ts",
        exportName: "startHeartbeatServiceResult.stopHeartbeatLifecycleResult",
      },
      ...[
        "decodeRemoteFsRunnerPackageSpec",
        "buildRemoteFsRunnerCommand",
        "sshExecRemoteFsRunnerJson",
        "remoteReadTextFile",
        "remoteReadFileBytes",
        "remoteGlob",
        "remoteGrep",
        "remoteFuzzySearch",
        "remoteEditFile",
      ].map((exportName) => ({ module: "src/tools/fs/remote-fs.ts", exportName })),
      ...[
        "validateToolServerOptions",
        "decodeToolRequestHeaders",
        "decodeToolPayload",
        "createToolServer.authenticateContext",
        "createToolServer.captureAuthenticationOperation",
        "createToolServer.resolveSafetyMode",
        "createToolServer.lookupTool",
        "createToolServer.lookupHelpTool",
      ].map((exportName) => ({
        module: "src/tool-server/create-tool-server.ts",
        exportName,
      })),
      {
        module: "src/runtime/core-dead-letter-key.ts",
        exportName: "loadOrCreateCoreDeadLetterKey",
      },
      ...[
        "readStreamChunk",
        "readResponseBody",
        "openOverflowSink",
        "writeOverflowSink",
        "closeOverflowSink",
        "abortOverflowSink",
        "removeOverflowFile",
        "cleanupOverflowCapture",
        "writeOverflowChunk",
        "activateOverflowCapture",
        "readReadableStreamTextCapped",
        "readBodyTextCapped",
        "readStreamTextCapped",
        "waitForSshExit",
        "serializeRemoteRunnerRequestJson",
      ].map((exportName) => ({ module: "src/ssh/ssh-exec.ts", exportName })),
    ],
  ],
  [
    "packages/fs",
    [
      { module: "src/filesystem-operation.ts", exportName: "captureFilesystemOperation" },
      { module: "src/filesystem-operation.ts", exportName: "captureFilesystemOperationSync" },
      { module: "src/fs-impl.ts", exportName: "canonicalizePathAsFarAsExists" },
      { module: "src/fs-impl.ts", exportName: "compileEditRegex" },
      { module: "src/hashline.ts", exportName: "applyHashlineEdits" },
      { module: "src/ripgrep.ts", exportName: "decodeRipgrepMatchLine" },
      { module: "src/ripgrep.ts", exportName: "ripgrep" },
      { module: "src/search-backend.ts", exportName: "captureFffOperation" },
      { module: "src/search-backend.ts", exportName: "captureFffSyncOperation" },
      ...[
        "decodeBundledRemoteRunnerRequest",
        "decodeBundledRemoteRunnerRequestJson",
        "decodeRemoteFsRequest",
        "decodeRemoteFsRequestJson",
        "decodeRemoteFsDaemonRequest",
        "decodeRemoteFsDaemonRequestJson",
        "decodeRemoteRunnerResponse",
        "decodeRemoteRunnerResponseJson",
        "decodeRemoteRunnerResponseValue",
      ].map((exportName) => ({ module: "src/remote-runner-protocol.ts", exportName })),
    ],
  ],
  [
    "packages/tool-results",
    [
      {
        module: "src/tool-result-artifact-store.ts",
        exportName: "createToolResultArtifactStore.captureOperation",
      },
      { module: "src/tool-result-artifact-store.ts", exportName: "validateHardLimit" },
      { module: "src/tool-result-output-normalizer.ts", exportName: "serializeOutput" },
    ],
  ],
  [
    "packages/coding-tools",
    [
      { module: "src/apply-patch.ts", exportName: "parsePatchResult" },
      { module: "src/apply-patch.ts", exportName: "applyPatchResult" },
      { module: "src/batch.ts", exportName: "collectApplyPatchTouchedPathsResult" },
      { module: "src/batch.ts", exportName: "collectEditFileTouchedPathsResult" },
      { module: "src/batch.ts", exportName: "createBatchToolResult" },
      { module: "src/guardrails.ts", exportName: "guardrailBypassAllowed" },
      { module: "src/guardrails.ts", exportName: "validateLocalCwd" },
      { module: "src/guardrails.ts", exportName: "canonicalizeAsFarAsExistsResult" },
      { module: "src/guardrails.ts", exportName: "canonicalPathAllowed" },
      { module: "src/index.ts", exportName: "createCodingToolsetResult" },
    ],
  ],
  [
    "packages/event-bus",
    [
      { module: "core-primary-lineage.ts", exportName: "extendCoreLineagePrefixDigestV1" },
      { module: "core-primary-lineage.ts", exportName: "buildCoreLineageManifestV1" },
      { module: "core-primary-lineage.ts", exportName: "decodeCorePrimaryLineageV1" },
      { module: "core-primary-lineage.ts", exportName: "createCorePrimaryLineageFreshOnlyV1" },
      { module: "redis-connection-pool.ts", exportName: "RedisConnectionPool.acquire" },
      { module: "redis-event-dead-letter.ts", exportName: "validateRedisEventDeadLetterConfig" },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decodeRedisEventDeadLetterCiphertextEnvelope",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "encryptRedisEventDeadLetterRecoveryValue",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decryptRedisEventDeadLetterRecoveryValue",
      },
      {
        module: "redis-event-dead-letter.ts",
        exportName: "decryptRedisEventDeadLetterRecord",
      },
      { module: "lilac-bus.ts", exportName: "LilacBus.subscribeTopic" },
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      { module: "mini-lilac-transport.ts", exportName: "decodeMiniLilacBoundary" },
      ...[
        "sendMessagesResult",
        "reconnectToStreamResult",
        "getSessionResult",
        "getSessionResumeResult",
        "listSessionsResult",
        "getMessagesResult",
        "streamSessionResult",
        "getTodosResult",
        "listModelsResult",
        "listProfilesResult",
        "listSkillsResult",
        "updateSessionBindingsResult",
        "steerResult",
        "interruptQueuedSteeringResult",
        "cancelResult",
        "undoResult",
        "redoResult",
        "cancelCompactionResult",
        "compactResult",
      ].map((method) => ({
        module: "mini-lilac-transport.ts",
        exportName: `MiniLilacTransport.${method}`,
      })),
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      ...["decodeClaudeContextUsage", "decodeClaudeStopHookInput", "decodeClaudeSessionInfo"].map(
        (exportName) => ({ module: "claude-code-run.ts", exportName }),
      ),
      ...[
        "validateClaudeCodeBuiltInToolsResult",
        "mapToolResultOutputToMcpResult",
        "createClaudeCodeToolBridgeResult.closeResult",
      ].map((exportName) => ({ module: "claude-code-tools.ts", exportName })),
      ...[
        "getNativeInputEstimateFloorResult",
        "recordSuccessfulModelCallResult",
        "retireForRetryResult",
        "retireForCanonicalReplacementResult",
        "retireAtRunEndResult",
        "prepareResult",
      ].map((method) => ({
        module: "claude-attempt-runtime-owner.ts",
        exportName: `ClaudeAttemptRuntimeOwner.${method}`,
      })),
    ],
  ],
  [
    "packages/utils",
    [
      { module: "codex-oauth.ts", exportName: "decodeCodexTokens" },
      { module: "codex-oauth.ts", exportName: "writeSecretFileResult" },
      { module: "codex-oauth.ts", exportName: "readCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "writeCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "clearCodexTokensResult" },
      { module: "codex-oauth.ts", exportName: "exchangeCodeForTokensResult" },
      { module: "codex-oauth.ts", exportName: "refreshAccessTokenResult" },
      { module: "codex-oauth.ts", exportName: "startCodexOAuthLogin.runExchangeResult" },
      { module: "codex-oauth.ts", exportName: "startCodexOAuthLogin.exchangeResult" },
      { module: "core-config.ts", exportName: "decodeCoreConfigYaml" },
      { module: "core-config.ts", exportName: "readCoreConfigVersionResult" },
      { module: "core-config.ts", exportName: "parseCoreConfigResult" },
      { module: "core-config.ts", exportName: "resolveDiscordTokenResult" },
      { module: "core-config/v1.ts", exportName: "decodeCoreConfigV1" },
      { module: "core-config/v1.ts", exportName: "decodeCoreConfigV1ToUniversal" },
      { module: "core-config/v2.ts", exportName: "decodeCoreConfigV2" },
      { module: "core-config/v2.ts", exportName: "decodeCoreConfigV2ToUniversal" },
      { module: "find-root.ts", exportName: "hasWorkspacesFieldResult" },
      { module: "find-root.ts", exportName: "findWorkspaceRootResult" },
      { module: "friendly-units.ts", exportName: "parseFriendlyByteSizeResult" },
      { module: "friendly-units.ts", exportName: "parseFriendlyDurationMsResult" },
      { module: "model-capability.ts", exportName: "parseModelSpecifierResult" },
      { module: "model-capability.ts", exportName: "ModelCapability.resolveResult" },
      {
        module: "model-provider.ts",
        exportName: "normalizeCodexResponsesRequestRecordResult",
      },
      ...[
        "fromDurableResolvedModelRequestResult",
        "fromDurableResolvedModelPlanResult",
        "resolveModelRefResult",
        "resolveModelChainResult",
        "resolveModelPlanResult",
        "resolveModelSlotResult",
      ].map((exportName) => ({ module: "model-slot.ts", exportName })),
      { module: "openai-responses-websocket-fetch.ts", exportName: "decodeResponsesRequestBody" },
      {
        module: "server-compaction-request.ts",
        exportName: "decodeServerCompactionPayload",
      },
      {
        module: "server-compaction-request.ts",
        exportName: "prepareServerCompactionRequestResult",
      },
      { module: "skills.ts", exportName: "readTextPrefixResult" },
      { module: "skills.ts", exportName: "parseSkillMarkdownResult" },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      ...[
        "decodeDynamicToolPluginModule",
        "decodeToolPlugin",
        "decodeToolPluginInstance",
        "decodeLevel1ToolSpec",
        "decodeServerTool",
        "decodeVoidHookResult",
        "decodeBooleanHookResult",
        "decodeStringHookResult",
        "decodeStringArrayHookResult",
        "decodeServerToolListResult",
        "decodeLevel1ToolFailureSummary",
        "decodeLevel1ExecutableMetadata",
        "decodeDisabledPluginIds",
        "decodeLevel1RegistrationKey",
      ].map((exportName) => ({ module: "capabilities.ts", exportName })),
      ...[
        "invokeToolPluginCreate",
        "invokeToolPluginInstanceInit",
        "invokeToolPluginInstanceDestroy",
        "invokeLevel1CreateTool",
        "invokeLevel1IsEnabled",
        "invokeLevel1EditTargets",
        "invokeLevel1FormatArgs",
        "invokeLevel1SummarizeFailure",
        "invokeLevel2Init",
        "invokeLevel2Destroy",
        "invokeLevel2List",
        "invokeLevel2Call",
      ].map((exportName) => ({ module: "hooks.ts", exportName })),
      ...["discoverExternalToolPlugins", "buildExternalToolPluginFreshnessKey"].map(
        (exportName) => ({ module: "discovery.ts", exportName }),
      ),
      ...["loadToolPluginModuleCapability", "loadToolPluginModule"].map((exportName) => ({
        module: "loader.ts",
        exportName,
      })),
      ...["init", "destroy", "reload", "ensureFresh"].map((method) => ({
        module: "manager.ts",
        exportName: `ToolPluginManager.${method}`,
      })),
    ],
  ],
  [
    "packages/remote-fs-runner",
    [
      "captureRuntimeOperation",
      "ensureRuntimeDir",
      "readStdinText",
      "readSocketResponse",
      "decodeSocketResponse",
      "connectOnce",
      "spawnDaemon",
      "tryConnectUntil",
      "tryAcquireStartupLock",
      "releaseStartupLock",
      "applyStartupLockCleanup",
      "runWithStartupLockCleanup",
      "runRequest",
      "executeDaemonRequest",
      "runDaemon",
    ].map((exportName) => ({ module: "src/cli.ts", exportName })),
  ],
]);

const CORE_PARTITION_8_EXCEPTION_ADAPTERS = [
  ...[
    ["build-remote-runner.ts", "captureBuildOperation.catch", "better-result", "Result.tryPromise"],
    [
      "src/discovery/discovery-service.ts",
      "DiscoveryService.searchResult.catch",
      "better-result",
      "Result.tryPromise",
    ],
    [
      "src/discovery/discovery-service.ts",
      "DiscoveryService.closeResult.catch",
      "better-result",
      "Result.try",
    ],
    [
      "src/heartbeat/heartbeat-service.ts",
      "reloadHeartbeatCoreConfig",
      "@stanley2058/lilac-utils",
      "getCoreConfig",
    ],
    [
      "src/heartbeat/heartbeat-service.ts",
      "computeHeartbeatCronAtMs",
      "@stanley2058/lilac-utils",
      "computeNextCronAtMs",
    ],
    [
      "src/ssh/ssh-config.ts",
      "readConfiguredSshHostsResult",
      "node:fs/promises",
      "injected stat/readFile dependencies",
    ],
  ].flatMap(([module, exportName, packageName, externalExportName]) => [
    {
      identity: { module, exportName },
      category: "external-to-result" as const,
      externalApi: { package: packageName, exportName: externalExportName },
      direction: "capture-external" as const,
      reason: "Maps one immediate external failure to an owned typed Result error.",
    },
    {
      identity: { module, exportName },
      category: "defect-supervisor" as const,
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic" as const,
      reason: "Preserves exact Panic identity at the same immediate external boundary.",
    },
  ]),
  ...[
    ["src/discovery/discovery-service.ts", "adaptDiscoverySearchInputResultToHost"],
    ["src/discovery/discovery-service.ts", "adaptDiscoverySearchResultToHost"],
    ["src/discovery/discovery-service.ts", "adaptDiscoveryCloseResultToHost"],
    [
      "src/shared/attachment-utils.ts",
      "resolveToolPathForRequestContext",
      "resolveToolPathForRequestContextResult",
    ],
    ["src/shared/attachment-utils.ts", "decodeDataUrl", "decodeDataUrlResult"],
    ["src/shared/req-context.ts", "requireRequestContext"],
    ["src/shared/tool-server-context.ts", "requireToolServerHeaders"],
    ["src/ssh/ssh-config.ts", "requireConfiguredSshHost"],
  ].map(([module, exportName, externalExportName]) => ({
    identity: { module: module!, exportName: exportName! },
    category: "result-to-framework" as const,
    externalApi: {
      package: "@stanley2058/lilac-core",
      exportName: externalExportName ?? "legacy caller exception contract",
    },
    direction: "signal-host" as const,
    reason: "Adapts one typed validation Result to the preserved caller exception contract.",
  })),
  ...[["src/heartbeat/common.ts", "createQuietHoursFormatter"]].flatMap(([module, exportName]) => [
    {
      identity: { module: module!, exportName: exportName! },
      category: "compatibility" as const,
      externalApi: { package: "Intl", exportName: "DateTimeFormat" },
      direction: "capture-external" as const,
      reason: "Falls back to local time only for an invalid configured timezone.",
    },
    {
      identity: { module: module!, exportName: exportName! },
      category: "defect-supervisor" as const,
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic" as const,
      reason: "Preserves exact Panic identity before applying the compatibility fallback.",
    },
  ]),
] as const satisfies readonly ExceptionAdapter[];

function preciseExceptionAdapters(
  identities: readonly PreciseExceptionIdentity[],
): readonly ExceptionAdapter[] {
  return identities.flatMap(([module, exportName, mode]) => {
    const capture: ExceptionAdapter = {
      identity: { module, exportName },
      category: "compatibility",
      externalApi: { package: "global", exportName: "language exception capture" },
      direction: "capture-external",
      reason: "Captures an exception or rejection in this exact callable.",
    };
    const signal: ExceptionAdapter = {
      identity: { module, exportName },
      category: "compatibility",
      externalApi: { package: "global", exportName: "language host failure signal" },
      direction: "signal-host",
      reason: "Signals an owned failure through this exact callable's host contract.",
    };
    switch (mode) {
      case "capture":
        return [capture];
      case "signal":
        return [signal];
      case "both":
        return [capture, signal];
    }
  });
}

const MINI_WORKSPACE_HISTORY_EXCEPTION_ADAPTERS = [
  ...["attemptHost", "attemptHostSync"].flatMap((exportName) => [
    {
      identity: { module: "src/workspace-history-store.ts", exportName },
      category: "external-to-result" as const,
      externalApi: { package: "global", exportName: "language exception capture" },
      direction: "capture-external" as const,
      reason:
        "Maps exactly one immediate host operation failure to the closed workspace-history Result.",
    },
    {
      identity: { module: "src/workspace-history-store.ts", exportName },
      category: "defect-supervisor" as const,
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic" as const,
      reason: "Preserves Panic identity while classifying only owned host failures.",
    },
  ]),
  ...["superviseOutcome", "WorkspaceHistoryStore.writeCaptureCache.<callback>"].map(
    (exportName) => ({
      identity: { module: "src/workspace-history-store.ts", exportName },
      category: "defect-supervisor" as const,
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic" as const,
      reason: "Preserves the first Panic while the exact cleanup region settles.",
    }),
  ),
] satisfies readonly ExceptionAdapter[];

const CORE_REVIEWED_PANIC_ADAPTERS = CORE_REVIEWED_PANIC_IDENTITIES.map(
  ([module, exportName]): ExceptionAdapter => ({
    identity: { module, exportName },
    category: "defect-supervisor",
    externalApi: { package: "better-result", exportName: "Panic.is" },
    direction: "observe-panic",
    reason: "Preserves exact Panic identity at this reviewed Core defect boundary.",
  }),
);

const CORE_FATAL_SIGNAL_ADAPTERS = CORE_FATAL_SIGNAL_IDENTITIES.map(
  ([module, exportName]): ExceptionAdapter => ({
    identity: { module, exportName },
    category: "defect-supervisor",
    externalApi: { package: "@stanley2058/lilac-core", exportName: "fatal Panic reporter" },
    direction: "signal-host",
    reason: "Reports a detached Panic through the exact Core fatal host callback.",
  }),
);

const CORE_ADAPTER_EVENT_EXCEPTION_ADAPTERS = [
  {
    identity: {
      module: "src/surface/bridge/adapter-event-projection.ts",
      exportName: "signalAdapterEventPlatformMismatch",
    },
    category: "defect-supervisor",
    externalApi: { package: "better-result", exportName: "Panic" },
    direction: "signal-host",
    reason: "Signals a hard invariant when a normalized adapter event contains mixed platforms.",
  },
  {
    identity: {
      module: "src/surface/produced-ref-guard.ts",
      exportName: "signalSurfaceAdapterContractViolation",
    },
    category: "defect-supervisor",
    externalApi: { package: "better-result", exportName: "Panic" },
    direction: "signal-host",
    reason:
      "Signals a hard descriptor-bound contract defect before an adapter-produced ref crosses a shared publication or persistence seam.",
  },
  {
    identity: {
      module: "src/surface/github/github-runtime-descriptor.ts",
      exportName: "deleteGithubAcknowledgement",
    },
    category: "external-to-result",
    externalApi: {
      package: "@stanley2058/lilac-core",
      exportName: "GitHub reaction deletion compatibility operation",
    },
    direction: "capture-external",
    reason:
      "Captures GitHub acknowledgement reaction deletion rejection before the descriptor finalization policy clears process-local acknowledgement state.",
  },
  {
    identity: {
      module: "src/surface/github/github-runtime-descriptor.ts",
      exportName: "preserveGithubRelayPolicyPanic",
    },
    category: "defect-supervisor",
    externalApi: { package: "better-result", exportName: "Panic.is" },
    direction: "observe-panic",
    reason: "Preserves exact Panic identity at the GitHub acknowledgement deletion boundary.",
  },
] as const satisfies readonly ExceptionAdapter[];

const CORE_TOOL_SERVER_BOUNDARY_DECODERS = [
  ...[
    "isCurrentSessionScopedSurfaceCall",
    "isRestrictedCallableAllowed",
    "createToolServer.pluginCallCompatibilityError",
    "createToolServer.<callback>.<callback>",
    "createToolServer.<callback>",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/create-tool-server.ts", exportName },
    category: "request" as const,
  })),
  ...[
    "normalizeAttachmentAddFilesInput",
    "asBuffer",
    "downloadToBuffer",
    "Attachment.callDownload",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/attachment.ts", exportName },
    category: "plugin" as const,
  })),
  {
    identity: {
      module: "src/tool-server/tools/content-inspect.ts",
      exportName: "inferContentInspectType",
    },
    category: "request",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "hasSensitiveSchema.visit",
    },
    category: "projection",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "decodeWorkflowJsonObject",
    },
    category: "projection",
  },
  {
    identity: {
      module: "src/tool-server/tools/programmatic-workflow.ts",
      exportName: "projectWorkflowJsonObject",
    },
    category: "projection",
  },
  ...[
    "withDefaultSessionId",
    "withDefaultMessageId",
    "mustPresentString",
    "normalizeAttachmentMeta",
    "getDiscordReferenceFromRaw",
    "extractDiscordAttachmentMetaFromRaw",
    "getMessageAttachmentMeta",
    "getSurfaceMessageRichText",
    "getDiscordMessageTypeMetaFromRaw",
    "resolveDiscordReferencedMessage",
    "toCompactMessage",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/surface.ts", exportName },
    category: "projection" as const,
  })),
  {
    identity: { module: "src/tool-server/tools/ssh.ts", exportName: "readStreamText" },
    category: "wire",
  },
  {
    identity: { module: "src/tool-server/tools/ssh.ts", exportName: "decodeSshProbeOutput" },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
      exportName: "decodeFirecrawlSearchResponse",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
      exportName: "decodeFirecrawlSearchItems",
    },
    category: "wire",
  },
  ...[
    "getNumericField",
    "getErrorStatus",
    "isRetriableWebProviderError",
    "decodeFirecrawlScrapeResponse",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/tools/web.ts", exportName },
    category: "projection" as const,
  })),
  {
    identity: {
      module: "src/tool-server/tools/onboarding.ts",
      exportName: "decodeGithubReleaseResponse",
    },
    category: "wire",
  },
  {
    identity: {
      module: "src/tool-server/tools/onboarding.ts",
      exportName: "decodeGithubInstallationRepositoriesCount",
    },
    category: "wire",
  },
  ...["previewReason", "createToolServerHealthState.recordUnhandledRejection"].map(
    (exportName) => ({
      identity: { module: "src/tool-server/health-state.ts", exportName },
      category: "projection" as const,
    }),
  ),
  ...[
    "parseCgroupByteLimit",
    "parseProcStatusMemory",
    "parsePressureMetrics",
    "parseSmapsRollupMemory",
  ].map((exportName) => ({
    identity: { module: "src/tool-server/runtime-diagnostics.ts", exportName },
    category: "projection" as const,
  })),
] as const satisfies readonly BoundaryDecoder[];

const INTEGRATED_BOUNDARY_DECODERS = new Map<string, readonly BoundaryDecoder[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: { module: "external-adapters.ts", exportName: "projectExternalFailure" },
        category: "projection",
      },
      ...["decodeRunRecord", "decodeRunCancellation", "decodeSessionIndex"].map((exportName) => ({
        identity: { module: "run-store.ts", exportName },
        category: "persistence" as const,
      })),
      {
        identity: { module: "external-adapters.ts", exportName: "replaceExternalFailureMessage" },
        category: "projection",
      },
    ],
  ],
  [
    "apps/mini-lilac",
    [
      { identity: { module: "build.ts", exportName: "decodeSourcePackage" }, category: "request" },
      {
        identity: { module: "install-local.ts", exportName: "decodeNpmPackOutput" },
        category: "wire",
      },
      {
        identity: { module: "build.ts", exportName: "signalBuildFailure" },
        category: "projection",
      },
      {
        identity: { module: "install-local.ts", exportName: "signalLocalInstallFailure" },
        category: "projection",
      },
    ],
  ],
  [
    "apps/tool-bridge",
    [
      "decodeListPayload",
      "decodeCallableIdListPayload",
      "decodeToolHelpPayload",
      "decodeToolCallPayload",
      "decodeBackendVersionPayload",
      "decodeOnboardingGpgGenerate",
      "decodeOnboardingGpgExport",
      "decodeJsonText",
      "decodeJsonObject",
      "extractErrorMessage",
    ].map((exportName) => ({
      identity: { module: "client.ts", exportName },
      category: "wire" as const,
    })),
  ],
  [
    "packages/agent",
    [
      ...[
        "isJsonToolOutputValue",
        "isJsonToolOutputValueInner",
        "toJsonToolOutputValue",
        "invalidInputMessage",
        "consumeAtomicToolResultStream",
        "settleAtomicToolCallImpl",
        "cleanupFailedAtomicToolCall",
        "resolveAtomicToolFailureAfterCleanup",
        "finalizeSettledAtomicToolCall",
      ].map((exportName) => ({
        identity: { module: "atomic-tool-execution.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "cloneSteeringValue",
        "isClonedModelMessage",
        "recoveryToolOutput",
        "AiSdkPiAgent.executeExternalToolCall",
        "AiSdkPiAgent.finishIdleRecovery",
        "AiSdkPiAgent.runTurn",
        "AiSdkPiAgent.executeExpansionChildren",
        "extractToolCallsFromMessages",
      ].map((exportName) => ({
        identity: { module: "ai-sdk-pi-agent.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "cloneMessage.map.<callback@1>",
        "completedAssistantPrefix.map.<callback@1>",
        "recoveryCheckpointForMessages.map.<callback@1>",
      ].map((exportName) => ({
        identity: { module: "ai-sdk-pi-agent.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "tool-call-id-normalization.ts",
          exportName: "rewriteAssistantToolCallIds.map.<callback@1>",
        },
        category: "projection",
      },
      ...["visit", "isLikelyContextOverflowError"].map((exportName) => ({
        identity: { module: "context-overflow.ts", exportName },
        category: "projection" as const,
      })),
      ...["readOpenAIServerCompactionArtifact", "compactWithOpenAIResponsesResult"].map(
        (exportName) => ({
          identity: { module: "openai-server-compaction.ts", exportName },
          category: "plugin" as const,
        }),
      ),
      ...[
        "getString",
        "stringifyUnknown",
        "isDataUrl",
        "withoutInlineMediaPayload",
        "stringifyTextOnly",
        "estimateMessageTokens",
        "repairTranscriptForCompaction",
        "renderMessageForSummary",
        "computeOverflowRecoveryDecision",
        "isAbortError",
        "attachAutoCompaction.notifyUnknownCapability",
      ].map((exportName) => ({
        identity: { module: "auto-compaction.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "auto-compaction.ts", exportName: "cloneMessage.map.<callback@1>" },
        category: "projection",
      },
      {
        identity: {
          module: "openai-server-compaction.ts",
          exportName: "materializeOpenAIServerCompaction.flatMap.<callback@1>.map.<callback@1>",
        },
        category: "projection",
      },
      ...[
        "parseStrictJsonValue",
        "normalizeCanonicalValue",
        "canonicalJsonStringify",
        "fileIdentity",
        "valueIsUrlData",
        "projectResultContentItem",
        "toolOutputProjection",
        "projectFilePart",
        "projectCanonicalMessagesV1",
        "hashExecutionScopeV1",
        "isRecognizedMediaRecord",
        "safeReplayJsonStringify",
        "renderActivityGroup",
        "sanitizeReplayValue",
        "toolInputText",
        "toolOutputValueText",
        "outputText",
        "addToolResult",
        "addOrphanResult",
        "addMalformedToolActivity",
        "takeMatchingActivity",
        "applyToolResultPart",
        "applyApprovalResponsePart",
        "applyAdjacentToolPart",
        "lowerAssistantExchange",
        "preparePlainTextReplayForTarget",
      ].map((exportName) => ({
        identity: { module: "session-continuation.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "readNumber",
        "hasRetryErrorExhausted",
        "hasTransientRetryErrorExhausted",
        "hasTransientModelErrorHint",
        "isRetryableTransientModelError",
        "defaultErrorSummary",
        "createTransientModelRetryController",
      ].map((exportName) => ({
        identity: { module: "transient-model-retry.ts", exportName },
        category: "projection" as const,
      })),
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: { module: "src/config.ts", exportName: "decodeRuntimeConfig" },
        category: "request",
      },
      ...[
        "decodeProviderConfig",
        "decodeProviderAuth",
        "writeProviderAuthResult",
        "writeProviderAuth",
      ].map((exportName) => ({
        identity: { module: "src/providers.ts", exportName },
        category: "plugin" as const,
      })),
      ...[
        "parseModelRefResult",
        "decodeModelsDevRegistry",
        "decodeModelsDevCache",
        "decodeV1ModelsResponse",
        "modelsDevProvider",
      ].map((exportName) => ({
        identity: { module: "src/model-catalog.ts", exportName },
        category: "wire" as const,
      })),
      {
        identity: {
          module: "src/sqlite-transcript-projection.ts",
          exportName: "acceptsMiniLilacPersistedSuperJsonValue",
        },
        category: "persistence",
      },
      ...[
        "decodeMiniLilacStoreRow",
        "decodeMiniLilacStoreRows",
        "decodeStoredHistoryNavigationResult",
        "decodeStoredUIMessageChunk",
        "decodeStoredSessionSnapshot",
        "parseStoredUIMessageChunk",
        "serialize",
        "serializeStoreValueResult",
        "canonicalJsonValue",
        "canonicalCommandPayloadResult",
        "decodeCanonicalStoredCommandRequest",
        "decodeCanonicalRootPromptCommand",
        "serializeOptionalTerminalResult",
        "canonicalValuesEqual",
        "isCanonicalPrefix",
        "decodeSessionRowSnapshot",
        "decodeRunRow",
        "decodeMiniMainClaudeBindingRow",
        "decodeMiniMainClaudeAttemptRow",
        "MiniLilacSqliteStore.decodeStructuralHistoryRow",
        "MiniLilacSqliteStore.decodeStructuralHistoryRows",
        "MiniLilacSqliteStore.parseHistoryNavigationResult",
        "MiniLilacSqliteStore.saveCommandResult",
        "MiniLilacSqliteStore.saveCommandResultResult",
        "throwPrimaryAfterCleanup",
      ].map((exportName) => ({
        identity: { module: "src/sqlite-store.ts", exportName },
        category: "persistence" as const,
      })),
      ...[
        "parseSessionConfig",
        "compactionEventFor",
        "generateSubagentSessionName",
        "toolOutputDisplayValue",
        "serializedUtf8Bytes",
        "controlCommandRequest",
        "browserSafeUsage",
        "browserSafeProviderMetadata",
        "splitFinalAnswerUIMessage",
        "chunkMatchesRollback",
        "SessionActor.startPrompt.withLock.<callback@1>",
        "SessionActor.commitRunFinalization.<callback>",
        "SessionActor.handleAgentEvent",
        "SessionActor.buildAgent.decideTurnError",
        "SessionActor.buildAgent.onCompactionEnd",
        "SessionActor.appendToolResultChunk",
        "SessionActor.queueAutomaticCompaction",
        "SessionActor.steer.withLock.<callback@1>",
        "SessionActor.cancel.withLock.<callback@1>",
        "SessionActor.undo.withLock.<callback@1>",
        "SessionActor.redo.withLock.<callback@1>",
        "SessionActor.replayHistoryNavigation",
        "SessionActor.compact.withLock.<callback@1>",
        "SessionActor.runCompaction.event",
        "SessionActor.summarizeForCompaction",
        "SessionActor.updateBindings.withLock.<callback@1>",
        "SessionService.constructor",
        "SessionService.collectDelegatedRun",
        "SessionService.interruptQueuedSteering",
      ].map((exportName) => ({
        identity: { module: "src/session-service.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.interruptQueuedSteering.withLock.<callback@1>@1",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.interruptQueuedSteering.withLock.<callback@1>@2",
        },
        category: "projection",
      },
      ...["decodeWebfetchInput", "executeWebfetchResult", "executeWebfetch"].map((exportName) => ({
        identity: { module: "src/webfetch.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "WorkspaceHistoryStoreError.constructor",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "runWorkspaceHistoryCleanup",
        },
        category: "projection",
      },
    ],
  ],
  [
    "apps/core",
    [
      ...CORE_TOOL_SERVER_BOUNDARY_DECODERS,
      ...CORE_FINAL_BOUNDARY_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "projection" as const,
      })),
      ...[
        ["src/github/github-api.ts", "decodeGithubApiErrorResponse", "wire"],
        ["src/github/github-api.ts", "githubFetchJsonResult", "wire"],
        ["src/github/github-app.ts", "readGithubAppSecretResult", "persistence"],
        ["src/github/github-user-token.ts", "readGithubUserTokenSecretResult", "persistence"],
      ].map(([module, exportName, category]) => ({
        identity: { module: module!, exportName: exportName! },
        category: category as "wire" | "persistence",
      })),
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "decodeToolRequestHeaders",
        },
        category: "request",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "decodeToolPayload",
        },
        category: "plugin",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "projectUnhandledRejectionReason",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.recordUnhandledRejectionAtBoundary",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "projectFatalToolCallDefect",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/surface/authenticated-request.ts",
          exportName: "projectAuthenticatedRequest",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/tool-server/request-message-cache.ts",
          exportName: "projectCachedRequestMessageLineage",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationWorkerRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker-protocol.ts",
          exportName: "decodeThreadSummarizationWorkerResponse",
        },
        category: "wire",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      ...[
        "createFilesystemTools.toModelOutput@1",
        "createFilesystemTools.toModelOutput@2",
        "createFilesystemTools.toModelOutput@3",
        "createFilesystemTools.toModelOutput@4",
      ].map((exportName) => ({
        identity: { module: "src/filesystem.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "src/batch.ts", exportName: "decodeBatchEditInput" },
        category: "plugin",
      },
      {
        identity: { module: "src/batch.ts", exportName: "validateInput" },
        category: "plugin",
      },
      {
        identity: { module: "src/batch.ts", exportName: "resolveBatchEditTargets" },
        category: "plugin",
      },
      {
        identity: {
          module: "src/instructions.ts",
          exportName: "decodePreviouslyLoadedInstructionPaths",
        },
        category: "projection",
      },
      {
        identity: { module: "src/bash.ts", exportName: "bashFailureMessage" },
        category: "projection",
      },
    ],
  ],
  [
    "packages/event-bus",
    [
      {
        identity: { module: "redis-streams-bus.ts", exportName: "decodeRedisReadResponse" },
        category: "wire",
      },
      {
        identity: { module: "redis-streams-bus.ts", exportName: "decodeRedisWatermarkResponse" },
        category: "wire",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeRedisDeadLetterEvidenceEntry",
        },
        category: "persistence",
      },
      {
        identity: {
          module: "redis-event-dead-letter.ts",
          exportName: "decodeRedisDeadLetterTransactionId",
        },
        category: "persistence",
      },
    ],
  ],
  [
    "apps/mini-lilac-tui",
    [
      {
        identity: { module: "src/opentui-boundary.ts", exportName: "decodeDraftExtmarkData" },
        category: "plugin",
      },
      {
        identity: { module: "src/preferences.ts", exportName: "decodeBindingPreferences" },
        category: "persistence",
      },
      {
        identity: {
          module: "src/ui-message-chunk-projection.ts",
          exportName: "projectMiniLilacStreamChunk",
        },
        category: "projection",
      },
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "resolveTerminalShutdownOutcome",
        },
        category: "projection",
      },
      ...[
        "parseInput",
        "decodeBash",
        "decodeEditFile",
        "decodeSubagentDelegate",
        "decodeWebsearch",
        "projectToolObservation",
      ].map((exportName) => ({
        identity: { module: "src/tool-observation-projection.ts", exportName },
        category: "projection" as const,
      })),
      ...["observationFromCanonicalPart", "UIMessageChunkProjectionState.toolChunk"].map(
        (exportName) => ({
          identity: { module: "src/ui-message-chunk-projection.ts", exportName },
          category: "projection" as const,
        }),
      ),
    ],
  ],
  [
    "apps/mini-lilac-server",
    [
      ...["decodeMiniLilacHttpRequest", "decodeMiniLilacUiMessages"].map((exportName) => ({
        identity: { module: "src/server.ts", exportName },
        category: "request" as const,
      })),
      {
        identity: { module: "src/main.ts", exportName: "decodeMiniLilacCliOptions" },
        category: "request",
      },
      {
        identity: { module: "src/main.ts", exportName: "parseCliArgs" },
        category: "request",
      },
      {
        identity: { module: "src/server.ts", exportName: "adaptMiniLilacPersistenceResult" },
        category: "projection",
      },
      {
        identity: { module: "src/server.ts", exportName: "classifyHttpOperationFailure" },
        category: "projection",
      },
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "decodeMiniLilacBoundary" },
        category: "wire",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "resultToMiniLilacClientValue",
        },
        category: "projection",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "resultToMiniLilacCompatibilityFailure",
        },
        category: "projection",
      },
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "normalizeStreamChunkResult" },
        category: "wire",
      },
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      ...[
        "decodeClaudeNativeSessionStart",
        "decodeClaudeContextUsage",
        "decodeClaudeStopHookInput",
        "decodeClaudeSessionInfo",
        "projectClaudeSdkMessage",
        "materializeClaudeCodeRunResult.observeSdkMessage",
      ].map((exportName) => ({
        identity: { module: "claude-code-run.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: {
          module: "claude-code-tools.ts",
          exportName: "createClaudeCodeToolBridgeResult",
        },
        category: "plugin",
      },
      {
        identity: { module: "claude-code-run.ts", exportName: "readSessionInfo" },
        category: "plugin",
      },
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "materializeClaudeCodeRunResult.beginContextCapture.<callback>",
        },
        category: "plugin",
      },
      {
        identity: { module: "claude-code-run.ts", exportName: "boundedExternalFailure" },
        category: "projection",
      },
      {
        identity: {
          module: "claude-code-tools.ts",
          exportName: "mapToolResultOutputToMcpResult",
        },
        category: "projection",
      },
    ],
  ],
  [
    "packages/fs",
    [
      {
        identity: { module: "src/remote-runner-protocol.ts", exportName: "decodeJson" },
        category: "wire",
      },
      {
        identity: { module: "src/remote-runner-protocol.ts", exportName: "decodeRequest" },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeBundledRemoteRunnerRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteFsRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteFsDaemonRequest",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteRunnerResponse",
        },
        category: "wire",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeRemoteRunnerResponseValue",
        },
        category: "wire",
      },
      {
        identity: { module: "src/filesystem-operation.ts", exportName: "decodeFilesystemFailure" },
        category: "projection",
      },
      {
        identity: { module: "src/ripgrep.ts", exportName: "decodeRipgrepMatchLine" },
        category: "wire",
      },
    ],
  ],
  [
    "packages/remote-fs-runner",
    [
      {
        identity: { module: "src/cli.ts", exportName: "opaqueErrorCause" },
        category: "projection",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      ...[
        "validateToolPluginMetaCapability",
        "validateLevel1ToolSpecCapability",
        "validateServerToolCapability",
        "validateToolPluginInstanceCapability",
        "validateToolPluginCapability",
        "validateDynamicToolPluginModuleCapability",
        "validateServerToolListResultCapability",
        "validateLevel1ToolFailureSummaryCapability",
        "decodeDynamicToolPluginModule",
        "decodeToolPlugin",
        "decodeToolPluginInstance",
        "decodeLevel1ToolSpec",
        "decodeServerTool",
        "decodeVoidHookResult",
        "decodeBooleanHookResult",
        "decodeStringHookResult",
        "decodeStringArrayHookResult",
        "decodeServerToolListResult",
        "decodeLevel1ToolFailureSummary",
        "decodeLevel1ExecutableMetadata",
        "decodeDisabledPluginIds",
        "decodeLevel1RegistrationKey",
      ].map((exportName) => ({
        identity: { module: "capabilities.ts", exportName },
        category: "plugin" as const,
      })),
      {
        identity: { module: "discovery.ts", exportName: "decodePluginFilesystemErrorCode" },
        category: "projection",
      },
      {
        identity: { module: "discovery.ts", exportName: "decodePluginPackageJsonText" },
        category: "plugin",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "custom-commands.ts", exportName: "decodeCustomCommandResult" },
        category: "plugin",
      },
      {
        identity: { module: "custom-commands.ts", exportName: "readCustomCommandDefinition" },
        category: "plugin",
      },
      {
        identity: { module: "agent-prompts.ts", exportName: "parsePromptTemplateState" },
        category: "persistence",
      },
      {
        identity: { module: "ai-error.ts", exportName: "parseProviderErrorDetails" },
        category: "projection",
      },
      {
        identity: { module: "ai-error.ts", exportName: "locateAiErrors" },
        category: "projection",
      },
      {
        identity: { module: "ai-error.ts", exportName: "extractAiErrorLogDetails" },
        category: "projection",
      },
      ...["readString", "readStringOrNumber"].map((exportName) => ({
        identity: { module: "ai-error.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "build-info.ts", exportName: "decodeBuildInfo" },
        category: "persistence",
      },
      {
        identity: { module: "codex-oauth.ts", exportName: "parseJwtClaims" },
        category: "wire",
      },
      {
        identity: { module: "codex-oauth.ts", exportName: "extractAccountIdFromClaims" },
        category: "wire",
      },
      ...[
        "decodeCodexTokens",
        "writeCodexTokensResult",
        "exchangeCodeForTokensResult",
        "refreshAccessTokenResult",
      ].map((exportName) => ({
        identity: { module: "codex-oauth.ts", exportName },
        category: "wire" as const,
      })),
      ...[
        "projectLegacyCodexTokenWriteFailure",
        "projectLegacyCodexOAuthFailure",
        "projectLegacyCodexOAuthLoginFailure",
        "readCodexTokens",
        "clearCodexTokens",
      ].map((exportName) => ({
        identity: { module: "codex-oauth.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "readCoreConfigVersionResult",
        "readCoreConfigVersion",
        "parseCoreConfigResult",
        "parseCoreConfig",
        "getCoreConfig",
      ].map((exportName) => ({
        identity: { module: "core-config.ts", exportName },
        category: "request" as const,
      })),
      {
        identity: { module: "core-config.ts", exportName: "projectLegacyCoreConfigFailure" },
        category: "projection",
      },
      ...[
        ["core-config/v1.ts", "decodeCoreConfigV1"],
        ["core-config/v1.ts", "parseCoreConfigV1"],
        ["core-config/v1.ts", "coreConfigV1ToUniversal"],
        ["core-config/v1.ts", "decodeCoreConfigV1ToUniversal"],
        ["core-config/v1.ts", "parseCoreConfigV1ToUniversal"],
        ["core-config/v2.ts", "decodeCoreConfigV2"],
        ["core-config/v2.ts", "parseCoreConfigV2"],
        ["core-config/v2.ts", "coreConfigV2ToUniversal"],
        ["core-config/v2.ts", "decodeCoreConfigV2ToUniversal"],
        ["core-config/v2.ts", "parseCoreConfigV2ToUniversal"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "request" as const,
      })),
      {
        identity: {
          module: "core-config/unknown-keys.ts",
          exportName: "collectUnknownConfigKeyPaths",
        },
        category: "projection",
      },
      ...["migrateWebExtractConfigValue", "migrateWebConfigValue"].map((exportName) => ({
        identity: { module: "core-config/v1.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "model-capability.ts", exportName: "decodeModelsDevRegistry" },
        category: "wire",
      },
      {
        identity: { module: "model-capability.ts", exportName: "ModelCapability.resolve" },
        category: "projection",
      },
      {
        identity: {
          module: "model-capability.ts",
          exportName: "ModelCapability.loadRegistryResult.<callback>",
        },
        category: "wire",
      },
      ...["openAIMessagePhase", "decodeOpenAICompactionPart"].map((exportName) => ({
        identity: { module: "model-message-provider-options.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "model-message-provider-options.ts",
          exportName: "withoutOpenAIItemIds.map.<callback@1>.map.<callback@1>",
        },
        category: "projection",
      },
      ...[
        ["decodeCodexRequestBody", "request"],
        ["decodeCodexResponsesRequestBody", "request"],
        ["normalizeCodexResponsesRequestRecordResult", "request"],
        ["codexReasoningSummaryKey", "projection"],
        ["normalizeCodexCompactionItemId", "projection"],
        ["createCodexResponsesEventNormalizer.<callback>", "projection"],
      ].map(([exportName, category]) => ({
        identity: { module: "model-provider.ts", exportName },
        category: category as BoundaryCategory,
      })),
      ...[
        "asRecord",
        "readString",
        "readNumber",
        "extractResponseId",
        "extractTurnState",
        "extractOutputItemDone",
        "updateOutputItemDraft",
        "normalizeReplayMessageItem.map.<callback@1>",
        "normalizeReplayReasoningItem.map.<callback@1>",
        "normalizeResponsesFailureEvent",
        "normalizeErrorEventShape",
        "isPreviousResponseNotFoundError",
        "extractErrorDetails",
        "readHeaderValue",
        "projectResponsesStreamError",
        "projectResponsesEvent",
      ].map((exportName) => ({
        identity: { module: "openai-responses-websocket-fetch.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "createOpenAIResponsesWebSocketFetch.reportAutoFallback",
        "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onMessage.catch.<callback@1>",
      ].map((exportName) => ({
        identity: { module: "openai-responses-websocket-fetch.ts", exportName },
        category: "projection" as const,
      })),
      ...[
        "parseFriendlyUnitResult",
        "parseFriendlyByteSizeResult",
        "parseFriendlyDurationMsResult",
        "parseFriendlyByteSize",
        "parseFriendlyDurationMs",
      ].map((exportName) => ({
        identity: { module: "friendly-units.ts", exportName },
        category: "request" as const,
      })),
      ...[
        "addNormalizedArgFields",
        "normalizeRecordForOpenObserve",
        "projectOpenObserveRequestFailure",
        "signalOpenObservePanic",
      ].map((exportName) => ({
        identity: { module: "logging.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: { module: "llm-wire-debug.ts", exportName: "redactValue" },
        category: "projection",
      },
      {
        identity: { module: "llm-wire-debug.ts", exportName: "projectWireDebugEventType" },
        category: "projection",
      },
      {
        identity: { module: "llm-wire-debug.ts", exportName: "createWriter.<callback>" },
        category: "projection",
      },
      ...["errorMessage", "errorCode"].map((exportName) => ({
        identity: { module: "runtime-utils.ts", exportName },
        category: "projection" as const,
      })),
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "isServerCompactionTrigger",
        },
        category: "request",
      },
      {
        identity: {
          module: "openai-responses-websocket-fetch.ts",
          exportName: "decodeResponsesRequestBody",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "decodeServerCompactionPayload",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "prepareServerCompactionRequestResult",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "withServerCompactionRequestFetch.wrappedFetch",
        },
        category: "projection",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "encodeServerCompactionPayload.filter.<callback@1>",
        },
        category: "request",
      },
      {
        identity: {
          module: "server-compaction-request.ts",
          exportName: "encodeServerCompactionPayload",
        },
        category: "request",
      },
      {
        identity: { module: "skills.ts", exportName: "parseSkillMarkdownResult" },
        category: "plugin",
      },
      ...[
        "normalizeToolCallInputValue",
        "normalizeAssistantToolCallInputMessage.map.<callback@1>",
      ].map((exportName) => ({
        identity: { module: "tool-call-input-normalization.ts", exportName },
        category: "projection" as const,
      })),
    ],
  ],
]);

const INTEGRATED_OPAQUE_UNKNOWN = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: {
          module: "external-adapters.ts",
          exportName: "replaceExternalFailureMessage",
        },
        reason: "Carries the already-owned external failure cause without reinterpreting it.",
      },
    ],
  ],
  [
    "apps/tool-bridge",
    [
      {
        identity: { module: "client.ts", exportName: "reportMainDefect" },
        reason: "Classifies an opaque top-level CLI defect only for bounded process reporting.",
      },
      {
        identity: { module: "index.ts", exportName: "recordUnhandledRejection" },
        reason: "Carries the process rejection reason opaquely to the Core server supervisor.",
      },
    ],
  ],
  [
    "packages/agent",
    [
      {
        identity: { module: "ai-sdk-pi-agent.ts", exportName: "AiSdkPiAgent.requestIdleRecovery" },
        reason:
          "Carries the model provider's idle failure opaquely to the configured retry policy.",
      },
      {
        identity: { module: "auto-compaction.ts", exportName: "compactCanonicalMessages" },
        reason:
          "Carries a server-compaction callback failure opaquely to the caller-owned observer.",
      },
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: { module: "src/session-service.ts", exportName: "sha256Fingerprint" },
        reason:
          "Serializes an opaque provider-owned value only to derive a stable content fingerprint.",
      },
      {
        identity: {
          module: "src/workspace-history-store.ts",
          exportName: "WorkspaceHistoryStore.withWorkspaceLock",
        },
        reason:
          "Carries a supervised defect opaquely through the public legacy lock host contract.",
      },
      {
        identity: { module: "src/session-service.ts", exportName: "rethrowSessionPanic" },
        reason: "Observes an opaque failure only to preserve Panic identity.",
      },
      {
        identity: {
          module: "src/session-service.ts",
          exportName: "SessionActor.reportEventFailure",
        },
        reason: "Carries an opaque agent event failure to bounded diagnostics and cancellation.",
      },
    ],
  ],
  [
    "apps/core",
    [
      ...CORE_FINAL_REVIEWED_OPAQUE_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        reason:
          "Carries an opaque external cause through an exact error, callback, or function contract without interpreting it as domain data.",
      })),
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "createCoreRuntimeCleanupSupervisor.runOutcome",
        },
        reason:
          "Carries an owned cleanup Result error opaquely to the runtime diagnostic formatter.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner/raw.ts",
          exportName: "preserveAgentRunnerRaw",
        },
        reason: "Preserves a decoded event raw payload opaquely for downstream boundary adapters.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner/formatting.ts",
          exportName: "safeStringify",
        },
        reason: "Serializes an opaque diagnostic value without interpreting domain structure.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.<callback>.<callback>",
        },
        reason:
          "Carries decoded plugin tool output opaquely to the established tool response envelope.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.<callback>",
        },
        reason:
          "Carries settled plugin tool output opaquely through the established HTTP wire contract.",
      },
      {
        identity: { module: "src/tools/batch.ts", exportName: "batchTool" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
      {
        identity: {
          module: "src/plugins/manager.ts",
          exportName:
            "createCoreToolPluginManager.buildLevel1Toolset.buildContext.resolveEditTargets",
        },
        reason: "Carries opaque external plugin arguments to the plugin-owned editTargets hook.",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      {
        identity: { module: "src/batch.ts", exportName: "createBatchTool" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
      {
        identity: { module: "src/batch.ts", exportName: "createBatchToolResult" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      {
        identity: {
          module: "claude-code-run.ts",
          exportName: "ClaudeCodeRunModelSettings.onSdkMessage",
        },
        reason:
          "Carries the SDK callback value opaquely to the registered Claude message projector and optional observer.",
      },
      {
        identity: { module: "claude-code-tools.ts", exportName: "stringifyJson" },
        reason: "Serializes plugin-owned tool output without interpreting its domain structure.",
      },
      {
        identity: { module: "claude-code-run.ts", exportName: "boundedExternalFailure" },
        reason: "Bounds an opaque external failure cause for a callback-safe diagnostic.",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      {
        identity: { module: "zod-cli.ts", exportName: "formatValue" },
        reason: "Formats generic Zod literal and default values without interpreting domain data.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "opaquePluginExceptionMessage" },
        reason: "Formats an opaque plugin exception without treating it as domain data.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "safePluginExceptionCause" },
        reason: "Projects an opaque plugin exception into a safe plain Error cause.",
      },
      {
        identity: { module: "discovery.ts", exportName: "opaquePluginDiscoveryExceptionMessage" },
        reason: "Formats an opaque filesystem exception without treating it as domain data.",
      },
      {
        identity: { module: "types.ts", exportName: "Level1ToolBuildContext.resolveEditTargets" },
        reason:
          "Public plugin compatibility contract carries tool arguments opaquely to the owning plugin.",
      },
      {
        identity: { module: "types.ts", exportName: "Level1ToolSpec.editTargets" },
        reason: "Public plugin hook receives its plugin-owned tool argument shape opaquely.",
      },
      {
        identity: { module: "types.ts", exportName: "Level1ToolSpec.formatArgs" },
        reason: "Public plugin hook formats its plugin-owned tool argument shape opaquely.",
      },
      {
        identity: { module: "types.ts", exportName: "Level1ToolSpec.summarizeFailure" },
        reason:
          "Public plugin hook receives the host tool result as an opaque compatibility value.",
      },
      {
        identity: { module: "manager.ts", exportName: "ToolPluginManagerOptions.getPluginConfig" },
        reason:
          "Public plugin configuration remains opaque until the selected plugin interprets it.",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "runtime-utils.ts", exportName: "opaqueErrorMessage" },
        reason: "Formats an opaque external exception without interpreting domain data.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "opaqueErrorCause" },
        reason: "Carries an inspectable exception cause or substitutes a plain opaque Error.",
      },
      {
        identity: { module: "codex-oauth.ts", exportName: "startCodexOAuthLogin.fail" },
        reason: "Carries an opaque callback-server failure to the established Promise rejection.",
      },
      {
        identity: { module: "logging.ts", exportName: "isPrimitive" },
        reason: "Checks generic logger values without interpreting application domain data.",
      },
      {
        identity: { module: "logging.ts", exportName: "safeJsonStringify" },
        reason: "Serializes generic logger values without interpreting application domain data.",
      },
      {
        identity: { module: "logging.ts", exportName: "addNormalizedArgFields" },
        reason: "Projects generic logger arguments into bounded structured fields.",
      },
      {
        identity: { module: "logging.ts", exportName: "normalizeRecordForOpenObserve" },
        reason: "Projects a generic logger record into the OpenObserve transport shape.",
      },
      {
        identity: { module: "llm-wire-debug.ts", exportName: "redactValue" },
        reason: "Redacts generic wire-debug values without interpreting application domain data.",
      },
      ...[
        "MirroredLogger.log",
        "MirroredLogger.logDebug",
        "MirroredLogger.logInfo",
        "MirroredLogger.logWarn",
        "MirroredLogger.logError",
        "MirroredLogger.logFatal",
        "MirroredLogger.debug",
        "MirroredLogger.info",
        "MirroredLogger.warn",
        "MirroredLogger.error",
        "MirroredLogger.fatal",
      ].map((exportName) => ({
        identity: { module: "logging.ts", exportName },
        reason: "Carries logger message arguments opaquely to the registered structured sink.",
      })),
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "MiniLilacParsedStream.cleanupSource",
        },
        reason:
          "Carries the ReadableStream cancellation reason opaquely to the registered source cleanup adapter.",
      },
    ],
  ],
]);

const INTEGRATED_CAPABILITY_PREDICATES = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "apps/acp-controller",
    [
      {
        identity: { module: "acp-harness-client.ts", exportName: "isAuthRequiredError" },
        reason:
          "Checks the exact ACP RequestError authorization code on an owned external failure.",
      },
    ],
  ],
  [
    "packages/agent",
    [
      {
        identity: { module: "failure-adapters.ts", exportName: "isAgentPanic" },
        reason: "Checks exact Panic identity without interpreting an ordinary failure.",
      },
      {
        identity: { module: "tool-call-expansion.ts", exportName: "isToolExpansion" },
        reason: "Checks the exact project-owned ToolExpansion class and brand.",
      },
      {
        identity: { module: "atomic-tool-execution.ts", exportName: "isAsyncIterable" },
        reason: "Checks only the standard async-iterator capability on tool output.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isInvalidToolInputError",
        },
        reason: "Checks exact AI SDK, Zod, and owned invalid-input error identities.",
      },
      {
        identity: { module: "atomic-tool-execution.ts", exportName: "isJsonToolOutputValue" },
        reason:
          "Checks complete recursive JSON output representability, including finite numbers and cycles.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "isJsonToolOutputValueInner",
        },
        reason:
          "Performs the recursive JSON output representability check with explicit cycle tracking.",
      },
      {
        identity: { module: "ai-sdk-pi-agent.ts", exportName: "isClonedModelMessage" },
        reason:
          "Checks the closed model-message role capability after the structure-preserving clone.",
      },
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      {
        identity: {
          module: "src/sqlite-transcript-projection.ts",
          exportName: "acceptsMiniLilacPersistedSuperJsonValue",
        },
        reason:
          "Checks only whether a persisted opaque value survives the exact SuperJSON representation round trip.",
      },
      {
        identity: { module: "src/workspace-history-store.ts", exportName: "isMissingExecutable" },
        reason:
          "Checks only the exact Node filesystem ENOENT capability on an opaque process failure.",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    ["isFunctionCapability", "isPluginPanic"].map((exportName) => ({
      identity: { module: "capabilities.ts", exportName },
      reason: "Checks one exact runtime capability without interpreting plugin-owned domain data.",
    })),
  ],
  [
    "apps/core",
    [
      ...CORE_FINAL_CAPABILITY_IDENTITIES.map(([module, exportName]) => ({
        identity: { module, exportName },
        reason:
          "Checks one exact external capability, discriminant, brand, or bounded protocol condition without projecting domain data.",
      })),
      ...["hasGuildIdResolver", "hasReactionDetailsProvider", "hasSessionParticipantsProvider"].map(
        (exportName) => ({
          identity: { module: "src/tool-server/tools/surface.ts", exportName },
          reason: "Checks one exact optional SurfaceAdapter method capability.",
        }),
      ),
      {
        identity: {
          module: "src/tool-server/tools/generate.ts",
          exportName: "writeFileWithUniqueName",
        },
        reason: "Checks the exact Node filesystem EEXIST code before retrying a unique filename.",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "runtime-utils.ts", exportName: "isPanic" },
        reason:
          "Checks exact Panic identity while treating hostile classifier inspection as ordinary opaque failure.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "isRecord" },
        reason: "Checks only the exact plain record capability used by boundary projections.",
      },
      {
        identity: {
          module: "model-message-provider-options.ts",
          exportName: "isOpenAICompactionPart",
        },
        reason: "Delegates to the complete OpenAI compaction-part schema decoder.",
      },
      {
        identity: { module: "subagent-profile.ts", exportName: "isNativeSubagentProfile" },
        reason:
          "Checks the closed native subagent profile literals without projecting richer data.",
      },
    ],
  ],
]);

const INTEGRATED_OPEN_PROTOCOL_ADAPTERS = new Map<string, readonly OpenProtocolAdapter[]>([
  [
    "packages/agent",
    [
      {
        identity: { module: "ai-sdk-pi-agent.ts", exportName: "projectAiSdkTextStreamPart" },
        externalProtocol: { package: "ai", exportName: "TextStreamPart" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "kind", value: "unsupported" },
        reason:
          "Projects generic AI SDK TextStreamPart tool instantiations into a closed agent stream union.",
      },
    ],
  ],
  [
    "apps/acp-controller",
    [
      {
        identity: { module: "session-history.ts", exportName: "projectSessionUpdate" },
        externalProtocol: { package: "@agentclientprotocol/sdk", exportName: "SessionUpdate" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "type", value: "unsupported" },
        reason:
          "Defense-in-depth projection for runtime ACP version skew; the SDK normally validates SessionUpdate before this adapter runs.",
      },
    ],
  ],
  [
    "apps/mini-lilac-tui",
    [
      {
        identity: {
          module: "src/ui-message-chunk-projection.ts",
          exportName: "projectUIMessageChunk",
        },
        externalProtocol: { package: "ai", exportName: "UIMessageChunk" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "kind", value: "unsupported" },
        reason: "Projects the open AI SDK stream protocol into local TUI chunk variants.",
      },
    ],
  ],
]);

const OPEN_PROTOCOL_RULE_ZONES = new Map<string, readonly RuleZone[]>([
  ["packages/agent", [{ include: "ai-sdk-pi-agent.ts" }]],
  ["apps/acp-controller", [{ include: "session-history.ts" }]],
  ["apps/mini-lilac-tui", [{ include: "src/ui-message-chunk-projection.ts" }]],
]);

const CORE_TOOL_SERVER_EXCEPTION_ADAPTERS = [
  ...[
    [
      "src/tool-server/tools/programmatic-workflow.ts",
      "adaptWorkflowJsonProjectionResultToToolHost",
      "programmatic workflow tool projection",
    ],
  ].map(([module, exportName, externalExportName]) => ({
    identity: { module, exportName },
    category: "result-to-framework" as const,
    externalApi: {
      package: "@stanley2058/lilac-plugin-runtime",
      exportName: externalExportName,
    },
    direction: "signal-host" as const,
    reason:
      "Adapts one typed tool boundary Result to the established rejecting tool host contract.",
  })),
  {
    identity: {
      module: "src/tool-server/tools/ssh.ts",
      exportName: "decodeSshProbeOutput",
    },
    category: "external-to-result",
    externalApi: { package: "global", exportName: "JSON.parse" },
    direction: "capture-external",
    reason: "Maps malformed remote probe JSON to an owned SSH probe Result error.",
  },
] as const satisfies readonly ExceptionAdapter[];

export const LEGACY_UNENFORCED_EXCEPTION_ADAPTERS = new Map<string, readonly ExceptionAdapter[]>([
  [
    "apps/acp-controller",
    [
      ["external-adapters.ts", "captureExternal", "ACP SDK or process operation"],
      ["run-store.ts", "parseJson", "JSON.parse"],
    ].flatMap(([module, exportName, externalExportName]) => [
      {
        identity: { module, exportName },
        category: "external-to-result" as const,
        externalApi: { package: "external", exportName: externalExportName },
        direction: "capture-external" as const,
        reason: "Maps one immediate ACP external failure to an owned Result error.",
      },
      {
        identity: { module, exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic identity at the exact ACP exception boundary.",
      },
    ]),
  ],
  [
    "apps/mini-lilac",
    [
      ...[
        ["build.ts", "captureBuildOperation", "build filesystem or Bun operation"],
        ["install-local.ts", "captureInstallOperation", "local install process operation"],
        ["src/main.ts", "captureCommand", "Mini Lilac command runner"],
      ].flatMap(([module, exportName, externalExportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalExportName },
          direction: "capture-external" as const,
          reason: "Maps one immediate CLI, build, or installer failure to an owned Result error.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the exact Mini Lilac operation boundary.",
        },
      ]),
      ...[
        ["build.ts", "signalBuildFailure", "build script"],
        ["install-local.ts", "signalLocalInstallFailure", "local install script"],
      ].map(([module, exportName, externalExportName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/mini-lilac", exportName: externalExportName },
        direction: "signal-host" as const,
        reason: "Adapts an owned CLI Result to the executable host's throwing contract.",
      })),
    ],
  ],
  [
    "apps/mini-lilac-server",
    [
      ...[
        ["src/main.ts", "captureServerOperation", "server operation"],
        ["src/main.ts", "captureServerCleanup", "server cleanup"],
        ["src/main.ts", "captureNodeCliParsing", "node:util.parseArgs"],
        ["src/server.ts", "captureSessionCreation", "session creation"],
        ["src/server.ts", "canonicalDirectory", "node:fs/promises.realpath"],
      ].flatMap(([module, exportName, externalExportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalExportName },
          direction: "capture-external" as const,
          reason:
            "Maps one immediate server, CLI, filesystem, or cleanup failure to an owned Result.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the same Mini Lilac server boundary.",
        },
      ]),
      {
        identity: { module: "src/main.ts", exportName: "settleShutdownEffect" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Settles every shutdown effect while retaining the first observed Panic.",
      },
      ...[
        ["src/main.ts", "adaptLifecycleResultToHost", "server lifecycle"],
        ["src/main.ts", "acquireDatabaseLock", "database lock compatibility API"],
        ["src/main.ts", "shutdownMiniLilacServer", "server shutdown compatibility API"],
        ["src/server.ts", "invalidServerConfiguration", "Elysia server construction"],
      ].map(([module, exportName, externalExportName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/mini-lilac-server", exportName: externalExportName },
        direction: "signal-host" as const,
        reason: "Signals an owned server failure through the established rejecting host contract.",
      })),
      {
        identity: { module: "src/server.ts", exportName: "classifyHttpOperationFailure" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic before classifying ordinary HTTP operation failures.",
      },
      {
        identity: { module: "src/server.ts", exportName: "captureHttpOperation" },
        category: "external-to-result",
        externalApi: { package: "elysia", exportName: "request handler" },
        direction: "capture-external",
        reason: "Maps a request-handler rejection to the local HTTP Result envelope.",
      },
      ...["enqueueSseKeepAlive"].flatMap((exportName) => [
        {
          identity: { module: "src/server.ts", exportName },
          category: "compatibility" as const,
          externalApi: { package: "global", exportName: "ReadableStream controller.enqueue" },
          direction: "capture-external" as const,
          reason: "Contains a closed SSE controller enqueue failure during keep-alive cleanup.",
        },
        {
          identity: { module: "src/server.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic from the SSE controller boundary.",
        },
      ]),
    ],
  ],
  [
    "apps/tool-bridge",
    [
      ...[
        ["readFileText", "node:fs/promises.readFile"],
        ["readFileBytes", "node:fs/promises.readFile"],
        ["decodeJsonText", "JSON.parse"],
        ["fetchRequest", "global fetch"],
        ["readResponseText", "Response.text"],
        ["isFile", "node:fs/promises.stat"],
        ["openPromptInterface", "node:readline.createInterface"],
        ["askPrompt", "node:readline.question"],
        ["closePrompt", "node:readline.close"],
        ["readStdinText", "process.stdin"],
        ["normalizePathCandidate", "node:fs.realpathSync.native"],
      ].flatMap(([exportName, externalExportName]) => [
        {
          identity: { module: "client.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalExportName },
          direction: "capture-external" as const,
          reason:
            "Contains one immediate Tool Bridge filesystem, network, prompt, or JSON failure.",
        },
        {
          identity: { module: "client.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the exact Tool Bridge adapter.",
        },
      ]),
      {
        identity: { module: "client.ts", exportName: "reportMainDefect" },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.then rejection handler" },
        direction: "observe-panic",
        reason: "Routes top-level CLI rejection to the exact bounded process defect reporter.",
      },
    ],
  ],
  [
    "packages/agent",
    [
      {
        identity: { module: "failure-adapters.ts", exportName: "rethrowAgentPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves exact Panic identity at narrow Agent exception boundaries.",
      },
      {
        identity: {
          module: "atomic-tool-execution.ts",
          exportName: "cleanupFailedAtomicToolCall",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-agent", exportName: "AgentEventHandler" },
        direction: "capture-external",
        reason:
          "Maps a terminal tool-event callback failure to AtomicToolTerminalCleanupFailed before cleanup precedence is resolved.",
      },
      ...[
        ["atomic-tool-execution.ts", "consumeAtomicToolResultStream", "async tool result stream"],
        ["openai-server-compaction.ts", "compactWithOpenAIResponsesResult", "AI SDK streamText"],
      ].map(([module, exportName, externalExportName]) => ({
        identity: { module, exportName },
        category: "external-to-result" as const,
        externalApi: { package: "ai", exportName: externalExportName },
        direction: "capture-external" as const,
        reason: "Maps an immediate AI SDK or tool stream failure to an owned Result error.",
      })),
    ],
  ],
  [
    "packages/bash-safety",
    [
      [
        "src/analyze/analyze-command.ts",
        "parseBashCommand.catch",
        "just-bash",
        "parse",
        "Maps parser exceptions to BashCommandParseFailed.",
      ],
      [
        "src/rules-rm.ts",
        "resolveRmPaths.catch",
        "node:fs",
        "realpathSync",
        "Maps path-resolution exceptions to RmPathResolutionFailed.",
      ],
    ].flatMap(([module, exportName, packageName, externalExportName, reason]) => [
      {
        identity: { module, exportName },
        category: "external-to-result" as const,
        externalApi: { package: packageName, exportName: externalExportName },
        direction: "capture-external" as const,
        reason,
      },
      {
        identity: { module, exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic while the immediate Bash Safety adapter maps ordinary failure.",
      },
    ]),
  ],
  [
    "apps/mini-lilac-tui",
    [
      ...[
        ["src/cli.ts", "parseCliOptions", "node:util.parseArgs"],
        ["src/clipboard.ts", "spawnClipboardCommand", "node:child_process.spawn"],
        ["src/clipboard.ts", "openClipboardFile", "node:fs/promises.open"],
        ["src/clipboard.ts", "statClipboardFile", "FileHandle.stat"],
        ["src/clipboard.ts", "readClipboardFile", "FileHandle.read"],
        ["src/clipboard.ts", "closeClipboardFile", "FileHandle.close"],
        ["src/clipboard.ts", "runAppleScript", "node:child_process.execFile"],
        ["src/clipboard.ts", "removeClipboardFile", "node:fs/promises.rm"],
        ["src/preferences.ts", "decodeBindingPreferences", "JSON.parse"],
        ["src/preferences.ts", "bindingPreferencesFileExists", "BunFile.exists"],
        ["src/preferences.ts", "readBindingPreferencesFile", "BunFile.text"],
        ["src/preferences.ts", "createBindingPreferencesDirectory", "node:fs/promises.mkdir"],
        ["src/preferences.ts", "writeBindingPreferencesFile", "Bun.write"],
        ["src/preferences.ts", "renameBindingPreferencesFile", "node:fs/promises.rename"],
        ["src/preferences.ts", "removeTemporaryBindingPreferences", "node:fs/promises.rm"],
        ["src/startup.ts", "verifySessionCwd", "node:fs.realpathSync.native"],
        ["src/terminal-runtime-adapter.ts", "createTerminalRenderer", "createCliRenderer"],
        ["src/terminal-runtime-adapter.ts", "readTerminalPalette", "renderer.getPalette"],
        ["src/terminal-runtime-adapter.ts", "setTerminalBackground", "renderer.setBackgroundColor"],
        ["src/terminal-runtime-adapter.ts", "renderTerminalApp", "@opentui/solid.render"],
        ["src/terminal-runtime-adapter.ts", "destroyTerminalRenderer", "renderer.destroy"],
        ["src/terminal-stream-adapter.ts", "readTerminalStream", "ReadableStream reader.read"],
        ["src/terminal-stream-adapter.ts", "cancelTerminalStream", "ReadableStream.cancel"],
        [
          "src/terminal-stream-adapter.ts",
          "releaseTerminalStreamLock",
          "ReadableStream reader.releaseLock",
        ],
      ].flatMap(([module, exportName, externalExportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalExportName },
          direction: "capture-external" as const,
          reason:
            "Maps one immediate terminal, filesystem, parser, or stream failure to an owned Result.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the exact TUI adapter boundary.",
        },
      ]),
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "runTerminalEntrypoint",
        },
        category: "compatibility",
        externalApi: { package: "@opentui/core", exportName: "terminal process entrypoint" },
        direction: "capture-external",
        reason: "Maps the top-level terminal failure to the process-owned Result contract.",
      },
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "runWithOwnedTerminalRenderer",
        },
        category: "external-to-result",
        externalApi: { package: "@opentui/core", exportName: "OwnedTerminalRenderer.destroy" },
        direction: "capture-external",
        reason:
          "Attempts owned renderer cleanup after work settles and preserves an ordinary cleanup failure as a Result.",
      },
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "requestTerminalRendererShutdown",
        },
        category: "compatibility",
        externalApi: { package: "@opentui/core", exportName: "OwnedTerminalRenderer.destroy" },
        direction: "capture-external",
        reason:
          "Retains a synchronous renderer-shutdown defect in a closed outcome until the owner wait is released.",
      },
      {
        identity: {
          module: "src/terminal-runtime-adapter.ts",
          exportName: "resolveTerminalShutdownOutcome",
        },
        category: "compatibility",
        externalApi: { package: "@opentui/core", exportName: "retained terminal shutdown defect" },
        direction: "signal-host",
        reason:
          "Rethrows only the defect retained while synchronous renderer shutdown released the owner wait.",
      },
      {
        identity: { module: "src/tool-observation-projection.ts", exportName: "parseInput" },
        category: "external-to-result",
        externalApi: { package: "zod", exportName: "ZodType.safeParse" },
        direction: "capture-external",
        reason:
          "Contains hostile schema input access and maps ordinary parser failures to the projection-owned malformed Result while preserving Panic.",
      },
      {
        identity: { module: "src/tool-observation-projection.ts", exportName: "parseInput" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic from hostile schema input access without converting it to an Err.",
      },
      {
        identity: {
          module: "src/tool-observation-projection.ts",
          exportName: "decodeKnownToolObservation",
        },
        category: "external-to-result",
        externalApi: {
          package: "@stanley2058/mini-lilac-tui",
          exportName: "toolObservationCodecRegistry",
        },
        direction: "capture-external",
        reason:
          "Contains one selected tool codec invocation and maps ordinary decoder failures to the projection-owned malformed Result while preserving Panic.",
      },
      {
        identity: {
          module: "src/tool-observation-projection.ts",
          exportName: "decodeKnownToolObservation",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic from a selected tool decoder without converting it to an Err.",
      },
    ],
  ],
  [
    "apps/core",
    [
      ...[
        [
          "src/tool-server/tools/programmatic-workflow.ts",
          "adaptWorkflowInvocationResultToToolHost",
          "programmatic workflow tool host",
        ],
        [
          "src/workflow/workflow-subagent-dispatcher.ts",
          "adaptWorkflowInvocationResultToSubagentHost",
          "subagent delegation host",
        ],
        [
          "src/workflow/durable-workflow-store.ts",
          "adaptWorkflowMigrationResultToStartupHost",
          "core startup",
        ],
        [
          "src/workflow/durable-workflow-store.ts",
          "adaptWorkflowTransactionResultToStoreHost",
          "legacy synchronous workflow store callers",
        ],
        [
          "src/transcript/transcript-store.ts",
          "adaptTranscriptTransactionResultToStoreHost",
          "legacy synchronous transcript transaction callers",
        ],
        [
          "src/transcript/transcript-store.ts",
          "adaptCoreOwnedBlobResultToStoreHost",
          "legacy synchronous transcript blob callers",
        ],
      ].map(([module, exportName, host]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-core", exportName: host },
        direction: "signal-host" as const,
        reason: "Adapts an owned workflow persistence Result only at the existing host contract.",
      })),
      {
        identity: {
          module: "src/workflow/durable-workflow-store.ts",
          exportName: "captureWorkflowRead",
        },
        category: "external-to-result",
        externalApi: { package: "bun:sqlite", exportName: "Database query execution" },
        direction: "capture-external",
        reason:
          "Contains synchronous Bun SQLite read failures, returning only recognized driver failures while preserving codec errors.",
      },
      {
        identity: {
          module: "src/workflow/durable-workflow-store.ts",
          exportName: "captureWorkflowRead",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic identity across durable workflow reads.",
      },
      {
        identity: {
          module: "src/workflow/durable-workflow-store.ts",
          exportName: "signalDurableWorkflowReadErrorToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "workflow runtime and tool host contracts",
        },
        direction: "signal-host",
        reason:
          "Signals an explicitly branched durable read failure only where an existing synchronous or callback host contract cannot return Result.",
      },
      {
        identity: {
          module: "src/workflow/workflow-engine.ts",
          exportName: "WorkflowEngine.runSandbox",
        },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "WorkflowSandboxRun.result",
        },
        direction: "capture-external",
        reason:
          "Maps sandbox rejection to the existing durable run terminalization host contract and preserves shutdown behavior.",
      },
      {
        identity: {
          module: "src/workflow/workflow-engine.ts",
          exportName: "WorkflowEngine.dispatchAgentSafely",
        },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "workflow agent dispatch host",
        },
        direction: "capture-external",
        reason:
          "Maps agent dispatch rejection to the fenced durable operation terminalization contract before rethrowing to the sandbox host.",
      },
      {
        identity: {
          module: "src/transcript/transcript-store.ts",
          exportName: "SqliteTranscriptStore.emitPersistenceDiagnosticsAfterTransaction",
        },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "TranscriptStorePersistenceDiagnostic callback",
        },
        direction: "capture-external",
        reason:
          "Contains an ordinary injected diagnostic observer failure after the SQLite transaction outcome is fixed.",
      },
      {
        identity: {
          module: "src/transcript/transcript-store.ts",
          exportName: "SqliteTranscriptStore.emitPersistenceDiagnosticsAfterTransaction",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves diagnostic observer Panic identity after transaction finalization.",
      },
      {
        identity: {
          module: "src/transcript/transcript-store.ts",
          exportName: "SqliteTranscriptStore.emitDeferredTranscriptEvents",
        },
        category: "compatibility",
        externalApi: { package: "@stanley2058/lilac-utils", exportName: "Logger.info" },
        direction: "capture-external",
        reason:
          "Contains ordinary deferred logging failure only after the SQLite transaction outcome is fixed.",
      },
      {
        identity: {
          module: "src/transcript/transcript-store.ts",
          exportName: "SqliteTranscriptStore.emitDeferredTranscriptEvents",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves deferred logger Panic identity after transaction finalization.",
      },
      {
        identity: {
          module: "src/workflow/workflow-persistence-codec.ts",
          exportName: "decodeJson",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.parse" },
        direction: "capture-external",
        reason: "Maps malformed persisted workflow JSON to an owned persistence Result error.",
      },
      {
        identity: {
          module: "src/workflow/workflow-persistence-codec.ts",
          exportName: "decodeJson",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic identity at the persisted workflow JSON boundary.",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker.ts",
          exportName: "runThreadSummarizationWorkerOperation",
        },
        category: "compatibility",
        externalApi: { package: "bun:sqlite", exportName: "Database.close" },
        direction: "capture-external",
        reason:
          "Closes both isolate stores while projecting ordinary close failures to the worker's best-effort cleanup policy.",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker.ts",
          exportName: "runThreadSummarizationWorkerOperation",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves the original operation Panic across independent cleanup and otherwise propagates the first cleanup Panic unchanged.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "createSummarizationWorkerTransport.onError.<callback>",
        },
        category: "defect-supervisor",
        externalApi: { package: "node", exportName: "Worker.onerror" },
        direction: "observe-panic",
        reason:
          "Normalizes the worker error event to a Panic while preserving an isolate Panic's identity.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "normalizeConversationThreadWorkerPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves genuine worker Panic identity while containing hostile worker error inspection.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "startConversationThreadSummarizationWorker.handleWorkerPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "node", exportName: "Worker.onerror" },
        direction: "observe-panic",
        reason:
          "Terminates the worker and immediately forwards its terminal Panic to the explicit fatal supervisor.",
      },
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "adaptCustomCommandInitializationResultToStartup",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "runtime host startup" },
        direction: "signal-host",
        reason:
          "Signals custom-command initialization failure through the established host startup exception contract.",
      },
      ...[
        [
          "src/heartbeat/heartbeat-service.ts",
          "adaptHeartbeatLifecycleStartResultToHost",
          "startHeartbeatService",
        ],
        [
          "src/heartbeat/heartbeat-service.ts",
          "adaptHeartbeatLifecycleStopResultToHost",
          "HeartbeatService.stop",
        ],
      ].map(([module, exportName, externalExportName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: externalExportName,
        },
        direction: "signal-host" as const,
        reason:
          "Adapts one typed event-delivery lifecycle Result to the existing public rejecting host contract.",
      })),
      {
        identity: {
          module: "src/shared/event-bus-result.ts",
          exportName: "adaptEventPublishResultToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-event-bus",
          exportName: "LilacBus.publish",
        },
        direction: "signal-host",
        reason:
          "Adapts the typed event-publish Result to existing Core callers' rejecting host contracts.",
      },
      ...[
        ["captureCoreRedisConstruction", "Redis constructor"],
        ["captureCoreWorkspacePreparation", "workspace mkdir/realpath"],
        ["captureCoreRedisConnection", "Redis.ping"],
        ["captureCoreRawBusConstruction", "createRedisStreamsBus"],
        ["captureCoreLilacBusConstruction", "RedisEventDeadLetter/createLilacBus"],
        ["captureCoreEventBusCleanup", "owned event-bus close"],
      ].flatMap(([exportName, externalExportName]) => [
        {
          identity: { module: "src/runtime/create-core-runtime.ts", exportName },
          category: "external-to-result" as const,
          externalApi: {
            package: "@stanley2058/lilac-core",
            exportName: externalExportName,
          },
          direction: "capture-external" as const,
          reason: "Captures one owned core event-bus setup or cleanup effect as a typed Result.",
        },
        {
          identity: { module: "src/runtime/create-core-runtime.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the same owned external-effect boundary.",
        },
      ]),
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "setupCoreEventBusResources",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves the original event-bus setup Panic while supervising owned Redis cleanup to completion.",
      },
      ...[
        ["adaptCoreEventBusSetupResultToStartup", "runtime host startup"],
        ["adaptCoreEventBusCleanupResultToHost", "runtime host cleanup"],
      ].map(([exportName, externalExportName]) => ({
        identity: { module: "src/runtime/create-core-runtime.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-core", exportName: externalExportName },
        direction: "signal-host" as const,
        reason:
          "Adapts an owned event-bus Result to the exact core runtime startup or cleanup exception contract.",
      })),
      ...["createCoreRuntime.start", "createCoreRuntimeCleanupSupervisor.run"].map(
        (exportName) => ({
          identity: { module: "src/runtime/create-core-runtime.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason:
            "Preserves startup Panic precedence while supervising every runtime cleanup operation.",
        }),
      ),
      ...[
        "createCoreRuntimeCleanupSupervisor.record",
        "stopCoreResidualDiscordRequestRouter",
        "superviseCoreResidualDiscordRequestRouterDone",
      ].map((exportName) => ({
        identity: { module: "src/runtime/create-core-runtime.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason:
          "Preserves every residual router cleanup Panic by exact identity while Core retains cleanup ownership.",
      })),
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "createCoreRuntime.start.captureSummarizationRuntimeOperation",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "summarization runner" },
        direction: "capture-external",
        reason: "Maps in-process summarization rejection to the runtime-owned Result error.",
      },
      ...["importCustomCommandModule", "invokeCustomCommand", "settleCustomCommand"].flatMap(
        (exportName) => [
          {
            identity: { module: "src/custom-commands/manager.ts", exportName },
            category: "external-to-result" as const,
            externalApi: { package: "plugin", exportName: "custom command" },
            direction: "capture-external" as const,
            reason:
              "Maps immediate custom-command import or execution failure to an owned Result error.",
          },
          {
            identity: { module: "src/custom-commands/manager.ts", exportName },
            category: "defect-supervisor" as const,
            externalApi: { package: "better-result", exportName: "Panic.is" },
            direction: "observe-panic" as const,
            reason: "Preserves Panic while ordinary custom-command failure is captured.",
          },
        ],
      ),
      ...["failPluginOperation", "failPluginInvariant"].map((exportName) => ({
        identity: {
          module: "src/plugins/manager.ts",
          exportName: `createCoreToolPluginManager.${exportName}`,
        },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-core", exportName: "buildLevel1Toolset" },
        direction: "signal-host" as const,
        reason: "Signals plugin failure through the existing rejected Core toolset host contract.",
      })),
      ...[
        "adaptToolAuthenticationResultToElysia",
        "adaptToolRequestHeadersResultToElysia",
        "adaptToolPayloadResultToElysia",
        "adaptSafetyModeResultToElysia",
        "adaptToolRouteResultToElysia",
        "adaptPluginListResultToElysia",
      ].map((exportName) => ({
        identity: { module: "src/tool-server/create-tool-server.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "elysia", exportName: "route handler" },
        direction: "signal-host" as const,
        reason: "Maps one exact typed Result failure to Elysia's route exception contract.",
      })),
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "adaptToolServerOptionsResultToHost",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "createToolServer" },
        direction: "signal-host",
        reason: "Maps invalid startup options to the existing createToolServer exception contract.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "adaptPluginLifecycleResultToHost",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "tool server lifecycle" },
        direction: "signal-host",
        reason:
          "Maps plugin lifecycle Result failures to the existing tool-server route/startup host contract.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.captureAuthenticationOperation.catch",
        },
        category: "external-to-result",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "requestMessageCache/authorizeControlRequest",
        },
        direction: "capture-external",
        reason:
          "Maps an immediate request-cache or authorization callback failure to an owned authentication error.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "createToolServer.captureSafetyModeProvider.catch",
        },
        category: "external-to-result",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "resolveServerSafetyMode/getConfig",
        },
        direction: "capture-external",
        reason: "Maps a safety provider rejection to an owned safety-mode resolution error.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "isToolInputValidationCause",
        },
        category: "compatibility",
        externalApi: { package: "global", exportName: "instanceof" },
        direction: "capture-external",
        reason:
          "Contains hostile external prototype inspection while retaining the validation compatibility response.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "frameworkErrorLogProjection",
        },
        category: "compatibility",
        externalApi: { package: "better-result", exportName: "TaggedError.is" },
        direction: "capture-external",
        reason:
          "Projects hostile framework errors into a bounded plain logging record without leaking the original value.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "observeToolCallRejection",
        },
        category: "defect-supervisor",
        externalApi: {
          package: "@stanley2058/lilac-plugin-runtime",
          exportName: "isPluginPanic",
        },
        direction: "observe-panic",
        reason:
          "Forwards immediate plugin Panics and every projected post-timeout rejection to fatal supervision.",
      },
      {
        identity: {
          module: "src/tool-server/tools/conversation-thread.ts",
          exportName: "resolveConversationThreadSummarizationToolOperation",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-plugin-runtime",
          exportName: "ServerTool.call",
        },
        direction: "signal-host",
        reason: "Maps a summarization Result error to the existing ServerTool rejection contract.",
      },
      {
        identity: {
          module: "src/tool-server/tools/conversation-thread.ts",
          exportName: "ConversationThread.call",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-plugin-runtime",
          exportName: "ServerTool.call",
        },
        direction: "signal-host",
        reason:
          "Maps a typed invalid callable Result to the existing ServerTool rejection contract at the exact host boundary.",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker.ts",
          exportName: "runJob",
        },
        category: "compatibility",
        externalApi: { package: "node", exportName: "Worker.message" },
        direction: "capture-external",
        reason:
          "Maps worker job failure to the existing response envelope at the isolate boundary.",
      },
      {
        identity: {
          module: "src/conversation/thread-summarization-worker.ts",
          exportName: "runJob",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while the worker boundary maps ordinary job failures.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "startConversationThreadSummarizationWorker.postRequest",
        },
        category: "external-to-result",
        externalApi: { package: "node", exportName: "Worker.postMessage" },
        direction: "capture-external",
        reason: "Maps synchronous worker postMessage failure to a transport Result.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "startConversationThreadSummarizationWorker.postRequest",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while the worker client maps ordinary postMessage failure.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "startConversationThreadWorker.tick",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Periodic worker supervisor records ordinary failure and immediately reports Panic.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "startConversationThreadWorker.stop",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic",
        reason: "Re-propagates a previously observed terminal Panic when the supervisor stops.",
      },
      {
        identity: {
          module: "src/conversation/thread-worker.ts",
          exportName: "rethrowConversationThreadWorkerPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Narrow helper preserves worker Panic identity without exempting worker orchestration.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "rethrowBusAgentRunnerPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Narrow helper preserves agent-runner Panic identity without exempting bus orchestration.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "captureBusAgentRunnerOperation",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "Promise" },
        direction: "capture-external",
        reason:
          "Captures one named runner dependency operation into an owned Result at its immediate rejection boundary.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "captureBusAgentRunnerOperation",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves exact Panic identity while capturing ordinary runner operation failure.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "signalBusAgentRunnerHostFailure",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-agent", exportName: "agent callback" },
        direction: "signal-host",
        reason:
          "Signals a typed runner failure through an exact agent or provider callback rejection contract.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "projectBusAgentRunnerError",
        },
        category: "compatibility",
        externalApi: { package: "global", exportName: "opaque exception" },
        direction: "capture-external",
        reason: "Projects an opaque dependency exception into bounded safe runner logging fields.",
      },
      ...[
        [
          "startBusAgentRunner.drainSessionQueue.reportOutputPublisherError",
          "createAgentOutputPublisher.onError",
        ],
        [
          "startBusAgentRunner.drainSessionQueue.reportAgentActivityError",
          "createAgentOutputActivityPublisher.onError",
        ],
      ].map(([exportName, externalExportName]) => ({
        identity: { module: "src/surface/bridge/bus-agent-runner.ts", exportName: exportName! },
        category: "compatibility" as const,
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: externalExportName!,
        },
        direction: "capture-external" as const,
        reason:
          "Normalizes one exact opaque runner callback failure immediately into a safe logging projection.",
      })),
      ...[
        "captureRouterRouting",
        "startDiscordRequestRouter.reloadCoreConfigIfNeeded",
        "startDiscordRequestRouter.evaluateAdapterSuppression",
        "startDiscordRequestRouter.evaluateDirectReplyRouterGate",
      ].flatMap((exportName) => [
        {
          identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
          category: (exportName.startsWith("captureRouter")
            ? "external-to-result"
            : "compatibility") as "external-to-result" | "compatibility",
          externalApi: {
            package: "@stanley2058/lilac-core",
            exportName: "request router dependency",
          },
          direction: "capture-external" as const,
          reason:
            "Captures an immediate router dependency rejection using its established typed Result or fail-open policy.",
        },
        {
          identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic while handling an immediate request-router dependency boundary.",
        },
      ]),
      ...[
        {
          category: "compatibility" as const,
          externalApi: { package: "global", exportName: "Object.getOwnPropertyDescriptor" },
          direction: "capture-external" as const,
          reason:
            "Contains ordinary reflection failures while projecting untrusted Discord routing flags.",
        },
        {
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the Discord raw projection boundary.",
        },
      ].map(({ category, externalApi, direction, reason }) => ({
        identity: {
          module: "src/surface/discord/discord-request-router/common.ts",
          exportName: "getDiscordFlags",
        },
        category,
        externalApi,
        direction,
        reason,
      })),
      ...[
        {
          exportName: "captureRouterActiveBatchGate",
          externalApi: {
            package: "@stanley2058/lilac-core",
            exportName: "RouterGate",
          },
          reason: "Maps active-batch gate rejection to the router's typed fail-closed policy.",
        },
        {
          exportName: "captureRouterDebounceFlush",
          externalApi: {
            package: "global",
            exportName: "setTimeout callback Promise",
          },
          reason:
            "Supervises the detached debounce callback, mapping ordinary rejection to a typed Result while reporting Panic through router.done.",
        },
      ].flatMap(({ exportName, externalApi, reason }) => [
        {
          identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
          category: "external-to-result" as const,
          externalApi,
          direction: "capture-external" as const,
          reason,
        },
        {
          identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the exact gate or detached timer boundary.",
        },
      ]),
      ...["adaptDiscordRequestRouterStartOutcomeToHost", "adaptRouterSubscriptionsStop"].map(
        (exportName) => ({
          identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
          category: "result-to-framework" as const,
          externalApi: {
            package: "@stanley2058/lilac-core",
            exportName: "request router lifecycle",
          },
          direction: "signal-host" as const,
          reason:
            "Adapts the event-delivery lifecycle Result at the existing request-router host boundary.",
        }),
      ),
      ...[
        "adaptRouterSubscriptionStart",
        "finishRouterSubscriptionStartFailure",
        "stopRouterSubscriptionsAllSettled",
      ].map((exportName) => ({
        identity: { module: "src/surface/discord/discord-request-router.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason:
          "Preserves exact startup or rollback Panic identity while retaining residual router ownership.",
      })),
      {
        identity: {
          module: "src/surface/discord/discord-request-router.ts",
          exportName: "adaptRouterSelfLookup",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "SurfaceAdapter.getSelf" },
        direction: "capture-external",
        reason: "Captures adapter self-lookup rejection into the Discord router startup Result.",
      },
      {
        identity: {
          module: "src/surface/discord/discord-request-router.ts",
          exportName: "adaptRouterSelfLookup",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves exact Panic identity while adapting Discord router self lookup.",
      },
      {
        identity: {
          module: "src/surface/discord/discord-request-router.ts",
          exportName: "signalDiscordRequestRouterPlatformMismatch",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "signal-host",
        reason:
          "Signals a hard startup invariant when the Discord router receives another platform's adapter.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "captureBusToAdapterEffect",
        },
        category: "external-to-result",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "surface adapter and relay effect",
        },
        direction: "capture-external",
        reason:
          "Captures an immediate surface, relay, transcript, or event-publication rejection as the bridge-owned effect Result.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "rethrowBusToAdapterPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves exact Panic identity while the bus-to-adapter effect boundary captures ordinary failures.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "superviseBusToAdapterCleanup",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Runs every required relay cleanup and rethrows the original Panic ahead of ordinary cleanup defects.",
      },
      ...["adaptBusToAdapterSubscriptionStart", "adaptBusToAdapterSubscriptionStop"].map(
        (exportName) => ({
          identity: { module: "src/surface/bridge/subscribe-from-bus.ts", exportName },
          category: "result-to-framework" as const,
          externalApi: {
            package: "@stanley2058/lilac-event-bus",
            exportName: "subscription lifecycle",
          },
          direction: "signal-host" as const,
          reason:
            "Adapts the typed event-delivery lifecycle Result to the bridge's existing startup or shutdown host rejection contract.",
        }),
      ),
      {
        identity: {
          module: "src/runtime/surface-runtime-lifecycle.ts",
          exportName: "signalSurfaceRecoveryRollbackAtomicityUnknown",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "signal-host",
        reason:
          "Escalates an incomplete paused-recovery rollback to the runtime host because recovery atomicity is unknown.",
      },
      {
        identity: {
          module: "src/runtime/graceful-restart-store.ts",
          exportName: "signalMissingGracefulRestartDispositionToken",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "signal-host",
        reason:
          "Signals the impossible invariant that a decoded persisted row reached disposition classification without its immutable token.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "bridgeBusToAdapter.startRelay",
        },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "surface relay startup effects",
        },
        direction: "capture-external",
        reason:
          "Captures relay startup rejection at the smallest boundary so every partially created output, subscription, and typing resource is cleaned before propagation.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "bridgeBusToAdapter.startRelay",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "surface relay startup host",
        },
        direction: "signal-host",
        reason:
          "Propagates the original startup rejection after complete cleanup, or the owned Panic when cleanup leaves atomicity unknown.",
      },
      {
        identity: {
          module: "src/surface/bridge/subscribe-from-bus.ts",
          exportName: "signalSurfaceRelayRecoveryAtomicityUnknown",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "signal-host",
        reason:
          "Signals that reverse exhaustive relay recovery cleanup failed and left atomicity unknown.",
      },
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "normalizeRouterDoneDefect",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves exact Panic identity while normalizing a non-Error router done rejection for fatal reporting.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.startSessionQueueDrain.superviseDetachedDrain",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.catch" },
        direction: "observe-panic",
        reason:
          "Supervises the detached session drain, preserving and explicitly reporting Panic while logging ordinary rejection.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.superviseAgentRunnerBackgroundFailure",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.catch" },
        direction: "observe-panic",
        reason:
          "Observes detached subscription and activation completion at the runner host boundary and reports rejected Panic without converting it to delivery error data.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.handleCmdRequestMessage",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-event-bus", exportName: "event handler" },
        direction: "capture-external",
        reason:
          "Captures ordinary request intake and lifecycle failures as the runner-owned delivery error union.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.handleCmdRequestMessage",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves exact Panic identity while ordinary request intake failure becomes an Err.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-event-bus",
          exportName: "subscription start/done",
        },
        direction: "signal-host",
        reason:
          "Maps typed subscription start and completion failures to the existing runner startup/background host contract.",
      },
      {
        identity: {
          module: "src/ssh/remote-js/bundled-runner-failure.ts",
          exportName: "rethrowBundledRemoteRunnerPanic",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic identity at the bundled remote-runner compatibility boundary.",
      },
      {
        identity: {
          module: "src/ssh/remote-js/remote-runner-entry.ts",
          exportName: "main",
        },
        category: "compatibility",
        externalApi: { package: "node", exportName: "bundled runner process" },
        direction: "capture-external",
        reason: "Maps ordinary bundled runner failures to the established wire error envelope.",
      },
      {
        identity: {
          module: "src/ssh/remote-js/bundled-runner-failure.ts",
          exportName: "bundledRemoteRunnerErrorMessage",
        },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error.message/String" },
        direction: "capture-external",
        reason:
          "Contains hostile prototype, message, and coercion traps before projecting the bundled runner wire failure.",
      },
      {
        identity: { module: "src/ssh/ssh-exec.ts", exportName: "rethrowSshPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Narrow helper preserves Panic identity across immediate SSH adapters.",
      },
      ...[
        ["acquireStreamReader.catch", "ReadableStream.getReader"],
        ["readStreamChunk.catch", "ReadableStreamDefaultReader.read"],
        ["releaseStreamReader.catch", "ReadableStreamDefaultReader.releaseLock"],
        ["reportStreamActivity.catch", "activity callback"],
        ["readResponseBody.catch", "Response.arrayBuffer"],
        ["openOverflowSink.catch", "BufferedFileSink.open"],
        ["writeOverflowSink.catch", "BufferedFileSink.write"],
        ["closeOverflowSink.catch", "BufferedFileSink.close"],
        ["abortOverflowSink.catch", "BufferedFileSink.abort"],
        ["removeOverflowFile.catch", "fs.rm"],
        ["signalSshProcess.catch", "process.kill"],
        ["waitForSshExit.catch", "Subprocess.exited"],
      ].map(([exportName, externalExport]) => ({
        identity: { module: "src/ssh/ssh-exec.ts", exportName: exportName! },
        category: "external-to-result" as const,
        externalApi: { package: "node/bun", exportName: externalExport! },
        direction: "capture-external" as const,
        reason:
          "Maps one immediate SSH stream, overflow, process, or callback failure to an owned Result error.",
      })),
      {
        identity: {
          module: "src/ssh/ssh-exec.ts",
          exportName: "serializeRemoteRunnerRequestJson",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.stringify" },
        direction: "capture-external",
        reason: "Maps remote runner request serialization failure to an owned SSH error.",
      },
      {
        identity: { module: "src/ssh/ssh-exec.ts", exportName: "sshExecScriptJson.catch" },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "sshExecBash" },
        direction: "capture-external",
        reason: "Maps SSH execution rejection and exact owned-signal cancellation to typed errors.",
      },
      {
        identity: { module: "src/ssh/remote-js.ts", exportName: "getRemoteRunnerJsText.catch" },
        category: "external-to-result",
        externalApi: { package: "bun", exportName: "Bun.file.text" },
        direction: "capture-external",
        reason: "Maps bundled remote runner filesystem rejection to an owned source-read error.",
      },
      {
        identity: {
          module: "src/tools/fs/remote-fs.ts",
          exportName: "sshExecRemoteFsRunnerJson.catch",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-core", exportName: "sshExecBash" },
        direction: "capture-external",
        reason: "Maps remote filesystem runner transport rejection to an owned SSH error.",
      },
      {
        identity: {
          module: "src/tools/fs/remote-fs.ts",
          exportName: "decodeRemoteFsRunnerPackageSpec",
        },
        category: "external-to-result",
        externalApi: { package: "node:module", exportName: "require" },
        direction: "capture-external",
        reason: "Maps remote filesystem runner package loading failure to an owned setup error.",
      },
      ...[
        ["src/ssh/remote-js.ts", "getRemoteRunnerJsText.catch"],
        ["src/ssh/ssh-exec.ts", "serializeRemoteRunnerRequestJson"],
        ["src/ssh/ssh-exec.ts", "sshExecScriptJson.catch"],
        ["src/tools/fs/remote-fs.ts", "decodeRemoteFsRunnerPackageSpec"],
        ["src/tools/fs/remote-fs.ts", "sshExecRemoteFsRunnerJson.catch"],
      ].map(([module, exportName]) => ({
        identity: { module: module!, exportName: exportName! },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic while the immediate SSH adapter maps ordinary rejection.",
      })),
    ],
  ],
  [
    "packages/fs",
    [
      ...[
        ["src/fs-impl.ts", "compileEditRegex", "global", "RegExp"],
        ["src/ripgrep.ts", "decodeRipgrepMatchLine", "global", "JSON.parse"],
        ["src/ripgrep.ts", "ripgrep", "node:child_process", "spawn"],
        ["src/search-backend.ts", "captureFffOperation", "@ff-labs/fff-node", "async operation"],
        ["src/search-backend.ts", "captureFffSyncOperation", "@ff-labs/fff-node", "sync operation"],
      ].flatMap(([module, exportName, packageName, externalExportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: packageName, exportName: externalExportName },
          direction: "capture-external" as const,
          reason:
            "Maps the immediate filesystem, parser, process, or FFF exception to an owned Result error.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic while the immediate FS adapter maps ordinary external failure.",
        },
      ]),
      ...[
        ["captureFilesystemOperation", "node:fs/promises"],
        ["captureFilesystemOperationSync", "node:fs"],
      ].map(([exportName, packageName]) => ({
        identity: { module: "src/filesystem-operation.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: packageName, exportName: "filesystem operation" },
        direction: "capture-external" as const,
        reason: "Maps an immediate filesystem exception to an owned Result error.",
      })),
      {
        identity: { module: "src/filesystem-operation.ts", exportName: "decodeFilesystemFailure" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Projects exact Panic identity before classifying ordinary filesystem failures.",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeJson",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.parse" },
        direction: "capture-external",
        reason: "Maps malformed remote runner JSON to the protocol-owned decode error.",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeJson",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while malformed remote runner JSON is captured.",
      },
    ],
  ],
  [
    "packages/plugin-runtime",
    [
      ...[
        "decodeDynamicToolPluginModule",
        "decodeToolPlugin",
        "decodeToolPluginInstance",
        "decodeLevel1ToolSpec",
        "decodeServerTool",
        "decodeVoidHookResult",
        "decodeBooleanHookResult",
        "decodeStringHookResult",
        "decodeStringArrayHookResult",
        "decodeServerToolListResult",
        "decodeLevel1ToolFailureSummary",
        "decodeLevel1ExecutableMetadata",
        "decodeDisabledPluginIds",
        "decodeLevel1RegistrationKey",
        "mapHookResultInspectionException",
      ].map((exportName) => ({
        identity: { module: "capabilities.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic while inspecting a plugin capability or hook result.",
      })),
      {
        identity: { module: "discovery.ts", exportName: "captureFileOperation" },
        category: "external-to-result",
        externalApi: { package: "node:fs/promises", exportName: "filesystem operation" },
        direction: "capture-external",
        reason: "Maps the immediate plugin discovery filesystem rejection to an owned error.",
      },
      {
        identity: { module: "discovery.ts", exportName: "captureFileOperation" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while plugin discovery maps ordinary filesystem rejection.",
      },
      {
        identity: { module: "discovery.ts", exportName: "decodePluginPackageJsonText" },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.parse" },
        direction: "capture-external",
        reason: "Maps malformed plugin package JSON to the decoder's compatibility error.",
      },
      {
        identity: { module: "discovery.ts", exportName: "decodePluginPackageJsonText" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while plugin package JSON parsing is captured.",
      },
      ...["captureSyncHook", "captureAsyncHook"].map((exportName) => ({
        identity: { module: "hooks.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "plugin", exportName: "hook invocation" },
        direction: "capture-external" as const,
        reason: "Maps immediate third-party plugin hook failure to an owned invocation error.",
      })),
      ...["captureSyncHook", "captureAsyncHook"].map((exportName) => ({
        identity: { module: "hooks.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves genuine Panic identity while mapping ordinary plugin hook failure.",
      })),
      {
        identity: { module: "hooks.ts", exportName: "mapPluginHookException" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while normalizing ordinary plugin hook exceptions.",
      },
      {
        identity: { module: "loader.ts", exportName: "loadToolPluginModuleCapability" },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "import" },
        direction: "capture-external",
        reason: "Maps plugin snapshot and dynamic-import rejection to an owned module-load error.",
      },
      {
        identity: { module: "loader.ts", exportName: "loadToolPluginModuleCapability" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while plugin loading maps ordinary external rejection.",
      },
      {
        identity: { module: "manager.ts", exportName: "captureManagerHook" },
        category: "external-to-result",
        externalApi: { package: "plugin", exportName: "manager hook" },
        direction: "capture-external",
        reason: "Maps an immediate host-supplied plugin manager hook failure to an owned error.",
      },
      {
        identity: { module: "manager.ts", exportName: "captureManagerHook" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves genuine Panic identity while mapping ordinary manager hook failure.",
      },
      {
        identity: { module: "manager.ts", exportName: "mapPluginManagerHookException" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while normalizing ordinary plugin manager hook exceptions.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "opaquePluginExceptionMessage" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error.message/String" },
        direction: "capture-external",
        reason:
          "Contains hostile exception getters and coercion while producing bounded compatibility text.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "isPluginPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Recognizes genuine Panic while containing hostile proxy classification traps as ordinary external failure.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "safePluginExceptionCause" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error.name" },
        direction: "capture-external",
        reason:
          "Copies only bounded safe exception text and name while containing hostile prototype and property traps.",
      },
      {
        identity: { module: "discovery.ts", exportName: "decodePluginFilesystemErrorCode" },
        category: "compatibility",
        externalApi: { package: "node:fs", exportName: "Error.code" },
        direction: "capture-external",
        reason: "Contains hostile filesystem error-code getters while projecting ENOENT state.",
      },
    ],
  ],
  [
    "packages/remote-fs-runner",
    [
      ...["readStdinText"].map((exportName) => ({
        identity: { module: "src/cli.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "node", exportName },
        direction: "capture-external" as const,
        reason: "Maps the immediate remote filesystem process or socket failure to an owned error.",
      })),
      ...["readStdinText"].map((exportName) => ({
        identity: { module: "src/cli.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic while the immediate process or socket adapter maps rejection.",
      })),
      ...["spawnDaemon", "releaseStartupLock"].map((exportName) => ({
        identity: { module: "src/cli.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "node", exportName },
        direction: "capture-external" as const,
        reason:
          "Maps the immediate daemon process or startup-lock exception to an owned Result error.",
      })),
      {
        identity: { module: "src/cli.ts", exportName: "preservePanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Narrow helper preserves remote-runner Panic identity across immediate adapters.",
      },
      ...[
        "captureStartupLockOperation",
        "reportCleanupFailureWithoutMaskingOperation",
        "superviseStartupLockCleanupAfterOperationDefect",
        "runWithStartupLockCleanup",
      ].map((exportName) => ({
        identity: { module: "src/cli.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic" as const,
        reason:
          "Preserves the original operation defect while supervising startup-lock cleanup and reporting.",
      })),
      {
        identity: {
          module: "src/cli.ts",
          exportName: "captureRuntimeOperation",
        },
        category: "external-to-result",
        externalApi: { package: "node:fs/promises", exportName: "filesystem operation" },
        direction: "capture-external",
        reason: "Maps remote filesystem runtime setup rejection to an owned setup error.",
      },
      {
        identity: {
          module: "src/cli.ts",
          exportName: "captureRuntimeOperation",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while runtime setup maps ordinary filesystem rejection.",
      },
      {
        identity: {
          module: "src/cli.ts",
          exportName: "executeDaemonRequest",
        },
        category: "external-to-result",
        externalApi: { package: "@stanley2058/lilac-fs", exportName: "FileSystem" },
        direction: "capture-external",
        reason:
          "Maps daemon request execution rejection before writing the compatibility envelope.",
      },
      {
        identity: { module: "src/cli.ts", exportName: "startMain" },
        category: "compatibility",
        externalApi: { package: "node", exportName: "CLI process" },
        direction: "capture-external",
        reason: "Maps an unexpected top-level CLI rejection to the established response envelope.",
      },
      {
        identity: { module: "src/cli.ts", exportName: "reportMainFailure" },
        category: "compatibility",
        externalApi: { package: "node", exportName: "CLI process" },
        direction: "capture-external",
        reason: "Formats the top-level CLI rejection into the established response envelope.",
      },
      {
        identity: { module: "src/cli.ts", exportName: "opaqueErrorMessage" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error.message/String" },
        direction: "capture-external",
        reason:
          "Contains hostile prototype, message, and coercion traps before projecting the remote runner wire failure.",
      },
      {
        identity: { module: "src/cli.ts", exportName: "opaqueErrorCause" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error instanceof" },
        direction: "capture-external",
        reason:
          "Contains hostile prototype traps before carrying an exception into a remote runner owned error.",
      },
    ],
  ],
  [
    "packages/coding-tools",
    [
      ...["persistBashArtifact", "executeLocalBash"].map((exportName) => ({
        identity: { module: "src/bash.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason:
          "Preserves Panic identity while applying Bash artifact-retention policy and cleanup.",
      })),
      {
        identity: { module: "src/bash.ts", exportName: "persistBashArtifact" },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-tool-results",
          exportName: "ToolResultArtifactStore.createFromStream",
        },
        direction: "capture-external",
        reason:
          "Maps a non-Panic rejected artifact adapter to the established Bash retention-failure outcome.",
      },
      ...[
        ["src/bash.ts", "ignoreBashFailure"],
        ["src/bash.ts", "createBashSpool.activate"],
        ["src/bash.ts", "createBashSpool.write"],
        ["src/bash.ts", "createBashSpool.close"],
        ["src/bash.ts", "killProcessGroup"],
        ["src/buffered-file-sink.ts", "continueBufferedSinkQueue"],
        ["src/batch.ts", "captureBatchBoundaryFailure"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic while applying the exact local cleanup or boundary policy.",
      })),
      ...[
        ["src/apply-patch.ts", "parsePatch", "legacy patch parser"],
        ["src/apply-patch.ts", "applyPatch", "legacy patch application"],
        ["src/bash.ts", "normalizedNonnegativeInteger", "Bash option validation"],
        ["src/bash.ts", "streamLocalBash", "AI SDK async tool stream"],
        ["src/batch.ts", "collectApplyPatchTouchedPaths", "legacy batch preflight"],
        ["src/batch.ts", "collectEditFileTouchedPaths", "legacy batch preflight"],
        ["src/batch.ts", "createBatchToolResult.execute", "AI SDK tool execution"],
        ["src/batch.ts", "createBatchTool", "legacy batch tool construction"],
        ["src/guardrails.ts", "assertGuardrailBypassAllowed", "legacy guardrail assertion"],
        ["src/guardrails.ts", "assertLocalCwd", "legacy cwd assertion"],
        ["src/guardrails.ts", "canonicalizeAsFarAsExists", "legacy canonicalization"],
        ["src/guardrails.ts", "assertCanonicalPathAllowed", "legacy path guardrail"],
        ["src/index.ts", "createCodingToolset", "legacy coding toolset construction"],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-coding-tools", exportName: externalName },
        direction: "signal-host" as const,
        reason: "Adapts an owned Result or invariant failure to the established host contract.",
      })),
      ...["BufferedFileSink.write", "BufferedFileSink.open"].map((exportName) => ({
        identity: { module: "src/buffered-file-sink.ts", exportName },
        category: "compatibility" as const,
        externalApi: { package: "@stanley2058/lilac-coding-tools", exportName: "BufferedFileSink" },
        direction: "signal-host" as const,
        reason: "Signals invalid sink use through the established asynchronous sink contract.",
      })),
    ],
  ],
  [
    "packages/claude-code-bridge",
    [
      ...[
        ["claude-attempt-runtime-owner.ts", "captureCandidateFactory", "candidate factory"],
        ["claude-attempt-runtime-owner.ts", "disposeRun", "candidate cleanup"],
        ["claude-code-run.ts", "captureExternalOperation", "Claude SDK operation"],
        ["claude-code-run.ts", "captureExternalOperationSync", "Claude SDK operation"],
        ["claude-code-tools.ts", "stringifyJson", "JSON.stringify"],
        ["claude-code-tools.ts", "createClaudeCodeToolBridgeResult", "MCP bridge setup"],
        ["claude-code-tools.ts", "createClaudeCodeToolBridgeResult.closeResult", "MCP close"],
      ].flatMap(([module, exportName, externalName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalName },
          direction: "capture-external" as const,
          reason: "Maps the immediate external Claude or MCP failure to an owned Result outcome.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the immediate Claude or MCP boundary.",
        },
      ]),
      {
        identity: { module: "claude-code-run.ts", exportName: "materializeClaudeCodeRunResult" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while combining materialization and cleanup Results.",
      },
      ...[
        "settleQueryAndProcess",
        "materializeClaudeCodeRunResult.waitForObservability",
        "materializeClaudeCodeRunResult.drainQueryControllers",
        "materializeClaudeCodeRunResult.clearResult.attempt",
        "materializeClaudeCodeRunResult.clearResult",
        "materializeClaudeCodeRunResult.disposeResult",
        "materializeClaudeCodeRunResult.finalizeResult",
      ].map((exportName) => ({
        identity: { module: "claude-code-run.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason:
          "Preserves the first Claude observability or cleanup Panic until all owned settlement work completes.",
      })),
      ...[
        [
          "claude-attempt-runtime-owner.ts",
          "ClaudeAttemptRuntimeOwner.getNativeInputEstimateFloor",
          "legacy input estimate",
        ],
        [
          "claude-attempt-runtime-owner.ts",
          "ClaudeAttemptRuntimeOwner.recordSuccessfulModelCall",
          "legacy model-call completion",
        ],
        [
          "claude-attempt-runtime-owner.ts",
          "ClaudeAttemptRuntimeOwner.retireForRetry",
          "legacy retry retirement",
        ],
        [
          "claude-attempt-runtime-owner.ts",
          "ClaudeAttemptRuntimeOwner.retireForCanonicalReplacement",
          "legacy replacement retirement",
        ],
        [
          "claude-attempt-runtime-owner.ts",
          "ClaudeAttemptRuntimeOwner.adaptRunEndRetirementToHost",
          "legacy run-end retirement",
        ],
        [
          "claude-code-run.ts",
          "materializeClaudeCodeRunResult.spawnTrackedProcess",
          "Claude process host",
        ],
        ["claude-code-run.ts", "materializeClaudeCodeRunResult.clear", "Claude run control"],
        [
          "claude-code-run.ts",
          "materializeClaudeCodeRunResult.createUtilityModel",
          "legacy utility model construction",
        ],
        [
          "claude-code-run.ts",
          "materializeClaudeCodeRunResult.finalizeToHost",
          "Claude native session lifecycle",
        ],
        ["claude-code-run.ts", "materializeClaudeCodeRun", "legacy Claude materialization"],
        ["claude-code-tools.ts", "validateClaudeCodeBuiltInTools", "legacy built-in validation"],
        ["claude-code-tools.ts", "mapToolResultOutputToMcp", "legacy MCP output mapping"],
        [
          "claude-code-tools.ts",
          "createClaudeCodeToolBridgeResult.close",
          "legacy MCP bridge cleanup",
        ],
        ["claude-code-tools.ts", "createClaudeCodeToolBridge", "legacy MCP bridge construction"],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-claude-code-bridge", exportName: externalName },
        direction: "signal-host" as const,
        reason:
          "Adapts an owned Claude Result to the established framework or compatibility contract.",
      })),
    ],
  ],
  [
    "packages/event-bus",
    [
      ...[
        "createLilacBus.bus.publish",
        "createLilacBus.bus.getTopicWatermark",
        "createLilacBus.bus.trimTopicBeforeCheckpoint",
        "createLilacBus.bus.retireTopicConsumerGroup",
        "createLilacBus.bus.close",
      ].flatMap((exportName) => [
        {
          identity: { module: "lilac-bus.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "@stanley2058/lilac-event-bus", exportName: "RawBus" },
          direction: "capture-external" as const,
          reason: "Maps an immediate raw event-bus rejection to the owned LilacBus Result.",
        },
        {
          identity: { module: "lilac-bus.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity across the immediate raw event-bus adapter.",
        },
      ]),
      ...[
        ["redis-connection-pool.ts", "RedisConnectionPool.createConnection", "Redis duplicate"],
        ["redis-streams-bus.ts", "ensureGroup", "Redis XGROUP"],
      ].flatMap(([module, exportName, externalName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "ioredis", exportName: externalName },
          direction: "capture-external" as const,
          reason: "Maps the immediate Redis failure to an owned transport Result.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the immediate Redis adapter.",
        },
      ]),
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "RedisStreamsBus.captureAcknowledgedTrim",
        },
        category: "compatibility",
        externalApi: { package: "ioredis", exportName: "acknowledged trim" },
        direction: "capture-external",
        reason: "Contains a best-effort background trim failure at its logging boundary.",
      },
      ...["RedisStreamsBus.fetch", "RedisStreamsBus.watermark"].map((exportName) => ({
        identity: { module: "redis-streams-bus.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-event-bus", exportName: "RawBus" },
        direction: "signal-host" as const,
        reason:
          "Signals a strictly decoded Redis read failure through the raw transport's existing rejection contract.",
      })),
      {
        identity: {
          module: "redis-streams-bus.ts",
          exportName: "RedisStreamsBus.retireConsumerGroup",
        },
        category: "compatibility",
        externalApi: { package: "@stanley2058/lilac-event-bus", exportName: "RawBus" },
        direction: "signal-host",
        reason:
          "Signals refused retirement through the raw transport's existing rejection contract.",
      },
    ],
  ],
  [
    "packages/tool-results",
    [
      {
        identity: {
          module: "src/tool-result-artifact-metadata-codec.ts",
          exportName: "decodeToolResultArtifactMetadata",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.parse" },
        direction: "capture-external",
        reason: "Maps malformed encrypted metadata plaintext to an owned codec Result error.",
      },
      {
        identity: {
          module: "src/tool-result-artifact-store.ts",
          exportName: "adaptToolResultArtifactReadToAvailability",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-tool-results", exportName: "read_file" },
        direction: "signal-host",
        reason:
          "Preserves the established unavailable and invalid-page outward tool contracts at one explicit policy adapter.",
      },
      {
        identity: {
          module: "src/tool-result-artifact-store.ts",
          exportName: "adaptToolResultArtifactStoreInitToHost",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/lilac-tool-results", exportName: "runtime startup" },
        direction: "signal-host",
        reason:
          "Signals an owned artifact initialization failure through the runtime startup contract.",
      },
      {
        identity: { module: "src/tool-result-media.ts", exportName: "inlineDataUrl" },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "decodeURIComponent" },
        direction: "capture-external",
        reason: "Maps malformed inline data URL escaping to a bounded fallback.",
      },
      {
        identity: {
          module: "src/tool-result-output-normalizer.ts",
          exportName: "serializeOutput",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.stringify" },
        direction: "capture-external",
        reason: "Maps non-serializable tool JSON output to the established text fallback.",
      },
      {
        identity: {
          module: "src/tool-result-output-normalizer.ts",
          exportName: "serializeOutput",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic identity across the tool output serialization adapter.",
      },
      {
        identity: {
          module: "src/tool-result-artifact-store.ts",
          exportName: "createToolResultArtifactStore.rethrowAfterCleanup",
        },
        category: "external-to-result",
        externalApi: { package: "node", exportName: "artifact cleanup" },
        direction: "capture-external",
        reason:
          "Combines an ordinary write failure with cleanup failure before the enclosing artifact Result capture.",
      },
      {
        identity: {
          module: "src/tool-result-artifact-store.ts",
          exportName: "createToolResultArtifactStore.rethrowAfterCleanup",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves primary Panic precedence and otherwise rethrows a cleanup Panic before combining ordinary failures.",
      },
      ...[
        "createToolResultArtifactStore.captureOperation",
        "createToolResultArtifactStore.readMetadata",
        "createToolResultArtifactStore.listMetadata",
        "createToolResultArtifactStore.writeAtomic",
        "createToolResultArtifactStore.writeEncryptedStreamAtomic",
        "createToolResultArtifactStore.createArtifact",
        "createToolResultArtifactStore.readEncryptedWindow",
        "createToolResultArtifactStore.readEncryptedContent",
        "createToolResultArtifactStore.read",
        "createToolResultArtifactStore.readWindow",
        "createToolResultArtifactStore.removeInvalidArtifact",
        "createToolResultArtifactStore.maintainArtifacts",
        "createToolResultArtifactStore.maintain",
      ].flatMap((exportName) => [
        {
          identity: { module: "src/tool-result-artifact-store.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "node", exportName: "artifact filesystem, stream, or AES-GCM" },
          direction: "capture-external" as const,
          reason:
            "Maps this boundary's filesystem, stream, or AES-GCM exception into the owned artifact error flow, directly or through captureOperation.",
        },
        {
          identity: { module: "src/tool-result-artifact-store.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason:
            "Preserves Panic identity while applying this boundary's explicit owned-error classification.",
        },
      ]),
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
      ...[
        ["src/config.ts", "preserveRuntimeConfigPanic"],
        ["src/providers.ts", "preserveProviderPanic"],
        ["src/model-catalog.ts", "preserveModelCatalogPanic"],
        ["src/skills.ts", "preserveSkillPanic"],
        ["src/session-service.ts", "rethrowSessionPanic"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves exact Panic identity at the immediate Mini Lilac runtime boundary.",
      })),
      ...[
        ["src/session-service.ts", "SessionActor.buildAgent.decideTurnError"],
        ["src/session-service.ts", "SessionActor.reportEventFailure"],
        ["src/workspace-history-store.ts", "isMissingExecutable"],
        ["src/workspace-history-store.ts", "describeError"],
        ["src/workspace-history-store.ts", "captureWorkspaceHistoryFailure"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.removeOwnedStore.catch.<callback@1>",
        ],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.ensureStore.catch.<callback@1>"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.applyPreparedRestore.catch.<callback@1>",
        ],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.cleanupDestinationArtifacts.catch.<callback@1>",
        ],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.emitVerificationFailure"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.withContext"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: { package: "external", exportName: "opaque runtime failure" },
        direction: "capture-external" as const,
        reason:
          "Classifies or carries one opaque runtime failure at its exact retry, diagnostic, or cleanup boundary.",
      })),
      ...[
        ["src/config.ts", "decodeRuntimeConfigYaml"],
        ["src/config.ts", "loadRuntimeConfigResult"],
        ["src/model-catalog.ts", "resolveLanguageModelResult"],
        ["src/model-catalog.ts", "decodeModelsDevRegistry"],
        ["src/model-catalog.ts", "decodeModelsDevCache"],
        ["src/model-catalog.ts", "decodeV1ModelsResponse"],
        ["src/providers.ts", "decodeProviderConfigYaml"],
        ["src/providers.ts", "loadProviderConfigResult"],
        ["src/providers.ts", "createAiProviderRegistryResult"],
        ["src/providers.ts", "loadProviderRegistryResult"],
        ["src/providers.ts", "loadProviderRegistryResult.codexTokensPromise.<callback>"],
        ["src/skills.ts", "MiniLilacSkillCatalogSnapshot.resolvePath"],
        ["src/skills.ts", "MiniLilacSkillCatalogSnapshot.readSkillFile"],
        ["src/skills.ts", "MiniLilacSkillCatalogSnapshot.listResources"],
        ["src/skills.ts", "MiniLilacSkillCatalog.discoverResult"],
        ["src/sqlite-store.ts", "serializeStoreValueResult"],
        ["src/sqlite-store.ts", "canonicalCommandPayloadResult"],
        ["src/sqlite-store.ts", "canonicalizeStoredCwd"],
        ["src/webfetch.ts", "captureWebfetchPromise"],
        ["src/webfetch.ts", "captureWebfetchSync"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "external-to-result" as const,
        externalApi: { package: "external", exportName: "runtime dependency" },
        direction: "capture-external" as const,
        reason:
          "Maps one immediate parser, provider, filesystem, stream, or serialization failure to an owned runtime Result.",
      })),
      ...[
        [
          "ModelCatalog.readDiskCacheSource",
          "node:fs/promises open, read, stat, or close",
          "Maps cache read or handle-close failure to ModelCatalogCacheReadFailed while preserving Panic precedence.",
        ],
        [
          "ModelCatalog.writeDiskCache",
          "node:fs/promises temporary cache write",
          "Preserves cache write and temporary-file cleanup failures in the owned cache error union.",
        ],
        [
          "ModelCatalog.captureFetch",
          "fetch",
          "Projects a fetch rejection into the closed model-catalog capture without retaining provider details.",
        ],
        [
          "ModelCatalog.acquireResponseReader",
          "ReadableStream.getReader",
          "Projects response-reader acquisition failure into the closed model-catalog capture.",
        ],
        [
          "ModelCatalog.captureReaderRead",
          "ReadableStreamDefaultReader.read",
          "Projects response-reader rejection into the closed model-catalog capture.",
        ],
        [
          "ModelCatalog.cancelResponseBody",
          "ReadableStream.cancel",
          "Retains response-body cancellation failure as an owned cleanup outcome.",
        ],
        [
          "ModelCatalog.cancelResponseReader",
          "ReadableStreamDefaultReader.cancel",
          "Retains response-reader cancellation failure as an owned cleanup outcome.",
        ],
        [
          "ModelCatalog.releaseReader",
          "ReadableStreamDefaultReader.releaseLock",
          "Retains response-reader lock release failure as an owned cleanup outcome.",
        ],
      ].map(([exportName, externalName, reason]) => ({
        identity: { module: "src/model-catalog.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "external", exportName: externalName },
        direction: "capture-external" as const,
        reason,
      })),
      ...[
        [
          "loadProviderAuthResult",
          "node:fs/promises stat, readFile, or JSON.parse",
          "Maps provider-auth inspection, read, and parse failures to redacted owned errors without retaining credential-bearing causes.",
        ],
        [
          "writeProviderAuthResult",
          "node:fs/promises temporary auth write",
          "Preserves write and temporary-file cleanup outcomes while omitting credential-bearing causes from owned errors.",
        ],
      ].map(([exportName, externalName, reason]) => ({
        identity: { module: "src/providers.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "external", exportName: externalName },
        direction: "capture-external" as const,
        reason,
      })),
      ...[
        ["src/config.ts", "loadRuntimeConfig"],
        ["src/model-catalog.ts", "parseModelRef"],
        ["src/model-catalog.ts", "resolveLanguageModel"],
        ["src/model-catalog.ts", "ModelCatalog.constructor"],
        ["src/model-catalog.ts", "ModelCatalog.get"],
        ["src/providers.ts", "loadProviderConfig"],
        ["src/providers.ts", "loadProviderAuth"],
        ["src/providers.ts", "writeProviderAuth"],
        ["src/providers.ts", "createAiProviderRegistry"],
        ["src/providers.ts", "loadProviderRegistry"],
        ["src/skills.ts", "MiniLilacSkillCatalogSnapshot.load"],
        ["src/sqlite-store.ts", "serializeStoreValueResult"],
        ["src/sqlite-store.ts", "storeResultToLegacy"],
        ["src/sqlite-store.ts", "canonicalCommandPayloadResult"],
        ["src/webfetch.ts", "inspectHtml.parsed.<callback>.onopentag"],
        ["src/webfetch.ts", "webfetchResultToLegacyOutput"],
        ["src/webfetch.ts", "executeWebfetch"],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: {
          package: "@stanley2058/mini-lilac-runtime",
          exportName: "legacy host contract",
        },
        direction: "signal-host" as const,
        reason:
          "Adapts an owned runtime Result, parser callback, or constructor invariant to the established throwing host contract.",
      })),
      {
        identity: { module: "src/webfetch.ts", exportName: "throwWebfetchPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic",
        reason: "Rethrows only the Panic retained by the webfetch external-capture adapter.",
      },
      {
        identity: { module: "src/model-catalog.ts", exportName: "throwModelCatalogPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic",
        reason:
          "Rethrows only the Panic retained while response cleanup was projected into a closed capture.",
      },
      ...[
        "MiniLilacSqliteStore.close",
        "MiniLilacSqliteStore.acquireCloseBlocker",
        "MiniLilacSqliteStore.updateActiveRunInputTokens",
        "MiniLilacSqliteStore.updateSessionBindings",
        "MiniLilacSqliteStore.createRun",
        "MiniLilacSqliteStore.finishRun",
        "MiniLilacSqliteStore.reserveMiniMainClaudeSessionAttempt",
        "MiniLilacSqliteStore.recordMiniMainClaudeSessionAttemptOutcome",
        "MiniLilacSqliteStore.getMiniNamedClaudeState",
        "MiniLilacSqliteStore.reserveMiniNamedClaudeSessionAttempt",
        "MiniLilacSqliteStore.recordMiniNamedClaudeSessionAttemptOutcome",
        "MiniLilacSqliteStore.admitRootPromptHistory",
        "MiniLilacSqliteStore.commitHistoryCompaction",
        "MiniLilacSqliteStore.appendHistoryTransition",
        "MiniLilacSqliteStore.closeHistoryTransition",
        "MiniLilacSqliteStore.setHistoryUndoFloor",
        "MiniLilacSqliteStore.pushHistoryRedo",
        "MiniLilacSqliteStore.reserveHistoryOperation",
        "MiniLilacSqliteStore.skipPreparedHistoryRestore",
        "MiniLilacSqliteStore.updateHistoryOperationPhase",
        "MiniLilacSqliteStore.commitHistoryNavigation",
        "MiniLilacSqliteStore.abandonHistoryNavigation",
        "MiniLilacSqliteStore.commitPendingRunFinalization",
        "MiniLilacSqliteStore.assertConservativeProviderTransition",
        "MiniLilacSqliteStore.requireQuiescentHistorySession",
        "MiniLilacSqliteStore.assertHeadsEqualState",
        "MiniLilacSqliteStore.moveHistoryCursor",
        "MiniLilacSqliteStore.parseHistoryNavigationResult",
        "MiniLilacSqliteStore.saveHistoryCommandResult",
        "MiniLilacSqliteStore.deleteHistoryOperationRow",
        "MiniLilacSqliteStore.deletePendingRunFinalizationRow",
        "MiniLilacSqliteStore.insertHistoryTransitionRow",
        "MiniLilacSqliteStore.validateHistoryTransitionDestination",
        "MiniLilacSqliteStore.assertStateConnectedToRoot",
        "MiniLilacSqliteStore.internSerializedChain",
      ].map((exportName) => ({
        identity: { module: "src/sqlite-store.ts", exportName },
        category: "rollback" as const,
        externalApi: { package: "@stanley2058/lilac-utils", exportName: "runBunSqliteTransaction" },
        direction: "signal-host" as const,
        reason:
          "Signals validation or invariant failure inside the exact SQLite transaction or synchronous compatibility boundary.",
      })),
      ...[
        "assertWorkspaceHistoryAvailable",
        "toolOutputErrorText",
        "serializedUtf8Bytes",
        "SessionActor.beginCommandSideEffect",
        "SessionActor.startPrompt",
        "SessionActor.createAgent",
        "SessionActor.createAgent.materializeAttempt",
        "SessionActor.createAgent.createCandidate",
        "SessionActor.commitSteeringBoundary",
        "SessionActor.commitSteeringBoundary.committed.<callback>",
        "SessionActor.generateSessionTitle",
        "SessionActor.delegate",
        "SessionActor.executeTopLevelRun",
        "SessionActor.finalizeTopLevelRun",
        "SessionActor.commitRunFinalization",
        "SessionActor.enqueueEvent",
        "SessionActor.publishStoredChunk",
        "SessionActor.closeSubscribers",
        "SessionActor.queueControlChunks",
        "SessionActor.queueSteeringChunk",
        "SessionActor.queueSubagentStatus",
        "SessionActor.queueAutomaticCompaction",
        "SessionActor.broadcastCompaction",
        "SessionActor.runCompaction",
        "SessionActor.summarizeForCompaction",
        "SessionService.constructor",
        "SessionService.recoverPendingFinalization",
        "SessionService.recoverHistory",
        "SessionService.runWorkspaceHistoryMaintenance",
        "SessionService.cleanupWorkspaceRestorePlans",
        "SessionService.recoverHistoryNavigation",
        "SessionService.promptDelegatedSession",
        "SessionService.abandonHistoryNavigationInternal",
      ].map((exportName) => ({
        identity: { module: "src/session-service.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "external", exportName: "agent, persistence, or callback effect" },
        direction: "capture-external" as const,
        reason:
          "Contains one immediate agent, persistence, queue, or callback failure at the actor-owned Result boundary.",
      })),
      ...[
        "assertWorkspaceHistoryAvailable",
        "SessionActor.withLock",
        "SessionActor.beginCommandSideEffect",
        "SessionActor.recordWorkspaceCapture",
        "SessionActor.startPrompt",
        "SessionActor.createAgent",
        "SessionActor.createAgent.execute",
        "SessionActor.createAgent.materializeAttempt.execute",
        "SessionActor.createAgent.materializeAttempt",
        "SessionActor.createAgent.createCandidate",
        "SessionActor.commitSteeringBoundary",
        "SessionActor.commitSteeringBoundary.entries.<callback>",
        "SessionActor.commitSteeringBoundary.committed.<callback>",
        "SessionActor.generateSessionTitle",
        "SessionActor.replaceTodos",
        "SessionActor.replaceTodos.operation.<callback>",
        "SessionActor.delegate",
        "SessionActor.executeTopLevelRun",
        "SessionActor.commitRunFinalization",
        "SessionActor.steer",
        "SessionActor.interruptQueuedSteering",
        "SessionActor.cancel",
        "SessionActor.historyNavigationTarget",
        "SessionActor.replayHistoryNavigation",
        "SessionActor.assertHistoryNavigationQuiescent",
        "SessionActor.compact",
        "SessionActor.runCompaction",
        "SessionActor.summarizeForCompaction",
        "SessionActor.updateBindings",
        "SessionService.constructor",
        "SessionService.workspaceHistoryForWorkspace",
        "SessionService.recordWorkspaceCaptureForSession",
        "SessionService.recoverPendingFinalization",
        "SessionService.recoverHistory",
        "SessionService.createSessionInternal",
        "SessionService.listSkills",
        "SessionService.promptDelegatedSession",
        "SessionService.withDelegatedSessionLock",
        "SessionService.close",
        "SessionService.shutdown",
        "SessionService.assertAcceptingAdmissions",
        "SessionService.trackOperation",
        "SessionService.trackTask",
        "SessionService.waitWithinGrace",
      ].map((exportName) => ({
        identity: { module: "src/session-service.ts", exportName },
        category: "compatibility" as const,
        externalApi: {
          package: "@stanley2058/mini-lilac-runtime",
          exportName: "actor host contract",
        },
        direction: "signal-host" as const,
        reason:
          "Signals cancellation, admission, invariant, or retained defect through the exact actor or legacy host contract.",
      })),
      ...[
        "bytesToText",
        "runWorkspaceHistoryCleanup",
        "WorkspaceHistoryStore.capability",
        "WorkspaceHistoryStore.verifySnapshot",
        "WorkspaceHistoryStore.prepareRestoreLocked",
        "WorkspaceHistoryStore.resumePreparedRestoreLocked",
        "WorkspaceHistoryStore.objectExists",
        "WorkspaceHistoryStore.reconcileExpectedSnapshotRefs",
        "WorkspaceHistoryStore.cleanupOrphanSnapshotRefs",
        "WorkspaceHistoryStore.getObjectAccounting",
        "WorkspaceHistoryStore.runMaintenance",
        "WorkspaceHistoryStore.writeAtomicPrivateFile",
        "WorkspaceHistoryStore.ensureStore",
        "WorkspaceHistoryStore.writeCaptureTree",
        "WorkspaceHistoryStore.stageSnapshot",
        "WorkspaceHistoryStore.stageDestinationEntries",
        "WorkspaceHistoryStore.createIntendedDirectory",
        "WorkspaceHistoryStore.validateSnapshotGraphs",
        "WorkspaceHistoryStore.validateSourceGitDirectory",
        "WorkspaceHistoryStore.runGit",
        "WorkspaceHistoryStore.runPrivateGitToHandle",
        "WorkspaceHistoryStore.emitMetric",
      ].map((exportName) => ({
        identity: { module: "src/workspace-history-store.ts", exportName },
        category: "external-to-result" as const,
        externalApi: { package: "node", exportName: "filesystem, Git, or observer operation" },
        direction: "capture-external" as const,
        reason:
          "Contains one immediate filesystem, Git, decoder, or observer failure beneath the public workspace-history Result boundary.",
      })),
      ...[
        "bytesToText",
        "parseObjectAccounting",
        "parseObjectAccounting.count",
        "parseObjectAccounting.kibibytes",
        "parseOid",
        "splitNul",
        "assertSafeRelativePath",
        "runWorkspaceHistoryCleanup",
        "lstatIfExists",
        "WorkspaceHistoryStore.constructor",
        "WorkspaceHistoryStore.capability",
        "WorkspaceHistoryStore.withWorkspaceLock.assertActive",
        "WorkspaceHistoryStore.resumeRestore",
        "WorkspaceHistoryStore.cleanupRestorePlans",
        "WorkspaceHistoryStore.verifySnapshot",
        "WorkspaceHistoryStore.prepareRestoreLocked",
        "WorkspaceHistoryStore.resumePreparedRestoreLocked",
        "WorkspaceHistoryStore.objectExists",
        "WorkspaceHistoryStore.reconcileExpectedSnapshotRefs",
        "WorkspaceHistoryStore.cleanupOrphanSnapshotRefs",
        "WorkspaceHistoryStore.getObjectAccounting",
        "WorkspaceHistoryStore.runMaintenance",
        "WorkspaceHistoryStore.validateExpectedRootTreeOids",
        "WorkspaceHistoryStore.cleanupUnreferencedSnapshotMetadata",
        "WorkspaceHistoryStore.removeOwnedStore",
        "WorkspaceHistoryStore.verifyNoAlternates",
        "WorkspaceHistoryStore.reconcileExpectedSnapshotRefsUnlocked",
        "WorkspaceHistoryStore.verifyExistingStoreOwnership",
        "WorkspaceHistoryStore.validateOperationId",
        "WorkspaceHistoryStore.signatureMap",
        "WorkspaceHistoryStore.writeRestorePlanManifest",
        "WorkspaceHistoryStore.listSnapshotRefsUnlocked",
        "WorkspaceHistoryStore.probeGit",
        "WorkspaceHistoryStore.ensureStore",
        "WorkspaceHistoryStore.assertNoSymlinkComponents",
        "WorkspaceHistoryStore.classifyWorkspace",
        "WorkspaceHistoryStore.discoverSourceRepository",
        "WorkspaceHistoryStore.listSourceManagedPaths",
        "WorkspaceHistoryStore.resolveEffectiveExcludesFile",
        "WorkspaceHistoryStore.checkIgnoredPaths",
        "WorkspaceHistoryStore.existingObjects",
        "WorkspaceHistoryStore.writeCaptureTree",
        "WorkspaceHistoryStore.parseLsTree",
        "WorkspaceHistoryStore.preflightRestore",
        "WorkspaceHistoryStore.preflightDestinationCapabilities",
        "WorkspaceHistoryStore.objectSizes",
        "WorkspaceHistoryStore.validateTargetPathSet",
        "WorkspaceHistoryStore.stageSnapshot",
        "WorkspaceHistoryStore.stageDestinationEntries",
        "WorkspaceHistoryStore.createExclusiveTemporaryDirectory",
        "WorkspaceHistoryStore.createIntendedDirectory",
        "WorkspaceHistoryStore.createDestinationSibling",
        "WorkspaceHistoryStore.parentIdentity",
        "WorkspaceHistoryStore.applyPreparedRestore",
        "WorkspaceHistoryStore.publishReplacementRoot",
        "WorkspaceHistoryStore.validateDestinationStaging",
        "WorkspaceHistoryStore.publishDestinationSibling",
        "WorkspaceHistoryStore.syncPreparedOwnershipManifest.retainIdentity",
        "WorkspaceHistoryStore.assertOwnedTemporary",
        "WorkspaceHistoryStore.cleanupDestinationArtifacts",
        "WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked",
        "WorkspaceHistoryStore.validatedOwnedRestoreArtifactPaths",
        "WorkspaceHistoryStore.assertPreparedRestoreFresh",
        "WorkspaceHistoryStore.assertFrozenRecoveryState",
        "WorkspaceHistoryStore.assertFrozenSourceIntact",
        "WorkspaceHistoryStore.verifyFrozenSignatures",
        "WorkspaceHistoryStore.stripPreparedArtifacts",
        "WorkspaceHistoryStore.assertLiveSignature",
        "WorkspaceHistoryStore.workspaceIdentity",
        "WorkspaceHistoryStore.assertSafeMutationAncestors",
        "WorkspaceHistoryStore.verifyProtectedSignatures",
        "WorkspaceHistoryStore.verifyFrozenRestoredSnapshot",
        "WorkspaceHistoryStore.verifyTargetSnapshot",
        "WorkspaceHistoryStore.validateSnapshotGraphs",
        "WorkspaceHistoryStore.enumerateSnapshotGraph",
        "WorkspaceHistoryStore.requireObject",
        "WorkspaceHistoryStore.validateSourceGitDirectory",
        "WorkspaceHistoryStore.runGit",
        "WorkspaceHistoryStore.runPrivateGitToHandle",
      ].map((exportName) => ({
        identity: { module: "src/workspace-history-store.ts", exportName },
        category: "compatibility" as const,
        externalApi: {
          package: "@stanley2058/mini-lilac-runtime",
          exportName: "workspace-history private exception protocol",
        },
        direction: "signal-host" as const,
        reason:
          "Signals an owned validation, filesystem, or Git failure within the exception-native implementation captured by the public Result adapter.",
      })),
      ...[
        "SessionService.capturePersistenceResult",
        "SessionService.capturePersistencePromise",
      ].flatMap((exportName) => [
        {
          identity: { module: "src/session-service.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "bun:sqlite", exportName: "Database operation" },
          direction: "capture-external" as const,
          reason:
            "Maps owned persistence failures and recognized SQLite driver exceptions to the SessionService Result surface.",
        },
        {
          identity: { module: "src/session-service.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason:
            "Preserves Panic and unrecognized defects across the SessionService Result adapter.",
        },
      ]),
      ...[
        ["src/session-service.ts", "SessionActor.navigateHistory"],
        ["src/sqlite-persistence-codec.ts", "decodePlainJson"],
        ["src/sqlite-persistence-codec.ts", "decodeSuperJson"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.initializeSchemaResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.constructor"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.runHistoryReadResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.closeAfterInitializationFailure"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.restoreSchemaMigrationPragmas"],
        ["src/sqlite-store.ts", "captureMiniLilacCleanup"],
        ["src/sqlite-store.ts", "reportMiniLilacCleanupFailure"],
        ["src/sqlite-store.ts", "readMiniLilacHistoryRecoveryStatusResult"],
        ["src/sqlite-store.ts", "closeMiniLilacHistoryRecoveryDatabase"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.getModelMessagesResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.getUiMessagesResult"],
        ["src/sqlite-todo-persistence-codec.ts", "decodeMiniLilacTodos"],
        ["src/sqlite-todo-persistence-codec.ts", "readMiniLilacTodos"],
        ["src/workspace-history-store.ts", "preserveWorkspaceHistoryFailureDuringCleanup"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.withWorkspaceLock"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readCaptureCache"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.capturePublicResult"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.captureLockedResult"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.captureLocked"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.invalidateCaptureCacheResult"],
      ].flatMap(([module, exportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: "persistence dependency" },
          direction: "capture-external" as const,
          reason:
            "Captures the immediate persistence, filesystem, parser, or lock exception at its owned adapter boundary.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic or unrecognized defect" },
          direction: "observe-panic" as const,
          reason:
            "Preserves Panic or an unrecognized defect while the adapter maps only its owned expected failures.",
        },
      ]),
      ...[
        ["src/workspace-history-persistence-codec.ts", "parseJson"],
        ["src/workspace-history-store.ts", "lstatIfExists"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.removeOwnedStore"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.writeCaptureCache"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.createExclusiveTemporaryDirectory",
        ],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.createDestinationSibling"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.applyPreparedRestore"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.publishDestinationSibling"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.cleanupDestinationArtifacts"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked",
        ],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.ensureSnapshotRefCreationMetadata",
        ],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "external-to-result" as const,
        externalApi: { package: "node", exportName: "filesystem or process operation" },
        direction: "capture-external" as const,
        reason:
          "Captures the immediate filesystem or process exception before the public workspace-history Result boundary.",
      })),
      ...[
        ["src/session-service.ts", "mapMiniLilacPersistenceFailure"],
        ["src/session-service.ts", "SessionActor.navigateHistory"],
        ["src/session-service.ts", "SessionService.runWorkspaceHistoryMaintenance"],
        ["src/session-service.ts", "SessionService.reconcileWorkspaceSnapshotRefs"],
        ["src/session-service.ts", "SessionService.cleanupWorkspaceRestorePlans"],
        ["src/session-service.ts", "SessionService.recoverHistoryNavigation"],
        ["src/session-service.ts", "SessionService.abandonHistoryNavigationInternal"],
        ["src/session-service.ts", "SessionService.captureWorkspaceWithCacheInvalidationPolicy"],
        ["src/sqlite-persistence-codec.ts", "decodePlainJson"],
        ["src/sqlite-persistence-codec.ts", "decodeSuperJson"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.initializeSchemaResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.constructor"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.runHistoryReadResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.closeAfterInitializationFailure"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.restoreSchemaMigrationPragmas"],
        ["src/sqlite-store.ts", "throwPrimaryAfterCleanup"],
        ["src/sqlite-store.ts", "readMiniLilacHistoryRecoveryStatusResult"],
        ["src/sqlite-store.ts", "closeMiniLilacHistoryRecoveryDatabase"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.rehashTranscriptNodesForMigration"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.getModelMessagesResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.getUiMessagesResult"],
        ["src/sqlite-store.ts", "MiniLilacSqliteStore.decodeTranscriptNodeValue"],
        ["src/sqlite-todo-persistence-codec.ts", "decodeMiniLilacTodos"],
        ["src/sqlite-todo-persistence-codec.ts", "readMiniLilacTodos"],
        ["src/workspace-history-store.ts", "preserveWorkspaceHistoryFailureDuringCleanup"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.withWorkspaceLock"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readRestorePlanManifest"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.verifyOwnershipMarker"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readCaptureCache"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.writeAtomicPrivateFile"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readSnapshot"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readRestoreOwnershipManifest"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.readSnapshotRefCreationMetadata"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.objectTypesUnlocked"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.supportedPlatform"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.capturePublicResult"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.withWorkspaceLock.lockedStore.capture",
        ],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.captureLocked"],
        ["src/workspace-history-store.ts", "WorkspaceHistoryStore.captureClassifiedWorkspace"],
        [
          "src/workspace-history-store.ts",
          "WorkspaceHistoryStore.reconcileCaptureStateAfterRestore",
        ],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: { package: "internal", exportName: "enclosing Result or host boundary" },
        direction: "signal-host" as const,
        reason:
          "Signals an unrecognized defect or compatibility failure to the enclosing registered Result or host adapter.",
      })),
      ...[
        "readMiniLilacHistoryRecoveryStatus",
        "toRun",
        "MiniLilacSqliteStore.constructor",
        "MiniLilacSqliteStore.initializeSchema",
        "MiniLilacSqliteStore.getTodos",
        "MiniLilacSqliteStore.runStoreTransaction",
        "MiniLilacSqliteStore.getHistoryStoreMetadata",
        "MiniLilacSqliteStore.getWorkspaceForSession",
        "MiniLilacSqliteStore.listWorkspaces",
        "MiniLilacSqliteStore.listWorkspaceSnapshots",
        "MiniLilacSqliteStore.listWorkspaceSnapshotGroups",
        "MiniLilacSqliteStore.getWorkspaceSnapshot",
        "MiniLilacSqliteStore.getHistoryState",
        "MiniLilacSqliteStore.getHistoryStateModelMessages",
        "MiniLilacSqliteStore.getHistoryStateUiMessages",
        "MiniLilacSqliteStore.getCurrentHistoryState",
        "MiniLilacSqliteStore.getSessionHistory",
        "MiniLilacSqliteStore.getHistoryNavigation",
        "MiniLilacSqliteStore.findLatestUndoableUserTransition",
        "MiniLilacSqliteStore.peekHistoryRedo",
        "MiniLilacSqliteStore.listHistoryTopology",
        "MiniLilacSqliteStore.getHistoryAccounting",
        "MiniLilacSqliteStore.getHistoryOperation",
        "MiniLilacSqliteStore.listHistoryOperations",
        "MiniLilacSqliteStore.getPendingRunFinalization",
        "MiniLilacSqliteStore.listPendingRunFinalizations",
        "MiniLilacSqliteStore.listRecoverableOpenRootRuns",
        "MiniLilacSqliteStore.getHistoryTransition",
        "MiniLilacSqliteStore.getModelMessages",
        "MiniLilacSqliteStore.getUiMessages",
        "MiniLilacSqliteStore.createSession",
        "MiniLilacSqliteStore.replaceTodosForRun",
        "MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot",
        "MiniLilacSqliteStore.getMiniMainClaudeState",
        "MiniLilacSqliteStore.commitSteeringHistoryBoundary",
        "MiniLilacSqliteStore.commitEmptyHistoryNavigation",
        "MiniLilacSqliteStore.reservePendingRunFinalization",
        "MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner",
        "MiniLilacSqliteStore.getIncomingHistoryTransition",
        "MiniLilacSqliteStore.readSerializedChain",
        "MiniLilacSqliteStore.getCommandResult",
      ].map((exportName) => ({
        identity: { module: "src/sqlite-store.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "internal", exportName: "legacy Mini Lilac store API" },
        direction: "signal-host" as const,
        reason:
          "Adapts an owned persistence Result to the established synchronous Mini Lilac store contract.",
      })),
    ],
  ],
  [
    "apps/mini-lilac-server",
    [
      ...["settleLifecycleResult", "settleCleanupEffect", "settleCleanupResult"].flatMap(
        (exportName) => [
          {
            identity: { module: "src/main.ts", exportName },
            category: "external-to-result" as const,
            externalApi: { package: "external", exportName: "shutdown effect" },
            direction: "capture-external" as const,
            reason: "Settles one lifecycle or cleanup effect into an owned closed Result envelope.",
          },
          {
            identity: { module: "src/main.ts", exportName },
            category: "defect-supervisor" as const,
            externalApi: { package: "better-result", exportName: "Panic.is" },
            direction: "observe-panic" as const,
            reason: "Retains exact Panic identity while shutdown cleanup continues.",
          },
        ],
      ),
      ...[
        ["src/main.ts", "captureServerOperation", "server operation"],
        ["src/main.ts", "captureServerCleanup", "server cleanup"],
        ["src/main.ts", "captureNodeCliParsing", "node:util.parseArgs"],
        ["src/server.ts", "captureSessionCreation", "session creation"],
        ["src/server.ts", "canonicalDirectory", "node:fs/promises.realpath"],
      ].flatMap(([module, exportName, externalExportName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalExportName },
          direction: "capture-external" as const,
          reason:
            "Maps one immediate server, CLI, filesystem, or cleanup failure to an owned Result.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the same Mini Lilac server boundary.",
        },
      ]),
      {
        identity: { module: "src/main.ts", exportName: "settleShutdownEffect" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Settles every shutdown effect while retaining the first observed Panic.",
      },
      ...[
        ["src/main.ts", "adaptLifecycleResultToHost", "server lifecycle"],
        ["src/main.ts", "acquireDatabaseLock", "database lock compatibility API"],
        ["src/main.ts", "shutdownMiniLilacServer", "server shutdown compatibility API"],
        ["src/server.ts", "invalidServerConfiguration", "Elysia server construction"],
      ].map(([module, exportName, externalExportName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/mini-lilac-server", exportName: externalExportName },
        direction: "signal-host" as const,
        reason: "Signals an owned server failure through the established rejecting host contract.",
      })),
      {
        identity: { module: "src/server.ts", exportName: "classifyHttpOperationFailure" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic before classifying ordinary HTTP operation failures.",
      },
      {
        identity: { module: "src/server.ts", exportName: "captureHttpOperation" },
        category: "external-to-result",
        externalApi: { package: "elysia", exportName: "request handler" },
        direction: "capture-external",
        reason: "Maps a request-handler rejection to the local HTTP Result envelope.",
      },
      ...["enqueueSseKeepAlive"].flatMap((exportName) => [
        {
          identity: { module: "src/server.ts", exportName },
          category: "compatibility" as const,
          externalApi: { package: "global", exportName: "ReadableStream controller.enqueue" },
          direction: "capture-external" as const,
          reason: "Contains a closed SSE controller enqueue failure during keep-alive cleanup.",
        },
        {
          identity: { module: "src/server.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic from the SSE controller boundary.",
        },
      ]),
      {
        identity: {
          module: "src/server.ts",
          exportName: "adaptMiniLilacPersistenceResultToHost",
        },
        category: "result-to-framework",
        externalApi: { package: "elysia", exportName: "HTTP request handler" },
        direction: "signal-host",
        reason:
          "Maps an owned Mini Lilac persistence Err to the established HTTP exception boundary.",
      },
    ],
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "persistence.ts", exportName: "runBunSqliteTransaction" },
        category: "rollback",
        externalApi: { package: "bun:sqlite", exportName: "Database.transaction.immediate" },
        direction: "signal-host",
        reason:
          "Signals a logical Err through Bun's transaction callback using one private rollback sentinel.",
      },
      {
        identity: {
          module: "persistence.ts",
          exportName: "runBunSqliteTransaction.value.<callback>",
        },
        category: "rollback",
        externalApi: { package: "bun:sqlite", exportName: "Database.transaction.immediate" },
        direction: "signal-host",
        reason:
          "Throws the private rollback sentinel only inside Bun's exact transaction callback.",
      },
      {
        identity: { module: "persistence.ts", exportName: "runBunSqliteTransaction" },
        category: "external-to-result",
        externalApi: { package: "bun:sqlite", exportName: "Database.transaction.immediate" },
        direction: "capture-external",
        reason:
          "Maps only caller-classified SQLite driver failures and rethrows unrecognized exceptions unchanged.",
      },
      {
        identity: { module: "persistence.ts", exportName: "runBunSqliteTransaction" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Preserves exact Panic identity and escalates detectable transaction finalization uncertainty.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "isPanic" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason:
          "Recognizes genuine Panic while containing hostile proxy classification traps as ordinary opaque failure.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "opaqueErrorMessage" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error.message/String" },
        direction: "capture-external",
        reason:
          "Contains hostile prototype, message, and coercion traps while projecting bounded caller-owned fallback text.",
      },
      {
        identity: { module: "runtime-utils.ts", exportName: "opaqueErrorCause" },
        category: "compatibility",
        externalApi: { package: "global", exportName: "Error instanceof" },
        direction: "capture-external",
        reason:
          "Contains hostile prototype traps while preserving inspectable causes and replacing opaque ones with a plain Error.",
      },
      ...["pathExists", "readCustomCommandDefinition", "discoverCustomCommands"].flatMap(
        (exportName) => [
          {
            identity: { module: "custom-commands.ts", exportName },
            category: "external-to-result" as const,
            externalApi: { package: "node", exportName: "filesystem or JSON operation" },
            direction: "capture-external" as const,
            reason: "Maps immediate custom-command discovery failure to an owned Result error.",
          },
          {
            identity: { module: "custom-commands.ts", exportName },
            category: "defect-supervisor" as const,
            externalApi: { package: "better-result", exportName: "Panic.is" },
            direction: "observe-panic" as const,
            reason: "Preserves Panic while mapping ordinary custom-command discovery failure.",
          },
        ],
      ),
      {
        identity: { module: "custom-commands.ts", exportName: "decodeCustomCommandResult" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic while hostile custom-command result getters are decoded.",
      },
      ...[
        ["find-root.ts", "hasWorkspacesFieldResult", "workspace manifest read"],
        ["codex-oauth.ts", "decodeCodexTokens", "persisted token JSON parse"],
        ["codex-oauth.ts", "writeSecretFileResult", "atomic secret write"],
        ["codex-oauth.ts", "readCodexTokensResult", "persisted token read"],
        ["codex-oauth.ts", "clearCodexTokensResult", "persisted token cleanup"],
        ["codex-oauth.ts", "exchangeCodeForTokensResult", "OAuth exchange"],
        ["codex-oauth.ts", "refreshAccessTokenResult", "OAuth refresh"],
        ["codex-oauth.ts", "startCodexOAuthLogin.runExchangeResult", "OAuth login"],
        ["core-config.ts", "decodeCoreConfigYaml", "YAML parse"],
        ["model-capability.ts", "ModelCapability.loadRegistryResult", "model registry fetch"],
        [
          "openai-responses-websocket-fetch.ts",
          "decodeResponsesRequestBody.catch",
          "request JSON parse",
        ],
        [
          "server-compaction-request.ts",
          "prepareServerCompactionRequestResult",
          "compaction request boundary",
        ],
        ["skills.ts", "pathExists", "skill path access"],
        ["skills.ts", "scanSkillPathsBounded", "skill directory scan"],
        ["skills.ts", "readTextPrefixResult", "skill file read"],
        ["skills.ts", "parseSkillMarkdownResult", "skill frontmatter parse"],
      ].flatMap(([module, exportName, externalName]) => [
        {
          identity: { module, exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: externalName },
          direction: "capture-external" as const,
          reason: "Maps the immediate external failure to the utility's owned Result error.",
        },
        {
          identity: { module, exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity while mapping the utility's owned external failure.",
        },
      ]),
      ...[
        ["agent-prompts.ts", "exists"],
        ["agent-prompts.ts", "parsePromptTemplateState"],
        ["agent-prompts.ts", "loadPromptTemplateState"],
        ["agent-prompts.ts", "readTextIfExists"],
        ["agent-prompts.ts", "promptWorkspaceSignature"],
        ["build-info.ts", "findWorkspaceRootSafe"],
        ["build-info.ts", "readBuildInfoFile"],
        ["build-info.ts", "getBuildInfoFileCacheKey"],
        ["build-info.ts", "readGitBuildInfo"],
        ["codex-oauth.ts", "parseJwtClaims"],
        ["codex-oauth.ts", "parseCodexOAuthCallback"],
        ["llm-wire-debug.ts", "JsonlWriter.write"],
        ["llm-wire-debug.ts", "createWriter"],
        ["llm-wire-debug.ts", "captureNonStreamingResponse"],
        ["llm-wire-debug.ts", "consumeSseDebugStream"],
        ["llm-wire-debug.ts", "safeParseJson"],
        ["llm-wire-debug.ts", "decodeRequestBody"],
        ["logging.ts", "reportOpenObserveDiagnostics"],
        ["logging.ts", "safeJsonStringify"],
        ["logging.ts", "OpenObserveJsonlStream.write"],
        ["model-provider.ts", "decodeCodexResponsesRequestBody.catch"],
        ["openai-responses-websocket-fetch.ts", "createOpenAIResponsesWebSocketFetch.closeSocket"],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.enqueueNormalizedEvent",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onMessage",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onClose",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onAbort",
        ],
      ].map(([module, exportName]) => ({
        identity: { module, exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic at the exact utility exception or callback boundary.",
      })),
      {
        identity: { module: "codex-oauth.ts", exportName: "startCodexOAuthLogin.exchangeResult" },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "Promise rejection" },
        direction: "capture-external",
        reason: "Captures an OAuth exchange rejection into the owned login Result.",
      },
      ...[
        ["codex-oauth.ts", "startCodexOAuthLogin", "OAuth login startup"],
        ["llm-wire-debug.ts", "withLlmWireDebugFetch", "debug fetch"],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: { package: "@stanley2058/lilac-utils", exportName: externalName },
        direction: "signal-host" as const,
        reason: "Preserves the established host rejection contract after bounded interception.",
      })),
      ...[
        ["agent-prompts.ts", "exists", "filesystem existence probe"],
        ["agent-prompts.ts", "parsePromptTemplateState", "prompt-state JSON parse"],
        ["agent-prompts.ts", "loadPromptTemplateState", "prompt-state load"],
        ["agent-prompts.ts", "readTextIfExists", "prompt text read"],
        ["agent-prompts.ts", "promptWorkspaceSignature", "workspace signature"],
        ["ai-error.ts", "sanitizeRequestUrl", "URL"],
        ["ai-error.ts", "parseResponseBody", "JSON.parse"],
        ["build-info.ts", "findWorkspaceRootSafe", "workspace discovery"],
        ["build-info.ts", "readBuildInfoFile", "build-info read"],
        ["build-info.ts", "getBuildInfoFileCacheKey", "build-info stat"],
        ["build-info.ts", "readGitBuildInfo", "git metadata read"],
        ["codex-oauth.ts", "parseJwtClaims", "JWT JSON parse"],
        ["codex-oauth.ts", "parseCodexOAuthCallback", "URL"],
        ["codex-oauth.ts", "startCodexOAuthLogin", "OAuth callback server"],
        ["codex-oauth.ts", "startCodexOAuthLogin.close", "OAuth callback server close"],
        ["core-config.ts", "getCoreConfig", "configuration filesystem"],
        ["llm-wire-debug.ts", "JsonlWriter.write", "wire-debug file write"],
        ["llm-wire-debug.ts", "withLlmWireDebugFetch", "debug fetch"],
        ["llm-wire-debug.ts", "createWriter", "wire-debug writer creation"],
        ["llm-wire-debug.ts", "captureNonStreamingResponse", "response clone"],
        ["llm-wire-debug.ts", "consumeSseDebugStream", "SSE debug stream"],
        ["llm-wire-debug.ts", "safeParseJson", "JSON.parse"],
        ["llm-wire-debug.ts", "decodeRequestBody", "request body decode"],
        ["logging.ts", "reportOpenObserveDiagnostics", "OpenObserve reporting"],
        ["logging.ts", "safeJsonStringify", "JSON.stringify"],
        ["logging.ts", "OpenObserveJsonlStream.write", "OpenObserve stream write"],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.closeSocket",
          "WebSocket close",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.connectWebSocket",
          "WebSocket connect",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch",
          "WebSocket request",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.enqueueNormalizedEvent",
          "Responses stream enqueue",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onMessage",
          "WebSocket message",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onClose",
          "WebSocket close event",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start.onAbort",
          "WebSocket abort",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch.start",
          "Responses stream start",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "maybeNormalizeResponsesSseResponse.start",
          "SSE normalization",
        ],
        ["openai-responses-websocket-fetch.ts", "normalizeSseFrame", "SSE frame JSON parse"],
        ["openai-responses-websocket-fetch.ts", "decodeRequestBody", "request body decode"],
        ["tool-call-input-normalization.ts", "parsePlainObjectJson", "tool input JSON parse"],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: { package: "external", exportName: externalName },
        direction: "capture-external" as const,
        reason: "Contains an immediate external exception at a bounded compatibility boundary.",
      })),
      ...[
        ["codex-oauth.ts", "readCodexTokens", "legacy token read"],
        ["codex-oauth.ts", "writeCodexTokens", "legacy token write"],
        ["codex-oauth.ts", "clearCodexTokens", "legacy token cleanup"],
        ["codex-oauth.ts", "exchangeCodeForTokens", "legacy OAuth exchange"],
        ["codex-oauth.ts", "refreshAccessToken", "legacy OAuth refresh"],
        ["codex-oauth.ts", "startCodexOAuthLogin.exchange", "legacy OAuth login"],
        ["core-config.ts", "readCoreConfigVersion", "legacy config version"],
        ["core-config.ts", "parseCoreConfig", "legacy config parse"],
        ["core-config.ts", "getCoreConfig", "legacy config load"],
        ["core-config.ts", "resolveDiscordToken", "legacy Discord token resolution"],
        ["core-config/v1.ts", "parseCoreConfigV1ToUniversal", "legacy v1 config parse"],
        ["core-config/v2.ts", "parseCoreConfigV2ToUniversal", "legacy v2 config parse"],
        ["find-root.ts", "findWorkspaceRoot", "legacy workspace discovery"],
        ["friendly-units.ts", "parseFriendlyByteSize", "legacy byte-size parse"],
        ["friendly-units.ts", "parseFriendlyDurationMs", "legacy duration parse"],
        ["model-capability.ts", "parseModelSpecifier", "legacy model specifier parse"],
        ["model-capability.ts", "ModelCapability.resolve", "legacy model capability resolution"],
        [
          "model-provider.ts",
          "normalizeCodexResponsesRequestRecord",
          "legacy Codex request normalization",
        ],
        ["model-provider.ts", "createCodexOAuthProvider", "AI SDK OAuth provider"],
        ["model-provider.ts", "createCodexOAuthProvider.refreshIfNeeded", "AI SDK OAuth refresh"],
        ["model-slot.ts", "fromDurableResolvedModelRequest", "legacy durable model request"],
        ["model-slot.ts", "fromDurableResolvedModelPlan", "legacy durable model plan"],
        ["model-slot.ts", "resolveModelRef", "legacy model reference"],
        ["model-slot.ts", "resolveModelChain", "legacy model chain"],
        ["model-slot.ts", "resolveModelPlan", "legacy model plan"],
        ["model-slot.ts", "resolveModelSlot", "legacy model slot"],
        [
          "openai-responses-websocket-fetch.ts",
          "signalResponsesStreamError",
          "ReadableStream controller",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.connectWebSocket",
          "WebSocket connection promise",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.connectWebSocket.onError",
          "WebSocket connection promise",
        ],
        [
          "openai-responses-websocket-fetch.ts",
          "createOpenAIResponsesWebSocketFetch.websocketFetch",
          "fetch response contract",
        ],
        [
          "server-compaction-request.ts",
          "withServerCompactionRequestFetch.wrappedFetch",
          "fetch adapter",
        ],
        ["skills.ts", "parseSkillMarkdown", "legacy skill parser"],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-utils", exportName: externalName },
        direction: "signal-host" as const,
        reason: "Adapts an owned Result or compatibility failure to the established host contract.",
      })),
      ...[
        ["codex-oauth.ts", "readCodexTokens", "legacy token read"],
        ["codex-oauth.ts", "clearCodexTokens", "legacy token cleanup"],
        ["codex-oauth.ts", "legacyCodexTokenWriteError", "legacy token write errors"],
        ["codex-oauth.ts", "legacyCodexOAuthError", "legacy OAuth errors"],
        ["codex-oauth.ts", "legacyCodexOAuthLoginError", "legacy OAuth login errors"],
        ["model-capability.ts", "ModelCapability.resolve", "legacy model capability errors"],
        [
          "server-compaction-request.ts",
          "withServerCompactionRequestFetch.wrappedFetch",
          "legacy compaction request errors",
        ],
      ].map(([module, exportName, externalName]) => ({
        identity: { module, exportName },
        category: "compatibility" as const,
        externalApi: { package: "@stanley2058/lilac-utils", exportName: externalName },
        direction: "capture-external" as const,
        reason:
          "Projects an owned unknown-bearing error cause only at the exact legacy compatibility boundary.",
      })),
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "normalizeStreamChunk" },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/mini-lilac-client",
          exportName: "miniLilacUnsupportedUIMessageChunkSchema",
        },
        direction: "signal-host",
        reason:
          "Rejects malformed reserved data-* sentinels and stream chunks through the existing stream host contract.",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "validateUnsupportedSentinel",
        },
        category: "result-to-framework",
        externalApi: { package: "ai", exportName: "Schema.validate" },
        direction: "signal-host",
        reason: "Rejects an invalid unsupported-chunk sentinel through the stream host contract.",
      },
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "parseMiniLilacStream.transform",
        },
        category: "result-to-framework",
        externalApi: { package: "global", exportName: "TransformStream.transform" },
        direction: "signal-host",
        reason: "Propagates malformed event-stream frames through the stream host contract.",
      },
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "externalOperationError" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic from the owned operation or cancellation signal.",
      },
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "ownedRequestCancellation" },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves a Panic used as the exact owned AbortSignal reason.",
      },
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "captureMiniLilacPromise" },
        category: "external-to-result",
        externalApi: { package: "external", exportName: "Mini Lilac async dependency" },
        direction: "capture-external",
        reason: "Maps an immediate client dependency rejection to an owned Result error.",
      },
      ...["captureMiniLilacSync"].flatMap((exportName) => [
        {
          identity: { module: "mini-lilac-transport.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "external", exportName: "Mini Lilac sync dependency" },
          direction: "capture-external" as const,
          reason: "Maps an immediate synchronous dependency failure to an owned Result error.",
        },
        {
          identity: { module: "mini-lilac-transport.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity across the synchronous client adapter.",
        },
      ]),
      {
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "resultToMiniLilacClientValue",
        },
        category: "result-to-framework",
        externalApi: { package: "@stanley2058/mini-lilac-client", exportName: "legacy client API" },
        direction: "signal-host",
        reason: "Adapts owned client Results to the package's established throwing API contract.",
      },
      ...["cleanupMiniLilacStreamReader", "readMiniLilacStreamResult"].flatMap((exportName) => [
        {
          identity: { module: "mini-lilac-transport.ts", exportName },
          category: "external-to-result" as const,
          externalApi: { package: "global", exportName: "ReadableStream cleanup" },
          direction: "capture-external" as const,
          reason: "Maps an immediate stream cleanup rejection to an owned Result error.",
        },
        {
          identity: { module: "mini-lilac-transport.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves cleanup Panic precedence after all owned stream resources settle.",
        },
      ]),
      ...[
        "parseMiniLilacStream.pull",
        "parseMiniLilacStream.cancel",
        "parseMiniLilacStream.transform",
        "resultStreamFromMiniLilacStream.cancel",
        "resultStreamToLegacyStream.pull",
      ].map((exportName) => ({
        identity: { module: "mini-lilac-transport.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "global", exportName: "ReadableStream controller" },
        direction: "signal-host" as const,
        reason:
          "Signals a typed stream or cleanup failure through the ReadableStream host contract.",
      })),
      ...["parseMiniLilacStream.pull", "parseMiniLilacStream.transform"].map((exportName) => ({
        identity: { module: "mini-lilac-transport.ts", exportName },
        category: "compatibility" as const,
        externalApi: { package: "global", exportName: "ReadableStream source" },
        direction: "capture-external" as const,
        reason: "Contains an immediate source or transform rejection at the stream host boundary.",
      })),
      ...["parseMiniLilacStream.transform"].map((exportName) => ({
        identity: { module: "mini-lilac-transport.ts", exportName },
        category: "defect-supervisor" as const,
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic" as const,
        reason: "Preserves Panic across stream transformation, result delivery, and cleanup.",
      })),
    ],
  ],
]);

const EVENT_BUS_CODEC_REGISTRY: EventCodecRegistryRegistration = {
  identity: { module: "lilac-codecs.ts", exportName: "lilacEventCodecRegistry" },
  catalog: { module: "lilac-spec.ts", exportName: "LILAC_EVENTS" },
  catalogHelper: { module: "define-lilac-events.ts", exportName: "defineLilacEvents" },
  registryHelper: {
    module: "define-lilac-events.ts",
    exportName: "createLilacEventCodecRegistry",
  },
};

const TUI_TOOL_CODEC_REGISTRY: ToolCodecRegistryRegistration = {
  identity: {
    module: "src/tool-observation-projection.ts",
    exportName: "toolObservationCodecRegistry",
  },
  aliases: [
    {
      module: "src/tool-observation-projection.ts",
      exportName: "knownToolCodecRegistry",
    },
  ],
  canonicalTools: {
    package: "@stanley2058/mini-lilac-client",
    module: "tool-catalog.ts",
    exportName: "MINI_LILAC_TOOL_NAMES",
  },
};

const TUI_RESULT_DECODER: ResultDecoderRegistration = {
  identity: {
    module: "src/tool-observation-projection.ts",
    exportName: "decodeKnownToolObservation",
  },
  category: "projection",
  inputParameter: 0,
};

const WAVE_2_RESULT_DECODERS = new Map<string, readonly ResultDecoderRegistration[]>([
  [
    "packages/claude-code-bridge",
    [
      {
        identity: { module: "claude-code-run.ts", exportName: "decodeClaudeContextUsage" },
        category: "plugin",
        inputParameter: 0,
      },
      {
        identity: { module: "claude-code-run.ts", exportName: "decodeClaudeStopHookInput" },
        category: "plugin",
        inputParameter: 0,
      },
      {
        identity: { module: "claude-code-run.ts", exportName: "decodeClaudeSessionInfo" },
        category: "plugin",
        inputParameter: 0,
      },
    ],
  ],
  [
    "packages/utils",
    ["parseFriendlyByteSizeResult", "parseFriendlyDurationMsResult"].map((exportName) => ({
      identity: { module: "friendly-units.ts", exportName },
      category: "request" as const,
      inputParameter: 0,
    })),
  ],
]);

const UTILS_CODEX_TOKENS_PERSISTED_CODEC = {
  identity: { module: "codex-oauth.ts", exportName: "decodeCodexTokens" },
  inputParameter: 0,
  fixtureCatalog: { module: "codex-oauth.ts", exportName: "codexTokensCodecCases" },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const UTILS_CODEX_TOKENS_PERSISTED_CONSUMER = {
  identity: { module: "codex-oauth.ts", exportName: "readCodexTokensResult" },
  codecs: [UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const ACP_RUN_RECORD_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeRunRecord" },
  inputParameter: 0,
  fixtureCatalog: { module: "run-store.ts", exportName: "runRecordCodecCases" },
  provenance: ["current", "migrated"],
} as const satisfies PersistedCodecRegistration;

const ACP_RUN_CANCELLATION_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeRunCancellation" },
  inputParameter: 0,
  fixtureCatalog: { module: "run-store.ts", exportName: "runCancellationCodecCases" },
  provenance: ["current", "migrated"],
} as const satisfies PersistedCodecRegistration;

const ACP_SESSION_INDEX_PERSISTED_CODEC = {
  identity: { module: "run-store.ts", exportName: "decodeSessionIndex" },
  inputParameter: 0,
  fixtureCatalog: { module: "run-store.ts", exportName: "sessionIndexCodecCases" },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const ACP_PERSISTED_CONSUMERS = [
  {
    identity: { module: "run-store.ts", exportName: "loadRunRecord" },
    codecs: [ACP_RUN_RECORD_PERSISTED_CODEC.identity],
  },
  {
    identity: { module: "run-store.ts", exportName: "loadRunCancellation" },
    codecs: [ACP_RUN_CANCELLATION_PERSISTED_CODEC.identity],
  },
  {
    identity: { module: "run-store.ts", exportName: "loadSessionIndex" },
    codecs: [ACP_SESSION_INDEX_PERSISTED_CODEC.identity],
  },
] as const satisfies readonly PersistedStoreConsumerRegistration[];

const TUI_BINDING_PREFERENCES_PERSISTED_CODEC = {
  identity: { module: "src/preferences.ts", exportName: "decodeBindingPreferences" },
  inputParameter: 0,
  fixtureCatalog: { module: "src/preferences.ts", exportName: "bindingPreferencesCodecCases" },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const TUI_BINDING_PREFERENCES_PERSISTED_CONSUMER = {
  identity: { module: "src/preferences.ts", exportName: "loadBindingPreferences" },
  codecs: [TUI_BINDING_PREFERENCES_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const WAVE_3_OPERATIONAL_RESULT_APIS = new Map<string, readonly SymbolIdentity[]>([
  [
    "apps/acp-controller",
    [
      ["external-adapters.ts", "captureExternal"],
      ...[
        "decodeRunRecord",
        "decodeRunCancellation",
        "decodeSessionIndex",
        "saveRunRecord",
        "saveWorkerRunRecord",
        "commitRunCancellationRequest",
        "requestRunCancellation",
        "observeRunCancellation",
        "loadRunCancellation",
        "loadRunRecord",
        "loadSessionIndex",
        "upsertSessionIndexEntries",
        "setLocalSessionTitle",
      ].map((exportName) => ["run-store.ts", exportName]),
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac",
    [
      ["build.ts", "captureBuildOperation"],
      ["build.ts", "decodeSourcePackage"],
      ["build.ts", "buildMiniLilac"],
      ["install-local.ts", "captureInstallOperation"],
      ["install-local.ts", "decodeNpmPackOutput"],
      ["install-local.ts", "installLocalPackage"],
      ["src/main.ts", "captureCommand"],
      ["src/main.ts", "runMiniLilac"],
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac-server",
    [
      ...[
        "captureServerOperation",
        "captureServerCleanup",
        "acquireDatabaseLockResult",
        "shutdownMiniLilacServerResult",
        "shutdownMiniLilacServerAndReleaseLockResult",
        "runServeCommand",
        "decodeMiniLilacCliOptions",
        "captureNodeCliParsing",
        "parseCliArgsResult",
        "canonicalWorkspaceResult",
        "runHistoryRecoveryCommandResult",
        "initializeMiniLilacStateResult",
        "runAuthCommandResult",
        "mainResult",
      ].map((exportName) => ["src/main.ts", exportName]),
      ...[
        "decodeMiniLilacHttpRequest",
        "decodeMiniLilacUiMessages",
        "adaptMiniLilacPersistenceResult",
        "captureHttpOperation",
        "captureSessionCreation",
        "canonicalDirectory",
      ].map((exportName) => ["src/server.ts", exportName]),
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/mini-lilac-tui",
    [
      ["src/cli.ts", "parseCliOptions"],
      ["src/clipboard.ts", "spawnClipboardCommand"],
      ["src/clipboard.ts", "openClipboardFile"],
      ["src/clipboard.ts", "statClipboardFile"],
      ["src/clipboard.ts", "readClipboardFile"],
      ["src/clipboard.ts", "closeClipboardFile"],
      ["src/clipboard.ts", "runAppleScript"],
      ["src/clipboard.ts", "removeClipboardFile"],
      ["src/clipboard.ts", "readClipboardImage"],
      ["src/preferences.ts", "decodeBindingPreferences"],
      ["src/preferences.ts", "bindingPreferencesFileExists"],
      ["src/preferences.ts", "readBindingPreferencesFile"],
      ["src/preferences.ts", "createBindingPreferencesDirectory"],
      ["src/preferences.ts", "writeBindingPreferencesFile"],
      ["src/preferences.ts", "renameBindingPreferencesFile"],
      ["src/preferences.ts", "removeTemporaryBindingPreferences"],
      ["src/preferences.ts", "loadBindingPreferences"],
      ["src/preferences.ts", "saveBindingPreferences"],
      ["src/startup.ts", "verifySessionCwd"],
      ["src/terminal-runtime-adapter.ts", "createTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "readTerminalPalette"],
      ["src/terminal-runtime-adapter.ts", "setTerminalBackground"],
      ["src/terminal-runtime-adapter.ts", "renderTerminalApp"],
      ["src/terminal-runtime-adapter.ts", "destroyTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "resolveTerminalShutdownOutcome"],
      ["src/terminal-runtime-adapter.ts", "runWithOwnedTerminalRenderer"],
      ["src/terminal-runtime-adapter.ts", "runTerminalEntrypoint"],
      ["src/terminal-stream-adapter.ts", "readTerminalStream"],
      ["src/terminal-stream-adapter.ts", "cancelTerminalStream"],
      ["src/terminal-stream-adapter.ts", "releaseTerminalStreamLock"],
    ].map(([module, exportName]) => ({ module, exportName })),
  ],
  [
    "apps/tool-bridge",
    [
      "decodeListPayload",
      "decodeCallableIdListPayload",
      "decodeToolHelpPayload",
      "decodeToolCallPayload",
      "decodeBackendVersionPayload",
      "decodeOnboardingGpgGenerate",
      "decodeOnboardingGpgExport",
      "decodeJsonText",
      "decodeJsonObject",
    ].map((exportName) => ({ module: "client.ts", exportName })),
  ],
  [
    "packages/agent",
    [
      { module: "atomic-tool-execution.ts", exportName: "consumeAtomicToolResultStream" },
      { module: "atomic-tool-execution.ts", exportName: "cleanupFailedAtomicToolCall" },
      { module: "openai-server-compaction.ts", exportName: "compactWithOpenAIResponsesResult" },
    ],
  ],
]);

const TUI_UNKNOWN_FREE_MODULES = [
  { module: "src/render.ts" },
  { module: "src/transcript-buffer.ts" },
] as const satisfies readonly UnknownFreeModuleRegistration[];

const CORE_THREAD_PERSISTED_CODECS = [
  {
    identity: {
      module: "src/conversation/thread-summary-persistence-codec.ts",
      exportName: "decodeConversationThreadSummaryRow",
    },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/conversation/thread-summary-persistence-codec.ts",
      exportName: "conversationThreadSummaryRowCodecCases",
    },
    provenance: ["current", "migrated", "missing-defaulted"],
  },
] as const satisfies readonly PersistedCodecRegistration[];

const CORE_THREAD_PERSISTED_CONSUMERS = [
  "ConversationThreadStore.getSummary",
  "ConversationThreadStore.search",
  "ConversationThreadStore.searchSemantic",
].map(
  (exportName): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/conversation/thread-store.ts", exportName },
    codecs: [CORE_THREAD_PERSISTED_CODECS[0].identity],
  }),
);

const CORE_TRANSCRIPT_PERSISTED_CODECS = [
  ["decodeTranscriptCompactionContext", "transcriptCompactionContextCodecCases"],
  ["decodeTranscriptProviderState", "transcriptProviderStateCodecCases"],
  ["decodeTranscriptRow", "transcriptRowCodecCases"],
  ["decodeCoreSurfaceProjectionRow", "coreSurfaceProjectionRowCodecCases"],
  ["decodeCoreLineageManifestRow", "coreLineageManifestRowCodecCases"],
].map(
  ([exportName, fixtureExportName]): PersistedCodecRegistration => ({
    identity: { module: "src/transcript/transcript-persistence-codec.ts", exportName },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/transcript/transcript-persistence-codec.ts",
      exportName: fixtureExportName,
    },
    provenance: ["current", "migrated", "missing-defaulted"],
  }),
);

const CORE_TRANSCRIPT_PERSISTED_CONSUMERS = [
  ["decodeTranscriptCompactionContext", [0]],
  ["decodeTranscriptProviderState", [1]],
  ["decodeTranscriptRow", [2]],
  ["decodeCoreSurfaceProjectionRow", [3]],
  ["decodeCoreLineageManifestRow", [4]],
].map(
  ([exportName, codecIndexes]): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/transcript/transcript-store.ts", exportName: String(exportName) },
    codecs: (codecIndexes as number[]).map(
      (index) => CORE_TRANSCRIPT_PERSISTED_CODECS[index]!.identity,
    ),
  }),
);

const CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC = {
  identity: {
    module: "src/workflow/workflow-artifact-persistence-codec.ts",
    exportName: "decodeWorkflowValueArtifact",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/workflow/workflow-artifact-persistence-codec.ts",
    exportName: "workflowValueArtifactCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const CORE_WORKFLOW_ROW_PERSISTED_CODEC = {
  identity: {
    module: "src/workflow/workflow-persistence-codec.ts",
    exportName: "decodeWorkflowPersistenceRow",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/workflow/workflow-persistence-codec.ts",
    exportName: "workflowPersistenceRowCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
  missingOutcomes: {
    revision: "missing-rejected",
    run: "missing-rejected",
    operation: "missing-rejected",
    wait: "missing-rejected",
    trigger: "missing-rejected",
    binding: "missing-rejected",
    action: "missing-defaulted",
    dispatch: "missing-rejected",
    receipt: "missing-rejected",
    outbox: "missing-rejected",
    "legacy-audit": "missing-rejected",
  },
} as const satisfies PersistedCodecRegistration;

const CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS = [
  "decodeWorkflowRevisionRow",
  "decodeWorkflowRunRow",
  "decodeWorkflowOperationRow",
  "decodeWorkflowWaitRow",
  "decodeWorkflowTriggerRow",
  "decodeWorkflowSurfaceBindingRow",
  "decodeWorkflowSurfaceActionRow",
  "decodeWorkflowRequestDispatchRow",
  "decodeWorkflowRequestTerminalReceiptRow",
  "decodeWorkflowActionOutboxRow",
].map(
  (exportName): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/workflow/durable-workflow-store.ts", exportName },
    codecs: [CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity],
  }),
);

const CORE_WORKFLOW_STORE_READ_RESULT_APIS = [
  "captureWorkflowRead",
  "DurableWorkflowStore.getRevision",
  "DurableWorkflowStore.findRevisionByIdentity",
  "DurableWorkflowStore.listRevisions",
  "DurableWorkflowStore.getRun",
  "DurableWorkflowStore.listRuns",
  "DurableWorkflowStore.listActiveRuns",
  "DurableWorkflowStore.listRunsNeedingProjectionReconciliation",
  "DurableWorkflowStore.listActiveLiveParentRuns",
  "DurableWorkflowStore.listPendingLiveParentCompletions",
  "DurableWorkflowStore.getOperation",
  "DurableWorkflowStore.getOperationByRequestId",
  "DurableWorkflowStore.getWorkflowRequestTerminalReceipt",
  "DurableWorkflowStore.getWorkflowRequestDispatchPolicy",
  "DurableWorkflowStore.listOperations",
  "DurableWorkflowStore.listRecentMeaningfulOperations",
  "DurableWorkflowStore.getWait",
  "DurableWorkflowStore.listWaits",
  "DurableWorkflowStore.listActiveWaitsByMatchKey",
  "DurableWorkflowStore.listDueWaits",
  "DurableWorkflowStore.getTrigger",
  "DurableWorkflowStore.getTriggerByLastRunId",
  "DurableWorkflowStore.listTriggers",
  "DurableWorkflowStore.getSurfaceBinding",
  "DurableWorkflowStore.listSurfaceBindings",
  "DurableWorkflowStore.getSurfaceAction",
  "DurableWorkflowStore.getSurfaceActionByTokenSha256",
  "DurableWorkflowStore.listSurfaceActions",
  "DurableWorkflowStore.listPendingActionOutboxEvents",
  "DurableWorkflowStore.listPendingActionOutboxProjections",
].map((exportName) => ({ module: "src/workflow/durable-workflow-store.ts", exportName }));

const CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER = {
  identity: {
    module: "src/workflow/workflow-artifact-store.ts",
    exportName: "readWorkflowValueArtifact",
  },
  codecs: [CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const TOOL_RESULT_ARTIFACT_METADATA_CODEC = {
  identity: {
    module: "src/tool-result-artifact-metadata-codec.ts",
    exportName: "decodeToolResultArtifactMetadata",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/tool-result-artifact-metadata-codec.ts",
    exportName: "toolResultArtifactMetadataCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const TOOL_RESULT_ARTIFACT_METADATA_CONSUMER = {
  identity: {
    module: "src/tool-result-artifact-store.ts",
    exportName: "createToolResultArtifactStore.readMetadata",
  },
  codecs: [TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_GRACEFUL_RESTART_PERSISTED_CODEC = {
  identity: {
    module: "src/runtime/graceful-restart-store.ts",
    exportName: "decodeGracefulRestartSnapshot",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/runtime/graceful-restart-store.ts",
    exportName: "gracefulRestartSnapshotCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER = {
  identity: {
    module: "src/runtime/graceful-restart-store.ts",
    exportName: "SqliteGracefulRestartStore.readCompletedSnapshot",
  },
  codecs: [CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_GRACEFUL_RESTART_ENCODER_CONSUMER = {
  identity: {
    module: "src/runtime/graceful-restart-store.ts",
    exportName: "encodeGracefulRestartSnapshot",
  },
  codecs: [CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_WORKSPACE_HISTORY_PERSISTED_CODECS = (
  [
    [
      "decodeWorkspaceHistoryOwnership",
      "workspaceHistoryOwnershipCodecCases",
      ["current", "migrated"],
    ],
    [
      "decodeWorkspaceHistorySnapshotManifest",
      "workspaceHistorySnapshotManifestCodecCases",
      ["current", "migrated"],
    ],
    [
      "decodeWorkspaceHistoryCaptureCache",
      "workspaceHistoryCaptureCacheCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistoryRestorePlan",
      "workspaceHistoryRestorePlanCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistorySnapshotRefCreated",
      "workspaceHistorySnapshotRefCreatedCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
    [
      "decodeWorkspaceHistoryRestoreOwnership",
      "workspaceHistoryRestoreOwnershipCodecCases",
      ["current", "migrated", "missing-defaulted"],
    ],
  ] as const
).map(
  ([exportName, fixtureExportName, provenance]): PersistedCodecRegistration => ({
    identity: { module: "src/workspace-history-persistence-codec.ts", exportName },
    inputParameter: 0,
    fixtureCatalog: {
      module: "src/workspace-history-persistence-codec.ts",
      exportName: fixtureExportName,
    },
    provenance,
  }),
);

const MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS = (
  [
    ["WorkspaceHistoryStore.decodeOwnership", 0],
    ["WorkspaceHistoryStore.decodeSnapshotManifest", 1],
    ["WorkspaceHistoryStore.readCaptureCache", 2],
    ["WorkspaceHistoryStore.decodeRestorePlan", 3],
    ["WorkspaceHistoryStore.decodeSnapshotRefCreationMetadata", 4],
    ["WorkspaceHistoryStore.decodeRestoreOwnership", 5],
  ] as const
).map(
  ([exportName, codecIndex]): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/workspace-history-store.ts", exportName },
    codecs: [MINI_WORKSPACE_HISTORY_PERSISTED_CODECS[codecIndex]!.identity],
  }),
);

const MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS = [
  ["decodeMiniLilacModelTranscript", "miniLilacModelTranscriptCodecCases"],
  ["decodeMiniLilacUiTranscript", "miniLilacUiTranscriptCodecCases"],
  ["decodeMiniLilacCommandRequest", "miniLilacCommandRequestCodecCases"],
].map(
  ([exportName, fixtureExportName]): PersistedCodecRegistration => ({
    identity: { module: "src/sqlite-persistence-codec.ts", exportName },
    inputParameter: 0,
    fixtureCatalog: { module: "src/sqlite-persistence-codec.ts", exportName: fixtureExportName },
    provenance: ["current", "migrated", "missing-defaulted"],
  }),
);

const MINI_SQLITE_TODO_PERSISTED_CODEC = {
  identity: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "decodeMiniLilacTodos",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "miniLilacTodosCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const MINI_SQLITE_TODO_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "readMiniLilacTodos",
  },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER = {
  identity: { module: "src/sqlite-store.ts", exportName: "decodeMiniLilacTodos" },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC = {
  identity: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRow",
  },
  inputParameter: 0,
  fixtureCatalog: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "miniLilacStructuralHistoryRowCodecCases",
  },
  provenance: ["current", "migrated", "missing-defaulted"],
} as const satisfies PersistedCodecRegistration;

const MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER = {
  identity: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacMigrationRunRow",
  },
  category: "persistence",
  inputParameter: 0,
} as const satisfies ResultDecoderRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "MiniLilacSqliteStore.decodeStructuralHistoryRow",
  },
  codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_ROWS_PERSISTED_CONSUMERS = [
  {
    identity: {
      module: "src/sqlite-history-persistence-codec.ts",
      exportName: "decodeMiniLilacStructuralHistoryRows",
    },
    codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
  },
] as const satisfies readonly PersistedStoreConsumerRegistration[];

const MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER = {
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "readMiniLilacHistoryRecoveryStatusResult",
  },
  codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS = (
  [
    ["decodeMiniLilacModelTranscript", [0]],
    ["decodeMiniLilacUiTranscript", [1]],
  ] as const
).map(
  ([exportName, codecIndexes]): PersistedStoreConsumerRegistration => ({
    identity: { module: "src/sqlite-store.ts", exportName },
    codecs: codecIndexes.map((index) => MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS[index]!.identity),
  }),
);

const MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES = [
  ...[
    "decodePlainJson",
    "decodeSuperJson",
    "decodeTranscript",
    "decodeMiniLilacDatabaseVersion",
    "migrateMiniLilacUiMessageValue",
    "decodeMiniLilacTranscriptChain",
    "decodeMiniLilacMigrationTranscriptRows",
    "decodeMiniLilacMigrationUiTranscript",
    "decodeMiniLilacMigrationUserUiMessage",
    "decodeMiniLilacMigrationModelPrefix",
    "decodeMiniLilacMigrationUiPrefix",
    "decodeMiniLilacModelTranscript",
    "decodeMiniLilacUiTranscript",
    "decodeMiniLilacHistoryUserMessage",
    "decodeMiniLilacCommandRequest",
    "decodeMiniLilacSteeringCommandRequest",
    "decodeMiniLilacSuperJsonPayload",
    "decodeMiniMainClaudeBindingPromotion",
    "decodeMiniNamedClaudeBindingPromotion",
  ].map((exportName) => ({ module: "src/sqlite-persistence-codec.ts", exportName })),
  {
    module: "src/sqlite-transcript-projection.ts",
    exportName: "validateMiniLilacPersistedSuperJsonValue",
  },
  {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRow",
  },
  {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacStructuralHistoryRows",
  },
  MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER.identity,
];

const MINI_SQLITE_STORE_RESULT_APIS = [
  "MiniLilacSqliteStore.decodeStructuralHistoryRow",
  "MiniLilacSqliteStore.decodeStructuralHistoryRows",
  "MiniLilacSqliteStore.getTodosResult",
  "MiniLilacSqliteStore.getModelMessagesResult",
  "MiniLilacSqliteStore.getModelTranscriptResult",
  "MiniLilacSqliteStore.getUiMessagesResult",
  "MiniLilacSqliteStore.getUiTranscriptResult",
  "MiniLilacSqliteStore.getHistoryStoreMetadataResult",
  "MiniLilacSqliteStore.getWorkspaceForSessionResult",
  "MiniLilacSqliteStore.listWorkspacesResult",
  "MiniLilacSqliteStore.listWorkspaceSnapshotsResult",
  "MiniLilacSqliteStore.listWorkspaceSnapshotGroupsResult",
  "MiniLilacSqliteStore.getWorkspaceSnapshotResult",
  "MiniLilacSqliteStore.getHistoryStateResult",
  "MiniLilacSqliteStore.getHistoryStateModelMessagesResult",
  "MiniLilacSqliteStore.getHistoryStateUiMessagesResult",
  "MiniLilacSqliteStore.getCurrentHistoryStateResult",
  "MiniLilacSqliteStore.getSessionHistoryResult",
  "MiniLilacSqliteStore.getHistoryNavigationResult",
  "MiniLilacSqliteStore.findLatestUndoableUserTransitionResult",
  "MiniLilacSqliteStore.peekHistoryRedoResult",
  "MiniLilacSqliteStore.listHistoryTopologyResult",
  "MiniLilacSqliteStore.getHistoryAccountingResult",
  "MiniLilacSqliteStore.getHistoryOperationResult",
  "MiniLilacSqliteStore.listHistoryOperationsResult",
  "MiniLilacSqliteStore.getPendingRunFinalizationResult",
  "MiniLilacSqliteStore.listPendingRunFinalizationsResult",
  "MiniLilacSqliteStore.listRecoverableOpenRootRunsResult",
  "MiniLilacSqliteStore.getHistoryTransitionResult",
  "readMiniLilacHistoryRecoveryStatusResult",
].map((exportName) => ({ module: "src/sqlite-store.ts", exportName }));

const MINI_SESSION_SERVICE_RESULT_APIS = [
  "SessionService.capturePersistenceResult",
  "SessionService.capturePersistencePromise",
  "SessionService.createSessionResult",
  "SessionService.getSnapshotResult",
  "SessionService.listSessionsResult",
  "SessionService.getMessagesResult",
  "SessionService.getSessionResumeResult",
  "SessionService.getTodosResult",
  "SessionService.getRunResult",
  "SessionService.startPromptResult",
  "SessionService.replayRunResult",
  "SessionService.steerResult",
  "SessionService.interruptQueuedSteeringResult",
  "SessionService.cancelResult",
  "SessionService.undoResult",
  "SessionService.redoResult",
  "SessionService.compactResult",
  "SessionService.cancelCompactionResult",
  "SessionService.updateSessionBindingsResult",
].map((exportName) => ({ module: "src/session-service.ts", exportName }));

const MINI_RUNTIME_OPERATIONAL_RESULT_APIS = [
  ...["decodeRuntimeConfig", "decodeRuntimeConfigYaml", "loadRuntimeConfigResult"].map(
    (exportName) => ({ module: "src/config.ts", exportName }),
  ),
  ...[
    "decodeProviderConfig",
    "decodeProviderAuth",
    "decodeProviderConfigYaml",
    "loadProviderConfigResult",
    "loadProviderAuthResult",
    "writeProviderAuthResult",
    "createAiProviderRegistryResult",
    "loadProviderRegistryResult",
  ].map((exportName) => ({ module: "src/providers.ts", exportName })),
  ...[
    "parseModelRefResult",
    "resolveLanguageModelResult",
    "ModelCatalog.getResult",
    "createModelCatalogResult",
  ].map((exportName) => ({ module: "src/model-catalog.ts", exportName })),
  ...["MiniLilacSkillCatalogSnapshot.loadResult", "MiniLilacSkillCatalog.discoverResult"].map(
    (exportName) => ({ module: "src/skills.ts", exportName }),
  ),
  ...["decodeWebfetchInput", "executeWebfetchResult"].map((exportName) => ({
    module: "src/webfetch.ts",
    exportName,
  })),
  {
    module: "src/workspace-history-store.ts",
    exportName: "createWorkspaceHistoryStore",
  },
  ...[
    "WorkspaceHistoryStore.capabilityResult",
    "WorkspaceHistoryStore.withWorkspaceLockResult",
    "WorkspaceHistoryStore.withWorkspaceLockOutcome.withStoreLock.<callback@2>.captureResult",
    "WorkspaceHistoryStore.withWorkspaceLockOutcome.withStoreLock.<callback@2>.lockedStore.invalidateCaptureCacheResult",
    "WorkspaceHistoryStore.captureResult",
    "WorkspaceHistoryStore.restoreResult",
    "WorkspaceHistoryStore.resumeRestoreResult",
    "WorkspaceHistoryStore.deleteRestorePlanResult",
    "WorkspaceHistoryStore.cleanupRestorePlansResult",
    "WorkspaceHistoryStore.verifySnapshotResult",
    "WorkspaceHistoryStore.objectExistsResult",
    "WorkspaceHistoryStore.reconcileSnapshotRefResult",
    "WorkspaceHistoryStore.reconcileExpectedSnapshotRefsResult",
    "WorkspaceHistoryStore.cleanupOrphanSnapshotRefsResult",
    "WorkspaceHistoryStore.getObjectAccountingResult",
    "WorkspaceHistoryStore.runMaintenanceResult",
    "WorkspaceHistoryStore.cleanupStaleRestoreArtifactsResult",
  ].map((exportName) => ({ module: "src/workspace-history-store.ts", exportName })),
] as const satisfies readonly SymbolIdentity[];

const UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY = {
  package: "@stanley2058/lilac-utils",
  module: "persistence.ts",
  exportName: "runBunSqliteTransaction",
} as const satisfies PackageSymbolIdentity;

const CORE_SQLITE_TRANSACTION_CONSUMERS = [
  {
    module: "src/conversation/thread-store.ts",
    exportName: "ConversationThreadStore.upsertSummary",
  },
  {
    module: "src/transcript/transcript-store.ts",
    exportName: "SqliteTranscriptStore.saveRequestTranscript",
  },
  ...[
    "SqliteTranscriptStore.admitCoreSurfaceProjection",
    "SqliteTranscriptStore.saveCorePrimaryLineageManifest",
    "SqliteTranscriptStore.unlinkSurfaceMessage",
    "SqliteTranscriptStore.deleteUnlinkedCheckpointCandidate",
    "SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt",
    "SqliteTranscriptStore.recordCoreNamedClaudeSessionAttemptOutcome",
    "SqliteTranscriptStore.publishCoreNamedClaudeSuccess",
    "SqliteTranscriptStore.promoteCoreNamedClaudeSessionBinding",
    "SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt",
    "SqliteTranscriptStore.recordCorePrimaryClaudeSessionAttemptOutcome",
    "SqliteTranscriptStore.publishCorePrimaryClaudeSuccess",
    "SqliteTranscriptStore.promoteCorePrimaryClaudeSessionBinding",
  ].map((exportName) => ({
    module: "src/transcript/transcript-store.ts",
    exportName,
  })),
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.createInvocation",
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.applySurfaceAction",
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "runWorkflowTransaction",
  },
  {
    module: "src/workflow/workflow-migrations.ts",
    exportName: "applyWorkflowSchemaMigrations",
  },
  ...[
    "SqliteGracefulRestartStore.clear",
    "SqliteGracefulRestartStore.consumeCompletedSnapshot",
    "SqliteGracefulRestartStore.readCompletedSnapshot",
    "SqliteGracefulRestartStore.saveCompletedSnapshot",
  ].map((exportName) => ({
    module: "src/runtime/graceful-restart-store.ts",
    exportName,
  })),
].map(
  (identity): SqliteTransactionConsumerRegistration => ({
    identity,
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  }),
);

const MINI_SQLITE_TRANSACTION_CONSUMERS = [
  {
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.initializeSchemaResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
  {
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.runStoreTransactionResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
] as const satisfies readonly SqliteTransactionConsumerRegistration[];

const CORE_EVENT_DELIVERY_CONSUMERS = [
  {
    identity: {
      module: "src/heartbeat/heartbeat-service.ts",
      exportName: "startHeartbeatServiceResult.startHeartbeatLifecycleResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/bridge/bus-agent-runner.ts",
      exportName: "startBusAgentRunner",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/discord/discord-request-router.ts",
      exportName: "startDiscordRequestRouter",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/surface/bridge/subscribe-from-bus.ts",
      exportName: "bridgeBusToAdapter",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-action-resolver.ts",
      exportName: "startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-engine.ts",
      exportName: "WorkflowEngine.startWakeSubscription",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-engine.ts",
      exportName: "WorkflowEngine.waitForAgentRequest",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic", "fetchTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.start",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.ensureChildOutputSubscription",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-live-parent-bridge.ts",
      exportName: "WorkflowLiveParentBridge.reconcileTerminalChildActivity",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["fetchTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-progress-projector.ts",
      exportName: "WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/workflow/workflow-wait-resolver.ts",
      exportName: "WorkflowWaitResolver.startWorkflowWaitSubscriptionResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
] as const satisfies readonly EventDeliveryConsumerRegistration[];

const ARCHITECTURE_WORKSPACES = ACTIVE_WORKSPACES.map(([root, packageName]) => {
  const ruleZones: WorkspaceArchitecture["ruleZones"] = {
    ...EMPTY_POLICY.ruleZones,
    "architecture/open-protocol-normalization": OPEN_PROTOCOL_RULE_ZONES.get(root) ?? [],
    "architecture/complete-event-codec-registry":
      root === "packages/event-bus" ? [{ include: "lilac-codecs.ts" }] : [],
    "architecture/complete-tool-codec-registry":
      root === "apps/mini-lilac-tui" ? [{ include: "src/tool-observation-projection.ts" }] : [],
    "architecture/result-decoder-contract":
      root === "apps/mini-lilac-tui"
        ? [{ include: "src/tool-observation-projection.ts" }]
        : root === "packages/mini-lilac-runtime"
          ? [{ include: MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER.identity.module }]
          : [
              ...new Set(
                (WAVE_2_RESULT_DECODERS.get(root) ?? []).map(({ identity }) => identity.module),
              ),
            ].map((include) => ({ include })),
    "architecture/unknown-free-module":
      root === "apps/mini-lilac-tui"
        ? TUI_UNKNOWN_FREE_MODULES.map(({ module }) => ({ include: module }))
        : [],
    "architecture/persisted-codec-contract":
      root === "apps/acp-controller"
        ? [{ include: "run-store.ts" }]
        : root === "apps/mini-lilac-tui"
          ? [{ include: "src/preferences.ts" }]
          : root === "packages/tool-results"
            ? [
                { include: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module },
                { include: TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity.module },
              ]
            : root === "apps/core"
              ? [
                  { include: "src/conversation/thread-summary-persistence-codec.ts" },
                  { include: "src/conversation/thread-store.ts" },
                  { include: "src/transcript/transcript-persistence-codec.ts" },
                  { include: "src/transcript/transcript-store.ts" },
                  { include: "src/runtime/graceful-restart-store.ts" },
                  { include: "src/workflow/workflow-artifact-persistence-codec.ts" },
                  { include: "src/workflow/workflow-persistence-codec.ts" },
                  { include: "src/workflow/workflow-artifact-store.ts" },
                  { include: "src/workflow/durable-workflow-store.ts" },
                ]
              : root === "packages/mini-lilac-runtime"
                ? [
                    { include: "src/workspace-history-persistence-codec.ts" },
                    { include: "src/workspace-history-store.ts" },
                    { include: "src/sqlite-persistence-codec.ts" },
                    { include: "src/sqlite-history-persistence-codec.ts" },
                    { include: "src/sqlite-store.ts" },
                    { include: "src/sqlite-todo-persistence-codec.ts" },
                  ]
                : root === "packages/utils"
                  ? [
                      { include: UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity.module },
                      { include: UTILS_CODEX_TOKENS_PERSISTED_CONSUMER.identity.module },
                    ]
                  : [],
    "architecture/persisted-codec-fixture-catalog":
      root === "apps/acp-controller"
        ? [{ include: "run-store.ts" }]
        : root === "apps/mini-lilac-tui"
          ? [{ include: "src/preferences.ts" }]
          : root === "packages/tool-results"
            ? [{ include: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module }]
            : root === "apps/core"
              ? [
                  { include: "src/conversation/thread-summary-persistence-codec.ts" },
                  { include: "src/transcript/transcript-persistence-codec.ts" },
                  { include: "src/runtime/graceful-restart-store.ts" },
                  { include: "src/workflow/workflow-artifact-persistence-codec.ts" },
                  { include: "src/workflow/workflow-persistence-codec.ts" },
                ]
              : root === "packages/mini-lilac-runtime"
                ? [
                    { include: "src/workspace-history-persistence-codec.ts" },
                    { include: "src/sqlite-persistence-codec.ts" },
                    { include: "src/sqlite-history-persistence-codec.ts" },
                    { include: "src/sqlite-todo-persistence-codec.ts" },
                  ]
                : root === "packages/utils"
                  ? [{ include: UTILS_CODEX_TOKENS_PERSISTED_CODEC.identity.module }]
                  : [],
    "architecture/sqlite-transaction-adapter-contract":
      root === "packages/utils" ? [{ include: "persistence.ts" }] : [],
    "architecture/sqlite-transaction-consumer":
      root === "apps/core"
        ? [
            ...new Set(CORE_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity.module)),
          ].map((include) => ({ include }))
        : root === "packages/mini-lilac-runtime"
          ? [
              ...new Set(MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity.module)),
            ].map((include) => ({ include }))
          : [],
    "architecture/no-result-err-in-sqlite-callback":
      root === "apps/core"
        ? [
            { include: "src/conversation/thread-store.ts" },
            { include: "src/runtime/graceful-restart-store.ts" },
            { include: "src/transcript/transcript-store.ts" },
            { include: "src/workflow/durable-workflow-store.ts" },
            { include: "src/workflow/workflow-migrations.ts" },
          ]
        : root === "packages/mini-lilac-runtime"
          ? [{ include: "src/sqlite-store.ts" }]
          : root === "packages/utils"
            ? [{ include: "persistence.ts" }]
            : [],
    "architecture/raw-event-message-boundary":
      root === "packages/event-bus"
        ? [{ include: "raw-bus.ts" }, { include: "redis-streams-bus.ts" }]
        : [],
    "architecture/event-handler-result":
      root === "packages/event-bus" ? [{ include: "lilac-bus.ts" }] : [],
    "architecture/event-delivery-policy-exhaustiveness":
      root === "packages/event-bus" ? [{ include: "event-delivery.ts" }] : [],
  };
  return {
    ...EMPTY_POLICY,
    ruleZones,
    eventCodecRegistries: root === "packages/event-bus" ? [EVENT_BUS_CODEC_REGISTRY] : [],
    toolCodecRegistries: root === "apps/mini-lilac-tui" ? [TUI_TOOL_CODEC_REGISTRY] : [],
    resultDecoders:
      root === "apps/mini-lilac-tui"
        ? [TUI_RESULT_DECODER]
        : root === "packages/mini-lilac-runtime"
          ? [MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER]
          : (WAVE_2_RESULT_DECODERS.get(root) ?? []),
    unknownFreeModules: root === "apps/mini-lilac-tui" ? TUI_UNKNOWN_FREE_MODULES : [],
    persistedCodecs:
      root === "apps/acp-controller"
        ? [
            ACP_RUN_RECORD_PERSISTED_CODEC,
            ACP_RUN_CANCELLATION_PERSISTED_CODEC,
            ACP_SESSION_INDEX_PERSISTED_CODEC,
          ]
        : root === "apps/mini-lilac-tui"
          ? [TUI_BINDING_PREFERENCES_PERSISTED_CODEC]
          : root === "packages/tool-results"
            ? [TOOL_RESULT_ARTIFACT_METADATA_CODEC]
            : root === "packages/utils"
              ? [UTILS_CODEX_TOKENS_PERSISTED_CODEC]
              : root === "apps/core"
                ? [
                    ...CORE_THREAD_PERSISTED_CODECS,
                    ...CORE_TRANSCRIPT_PERSISTED_CODECS,
                    CORE_GRACEFUL_RESTART_PERSISTED_CODEC,
                    CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC,
                    CORE_WORKFLOW_ROW_PERSISTED_CODEC,
                  ]
                : root === "packages/mini-lilac-runtime"
                  ? [
                      ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS,
                      ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS,
                      MINI_SQLITE_TODO_PERSISTED_CODEC,
                      MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC,
                    ]
                  : [],
    persistedStoreConsumers:
      root === "apps/acp-controller"
        ? ACP_PERSISTED_CONSUMERS
        : root === "apps/mini-lilac-tui"
          ? [TUI_BINDING_PREFERENCES_PERSISTED_CONSUMER]
          : root === "packages/tool-results"
            ? [TOOL_RESULT_ARTIFACT_METADATA_CONSUMER]
            : root === "packages/utils"
              ? [UTILS_CODEX_TOKENS_PERSISTED_CONSUMER]
              : root === "apps/core"
                ? [
                    ...CORE_THREAD_PERSISTED_CONSUMERS,
                    ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS,
                    CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER,
                    CORE_GRACEFUL_RESTART_ENCODER_CONSUMER,
                    CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER,
                    ...CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS,
                  ]
                : root === "packages/mini-lilac-runtime"
                  ? [
                      ...MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS,
                      ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS,
                      MINI_SQLITE_TODO_PERSISTED_CONSUMER,
                      MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER,
                      MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER,
                      ...MINI_SQLITE_STRUCTURAL_HISTORY_ROWS_PERSISTED_CONSUMERS,
                      MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER,
                    ]
                  : [],
    sqliteTransactionAdapters:
      root === "packages/utils"
        ? [
            {
              identity: { module: "persistence.ts", exportName: "runBunSqliteTransaction" },
              databaseParameter: 0,
              operationParameter: 1,
              rollbackSentinel: {
                module: "persistence.ts",
                exportName: "BunSqliteRollbackSentinel",
              },
              panicClassifier: { package: "better-result", exportName: "Panic.is" },
              driverErrorClassifier: {
                module: "persistence.ts",
                exportName: "classifyBunSqliteDriverFailure",
              },
            },
          ]
        : [],
    sqliteTransactionConsumers:
      root === "apps/core"
        ? CORE_SQLITE_TRANSACTION_CONSUMERS
        : root === "packages/mini-lilac-runtime"
          ? MINI_SQLITE_TRANSACTION_CONSUMERS
          : [],
    rawEventMessageBoundaries:
      root === "packages/event-bus"
        ? [
            {
              identity: { module: "raw-bus.ts", exportName: "RawBus.subscribe" },
              messageType: {
                package: "@stanley2058/lilac-event-bus",
                exportName: "Message",
              },
              handlerParameter: 2,
              messageParameter: 0,
              contextParameter: 1,
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe",
              },
              messageType: {
                package: "@stanley2058/lilac-event-bus",
                exportName: "Message",
              },
              handlerParameter: 2,
              messageParameter: 0,
              contextParameter: 1,
            },
          ]
        : [],
    eventDeliveryApis:
      root === "packages/event-bus"
        ? [
            {
              identity: { module: "lilac-bus.ts", exportName: "LilacBus.subscribeTopic" },
              handlerParameter: 2,
              handlerMessageParameter: 0,
              handlerContextParameter: 1,
              deliveryPolicy: {
                module: "event-delivery.ts",
                exportName: "applyEventDeliveryPolicy",
              },
              deliveryErrorParameter: 0,
            },
          ]
        : [],
    eventDeliveryConsumers: root === "apps/core" ? CORE_EVENT_DELIVERY_CONSUMERS : [],
    boundaryDecoders: [
      ...(root === "packages/plugin-runtime"
        ? ([
            ...[
              "ToolInputValidationError.constructor",
              "summarizeProvidedKeys",
              "isEmptyObjectInput",
              "formatToolValidationError",
              "decodeToolInput",
              "parseToolInput",
              "parseToolInputPreservingZodError",
            ].map((exportName) => ({
              identity: { module: "validation-error-message.ts", exportName },
              category: "request" as const,
            })),
            ...[
              "collectVariants",
              "conditionToText",
              "getObjectShape",
              "formatAggregatedFieldLine.<callback>",
              "mergeConditions",
              "extractLiteralValues",
              "renderType",
            ].map((exportName) => ({
              identity: { module: "zod-cli.ts", exportName },
              category: "plugin" as const,
            })),
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/event-bus"
        ? ([
            ...[
              "boundWireValue",
              "boundWireEvidence",
              "redisTransportEvidence",
              "decodeRedisFields",
              "decodeMessage",
              "RedisStreamsBus.subscribe.handleEntry",
            ].map((exportName) => ({
              identity: { module: "redis-streams-bus.ts", exportName },
              category: "wire" as const,
            })),
            ...["decodeSchema", "decodeKnownMessage"].map((exportName) => ({
              identity: { module: "lilac-codecs.ts", exportName },
              category: "wire" as const,
            })),
            ...[
              "decodeRedisEventDeadLetterCiphertextEnvelope",
              "decryptRedisEventDeadLetterRecord",
            ].map((exportName) => ({
              identity: { module: "redis-event-dead-letter.ts", exportName },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "lilac-spec.ts",
                exportName: "parseCmdRequestMessageData",
              },
              category: "wire" as const,
            },
            {
              identity: {
                module: "core-primary-lineage.ts",
                exportName: "decodeCorePrimaryLineageV1",
              },
              category: "projection" as const,
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/tool-results"
        ? ([
            {
              identity: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
              category: "persistence",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? ([
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS.map(({ identity }) => ({
              identity,
              category: "persistence" as const,
            })),
            ...MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES.map((identity) => ({
              identity,
              category: "persistence" as const,
            })),
            {
              identity: MINI_SQLITE_TODO_PERSISTED_CODEC.identity,
              category: "persistence" as const,
            },
            {
              identity: {
                module: "src/workspace-history-persistence-codec.ts",
                exportName: "detectFormatVersion",
              },
              category: "persistence" as const,
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(root === "apps/core"
        ? ([
            ...[
              "decodeConversationThreadStringArray",
              "decodeConversationThreadImportance",
              "decodeConversationThreadAboutness",
              "decodeConversationThreadSummaryRow",
            ].map((exportName) => ({
              identity: {
                module: "src/conversation/thread-summary-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            ...[
              "decodeSerialized",
              "decodeNormalizedMessagesValue",
              "decodeTranscriptMessages",
              "decodeTranscriptCompactionContext",
              "decodeTranscriptProviderState",
              "decodeTranscriptRow",
              "decodeCoreSurfaceProjectionRow",
              "decodeCoreLineageManifestRow",
            ].map((exportName) => ({
              identity: {
                module: "src/transcript/transcript-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "src/conversation/thread-materializer-worker.ts",
                exportName: "startConversationThreadMaterializer.postRequest",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/transcript/transcript-store.ts",
                exportName: "SqliteTranscriptStore.emitPersistenceDiagnosticsAfterTransaction",
              },
              category: "projection",
            },
            ...[
              ["src/conversation/thread-store.ts", "signalConversationThreadStoreDefect"],
              ["src/conversation/thread-store.ts", "ConversationThreadStore.loadVectorExtension"],
              ["src/conversation/thread-store.ts", "ConversationThreadStore.attachSurfaceDb"],
              [
                "src/conversation/thread-store.ts",
                "ConversationThreadStore.hasRequiredSurfaceTables",
              ],
              ["src/conversation/thread-service.ts", "signalConversationThreadDefect"],
              ["src/conversation/thread-service.ts", "classifyConversationThreadGenerationFailure"],
              ["src/conversation/thread-service.ts", "captureConversationThreadSqliteOperation"],
              ["src/conversation/thread-service.ts", "parseConversationThreadJson"],
              ["src/surface/bridge/bridge-log.ts", "formatBridgeTaggedErrorForLog"],
              ["src/surface/bridge/bus-agent-runner.ts", "formatBusAgentRunnerDrainFailureForLog"],
            ].map(([module, exportName]) => ({
              identity: { module, exportName },
              category: "projection" as const,
            })),
            {
              identity: CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity,
              category: "persistence",
            },
            {
              identity: {
                module: "src/runtime/graceful-restart-store.ts",
                exportName: "decodeOpaqueSuperJsonValue",
              },
              category: "persistence",
            },
            {
              identity: CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity,
              category: "persistence",
            },
            ...[
              "decodeJsonField",
              "decodeWorkflowRevisionRow",
              "decodeWorkflowRunRow",
              "decodeWorkflowOperationRow",
              "decodeWorkflowWaitRow",
              "decodeWorkflowTriggerRow",
              "decodeWorkflowSurfaceBindingRow",
              "decodeWorkflowSurfaceActionRow",
              "decodeWorkflowRequestDispatchRow",
              "decodeWorkflowRequestTerminalReceiptRow",
              "decodeWorkflowActionOutboxRow",
              "decodeWorkflowLegacyAuditRow",
              "decodeWorkflowPersistenceRow",
            ].map((exportName) => ({
              identity: {
                module: "src/workflow/workflow-persistence-codec.ts",
                exportName,
              },
              category: "persistence" as const,
            })),
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "projectFilesystemFailure",
              },
              category: "persistence",
            },
            {
              identity: { module: "src/mcp/config-file.ts", exportName: "isMissingFileError" },
              category: "projection",
            },
            {
              identity: {
                module: "src/mcp/config-file.ts",
                exportName: "validateMutationServerId",
              },
              category: "projection",
            },
            {
              identity: { module: "src/mcp/value-source.ts", exportName: "decodeJsonValue" },
              category: "projection",
            },
            {
              identity: {
                module: "src/tools/fs/remote-fs.ts",
                exportName: "decodeRemoteFsRunnerPackageSpec",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/workflow/workflow-action-resolver.ts",
                exportName: "decodeWorkflowActionOutboxEvent",
              },
              category: "persistence",
            },
            {
              identity: {
                module: "src/workflow/workflow-action-resolver.ts",
                exportName: "decodeWorkflowSurfaceAction",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/surface/bridge/bus-agent-runner/raw.ts",
                exportName: "parseRequestControlFromRaw",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/surface/discord/discord-request-router/common.ts",
                exportName: "getDiscordFlags",
              },
              category: "projection",
            },
            {
              identity: {
                module: "src/custom-commands/manager.ts",
                exportName: "decodeCustomCommandModule",
              },
              category: "plugin",
            },
            {
              identity: {
                module: "src/shared/req-context.ts",
                exportName: "decodeRequiredRequestContext",
              },
              category: "request",
            },
            {
              identity: {
                module: "src/shared/req-context.ts",
                exportName: "requireRequestContext",
              },
              category: "request",
            },
          ] satisfies readonly BoundaryDecoder[])
        : []),
      ...(INTEGRATED_BOUNDARY_DECODERS.get(root) ?? []),
    ],
    openProtocolAdapters: INTEGRATED_OPEN_PROTOCOL_ADAPTERS.get(root) ?? [],
    opaqueUnknown: [
      ...(root === "packages/event-bus"
        ? ([
            {
              identity: {
                module: "event-dead-letter.ts",
                exportName: "captureDeadLetterAcceptance.catch",
              },
              reason: "Preserves an opaque Redis adapter exception as dead-letter failure cause.",
            },
            {
              identity: {
                module: "event-delivery.ts",
                exportName: "EventDeliveryFatalReporter.report",
              },
              reason:
                "The fatal reporter contract carries an opaque rejected value to the registered defect supervisor.",
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe.reportFatal",
              },
              reason: "Reports an opaque handler or dependency defect without domain inspection.",
            },
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe.readFailure",
              },
              reason: "Preserves an opaque Redis read exception as a transport failure cause.",
            },
          ] satisfies readonly ReasonedSymbolException[])
        : []),
      ...(root === "apps/core"
        ? [
            {
              identity: { module: "src/mcp/config-file.ts", exportName: "errorMessage" },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            {
              identity: { module: "src/mcp/value-source.ts", exportName: "errorMessage" },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            {
              identity: {
                module: "src/runtime/graceful-restart-store.ts",
                exportName: "decodeOpaqueSuperJsonValue",
              },
              reason:
                "Carries an opaque historical restart value through exact SuperJSON capability validation without inspecting domain content.",
            },
            {
              identity: {
                module: "src/runtime/graceful-restart-store.ts",
                exportName: "isOpaqueSuperJsonValue",
              },
              reason:
                "Checks only whether an opaque restart value has a SuperJSON-compatible outer JavaScript type before capability validation.",
            },
            {
              identity: { module: "src/mcp/error-format.ts", exportName: "safeMcpErrorText" },
              reason:
                "Redacts and bounds an opaque external exception for the compatibility response.",
            },
            {
              identity: { module: "src/mcp/error-format.ts", exportName: "opaqueErrorMessage" },
              reason: "Formats an opaque external exception without inspecting domain structure.",
            },
            ...[
              ["build-remote-runner.ts", "captureBuildOperation.catch"],
              ["src/discovery/discovery-service.ts", "DiscoveryService.searchResult.catch"],
              ["src/discovery/discovery-service.ts", "DiscoveryService.closeResult.catch"],
              ["src/heartbeat/heartbeat-service.ts", "reloadHeartbeatCoreConfig"],
              ["src/heartbeat/heartbeat-service.ts", "computeHeartbeatCronAtMs"],
              ["src/shared/agent-output-activity.ts", "createAgentOutputActivityPublisher"],
              [
                "src/shared/agent-output-activity.ts",
                "createAgentOutputActivityPublisher.<callback>.<callback>",
              ],
            ].map(([module, exportName]) => ({
              identity: { module: module!, exportName: exportName! },
              reason:
                "Carries one opaque external rejection only at its immediate adapter boundary.",
            })),
            ...["opaqueErrorCause", "opaqueErrorMessage"].map((exportName) => ({
              identity: {
                module: "src/ssh/remote-js/remote-runner-utils.ts",
                exportName,
              },
              reason: "Carries or formats only an opaque bundled-runner exception value.",
            })),
          ]
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? [
            {
              identity: {
                module: "src/session-service.ts",
                exportName: "mapMiniLilacPersistenceFailure",
              },
              reason:
                "Classifies an opaque caught persistence exception without treating it as domain data.",
            },
          ]
        : []),
      ...(INTEGRATED_OPAQUE_UNKNOWN.get(root) ?? []),
    ],
    capabilityPredicates: [
      ...(root === "apps/core"
        ? [
            {
              identity: { module: "src/shared/sqlite.ts", exportName: "isSqliteBusyError" },
              reason: "Checks only the SQLite busy/locked error-message capability.",
            },
            {
              identity: {
                module: "src/shared/is-adapter-platform.ts",
                exportName: "isAdapterPlatform",
              },
              reason: "Checks exact membership in the closed adapter platform string union.",
            },
            {
              identity: {
                module: "src/surface/adapter.ts",
                exportName: "hasSurfaceGuildIdResolver",
              },
              reason:
                "Checks the exact optional Discord guild lookup capability preserved by the descriptor-bound facade.",
            },
            {
              identity: {
                module: "src/ssh/remote-js/remote-runner-utils.ts",
                exportName: "isPanic",
              },
              reason: "Checks only the exact better-result Panic brand in the isolated bundle.",
            },
          ]
        : []),
      ...(INTEGRATED_CAPABILITY_PREDICATES.get(root) ?? []),
    ],
    exceptionAdapters: [
      ...(root === "packages/event-bus"
        ? ([
            {
              identity: {
                module: "core-primary-lineage.ts",
                exportName: "decodeCorePrimaryLineageV1",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason:
                "Maps ordinary lineage projection failures to an owned Result while preserving Panic at the exact boundary.",
            },
            {
              identity: {
                module: "redis-event-dead-letter.ts",
                exportName: "RedisEventDeadLetter.constructor",
              },
              category: "compatibility",
              externalApi: { package: "global", exportName: "constructor" },
              direction: "signal-host",
              reason:
                "Converts typed Redis dead-letter configuration validation failure to the constructor host contract.",
            },
            ...[
              [
                "event-dead-letter.ts",
                "captureDeadLetterAcceptance.catch",
                "Preserves Panic while mapping a rejected dead-letter acceptance to its owned failure.",
              ],
              [
                "lilac-bus.ts",
                "checkedHandlerResult",
                "Raises Panic when a handler returns a forged Result or embeds Panic as an expected error.",
              ],
              [
                "lilac-bus.ts",
                "createLilacBus.bus.fetchTopic",
                "Preserves Panic while mapping an immediate raw fetch rejection to EventFetchTransportFailed.",
              ],
              [
                "lilac-codecs.ts",
                "decodeSchema",
                "Preserves Panic while mapping schema decoder exceptions to contract issues.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe",
                "Preserves Panic across subscription startup and delivery supervision.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.running.<callback>",
                "Preserves the running-loop defect while lease cleanup settles before rethrowing it unchanged.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.acknowledge",
                "Preserves Panic while mapping Redis acknowledgement failures to transport errors.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.handleEntry",
                "Classifies handler Panic for fatal supervision instead of treating it as an expected delivery error.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.runLoop",
                "Preserves Panic while converting ordinary Redis read failures to terminal delivery errors.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.stop",
                "Rethrows the original delivery defect and preserves Panic from either cleanup operation.",
              ],
            ].map(([module, exportName, reason]) => ({
              identity: { module, exportName },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason,
            })),
            ...[
              [
                "redis-streams-bus.ts",
                "decodeSuperJson",
                "superjson",
                "SuperJSON.parse",
                "Maps malformed Redis payload serialization to bounded wire evidence and a decode issue.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.reportFatal",
                "external",
                "EventDeliveryFatalReporter.report",
                "Contains a rejected fatal reporter at the logging-only defect reporting boundary.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.runLoop",
                "ioredis",
                "Redis.xread or Redis.xreadgroup",
                "Maps an immediate Redis read rejection to EventDeliveryTransportFailed.",
              ],
              [
                "redis-streams-bus.ts",
                "RedisStreamsBus.subscribe.cleanupGroup",
                "ioredis",
                "Redis.xgroup or Redis.xpending",
                "Captures consumer-group cleanup failure for the typed stop Result.",
              ],
            ].map(([module, exportName, packageName, externalName, reason]) => ({
              identity: { module, exportName },
              category: "external-to-result" as const,
              externalApi: { package: packageName, exportName: externalName },
              direction: "capture-external" as const,
              reason,
            })),
            ...[
              "encryptRedisEventDeadLetterRecoveryValue",
              "decryptRedisEventDeadLetterRecoveryValue",
            ].flatMap((exportName) => [
              {
                identity: { module: "redis-event-dead-letter.ts", exportName },
                category: "external-to-result" as const,
                externalApi: { package: "node:crypto", exportName: "AES-256-GCM" },
                direction: "capture-external" as const,
                reason:
                  "Maps an immediate authenticated-encryption operation failure to an owned recovery Result error.",
              },
              {
                identity: { module: "redis-event-dead-letter.ts", exportName },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason:
                  "Preserves Panic while capturing an immediate authenticated-encryption failure.",
              },
            ]),
            ...[
              ["decodeRedisEventDeadLetterCiphertextEnvelope", "global", "JSON.parse"],
              ["decryptRedisEventDeadLetterRecord", "superjson", "SuperJSON.parse"],
            ].map(([exportName, packageName, externalName]) => ({
              identity: { module: "redis-event-dead-letter.ts", exportName },
              category: "external-to-result" as const,
              externalApi: { package: packageName, exportName: externalName },
              direction: "capture-external" as const,
              reason:
                "Maps malformed persisted dead-letter serialization to an owned recovery Result error.",
            })),
            {
              identity: {
                module: "redis-streams-bus.ts",
                exportName: "RedisStreamsBus.subscribe.cleanupGroup",
              },
              category: "compatibility",
              externalApi: { package: "ioredis", exportName: "cleanup response validation" },
              direction: "signal-host",
              reason:
                "Routes invalid Redis cleanup responses through the local catch-to-cleanup-result boundary.",
            },
          ] satisfies readonly ExceptionAdapter[])
        : []),
      ...(root === "apps/core"
        ? ([
            ...[
              [
                "src/runtime/graceful-restart-store.ts",
                "parsePersistedPayload",
                "superjson",
                "SuperJSON.parse",
                "Maps malformed restart snapshots to an owned persistence Result error.",
              ],
              [
                "src/runtime/graceful-restart-store.ts",
                "encodeGracefulRestartSnapshot",
                "superjson",
                "SuperJSON.stringify",
                "Maps restart snapshot serialization failures to an owned persistence Result error.",
              ],
              [
                "src/runtime/graceful-restart-store.ts",
                "decodeOpaqueSuperJsonValue",
                "superjson",
                "SuperJSON round trip",
                "Rejects unsupported opaque restart values through a content-blind exact round trip.",
              ],
              [
                "src/transcript/transcript-store.ts",
                "SqliteTranscriptStore.readFromSqlite",
                "bun:sqlite",
                "SqliteTranscriptStore read callback",
                "Maps immediate SQLite read failures to an owned transcript store Result error.",
              ],
            ].map(([module, exportName, packageName, externalName, reason]) => ({
              identity: { module, exportName },
              category: "external-to-result" as const,
              externalApi: { package: packageName, exportName: externalName },
              direction: "capture-external" as const,
              reason,
            })),
            ...[
              ["src/runtime/graceful-restart-store.ts", "parsePersistedPayload"],
              ["src/runtime/graceful-restart-store.ts", "encodeGracefulRestartSnapshot"],
              ["src/runtime/graceful-restart-store.ts", "decodeOpaqueSuperJsonValue"],
              ["src/transcript/transcript-store.ts", "SqliteTranscriptStore.readFromSqlite"],
            ].map(([module, exportName]) => ({
              identity: { module, exportName },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason: "Preserves Panic identity at an immediate persistence adapter boundary.",
            })),
            {
              identity: {
                module: "src/workflow/workflow-artifact-persistence-codec.ts",
                exportName: "decodeWorkflowValueArtifact",
              },
              category: "external-to-result",
              externalApi: { package: "global", exportName: "JSON.parse" },
              direction: "capture-external",
              reason:
                "Maps malformed persisted workflow artifact JSON to an owned persistence Result error.",
            },
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "lstatOrMissing",
              },
              category: "external-to-result",
              externalApi: { package: "node:fs/promises", exportName: "lstat" },
              direction: "capture-external",
              reason: "Separates an absent workflow artifact from other filesystem failures.",
            },
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "artifactRoot.catch",
              },
              category: "external-to-result",
              externalApi: { package: "global", exportName: "language exception capture" },
              direction: "capture-external",
              reason: "Separates an absent workflow artifact root from other filesystem failures.",
            },
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "writeWorkflowValueArtifact",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic" },
              direction: "signal-host",
              reason:
                "Signals Panic when an atomically published workflow artifact cannot be verified.",
            },
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "adaptWorkflowArtifactResultToException",
              },
              category: "result-to-framework",
              externalApi: {
                package: "@stanley2058/lilac-core",
                exportName: "workflow orchestration exception contract",
              },
              direction: "signal-host",
              reason:
                "Adapts typed artifact failures only where legacy workflow orchestration requires rejection.",
            },
            {
              identity: {
                module: "src/workflow/workflow-artifact-store.ts",
                exportName: "rethrowWorkflowArtifactPanic",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason: "Preserves Panic identity while workflow artifact I/O is mapped to Results.",
            },
            {
              identity: {
                module: "src/conversation/thread-summary-persistence-codec.ts",
                exportName: "parseJson",
              },
              category: "external-to-result",
              externalApi: { package: "global", exportName: "JSON.parse" },
              direction: "capture-external",
              reason: "Maps malformed persisted summary JSON to an owned persistence Result error.",
            },
            {
              identity: {
                module: "src/conversation/thread-service.ts",
                exportName: "createConversationThreadToolService.resolvePersistenceOperation",
              },
              category: "result-to-framework",
              externalApi: {
                package: "@stanley2058/lilac-core",
                exportName: "ConversationThreadToolService",
              },
              direction: "signal-host",
              reason:
                "Signals a failed persisted-summary Result through the tool host exception contract.",
            },
            {
              identity: {
                module: "src/runtime/core-dead-letter-key.ts",
                exportName: "loadOrCreateCoreDeadLetterKey",
              },
              category: "external-to-result",
              externalApi: { package: "node:fs", exportName: "dead-letter key lifecycle" },
              direction: "capture-external",
              reason:
                "Maps atomic persistent dead-letter key filesystem failures to owned typed Results.",
            },
            {
              identity: {
                module: "src/runtime/core-dead-letter-key.ts",
                exportName: "loadOrCreateCoreDeadLetterKey",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason:
                "Preserves the original key lifecycle Panic while completing temporary-file cleanup.",
            },
            {
              identity: {
                module: "src/runtime/core-dead-letter-key.ts",
                exportName: "readCoreDeadLetterKey",
              },
              category: "external-to-result",
              externalApi: { package: "node:fs", exportName: "key file handle" },
              direction: "capture-external",
              reason:
                "Contains file-handle read and close failures for the outer typed key lifecycle adapter.",
            },
            {
              identity: {
                module: "src/runtime/core-dead-letter-key.ts",
                exportName: "readCoreDeadLetterKey",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason: "Preserves the original key read Panic when file-handle cleanup also fails.",
            },
            ...["captureFileOperation", "readMcpConfigFile"].flatMap((exportName) => [
              {
                identity: { module: "src/mcp/config-file.ts", exportName },
                category: "external-to-result" as const,
                externalApi: { package: "node:fs/promises", exportName: "filesystem operation" },
                direction: "capture-external" as const,
                reason:
                  "Maps an immediate MCP configuration filesystem failure to an owned Result error.",
              },
              {
                identity: { module: "src/mcp/config-file.ts", exportName },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason:
                  "Preserves exact Panic identity while mapping an immediate MCP configuration filesystem failure.",
              },
            ]),
            {
              identity: {
                module: "src/mcp/config-file.ts",
                exportName: "superviseMcpConfigFilePanicCleanup",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason:
                "Preserves the exact MCP configuration operation Panic while completing required temporary-file cleanup.",
            },
            {
              identity: { module: "src/mcp/config-file.ts", exportName: "serializeConfig.catch" },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason: "Preserves Panic while mapping the immediate serialization exception.",
            },
            {
              identity: { module: "src/mcp/value-source.ts", exportName: "captureTextFileRead" },
              category: "external-to-result" as const,
              externalApi: { package: "filesystem", exportName: "text file read" },
              direction: "capture-external" as const,
              reason: "Maps an immediate MCP value file read failure to an owned Result error.",
            },
            {
              identity: { module: "src/mcp/value-source.ts", exportName: "captureTextFileRead" },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason:
                "Preserves exact Panic identity while mapping an MCP value file read failure.",
            },
            {
              identity: { module: "src/mcp/value-source.ts", exportName: "decodeJsonValue.catch" },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason: "Preserves Panic while mapping the immediate JSON exception.",
            },
            ...["captureRunEvent", "captureChildActivity"].map((exportName) => ({
              identity: {
                module: "src/workflow/workflow-live-parent-bridge.ts",
                exportName,
              },
              category: "defect-supervisor" as const,
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic" as const,
              reason:
                "Preserves Panic while mapping an immediate live-parent delivery failure to an owned Result error.",
            })),
            ...[
              [
                "WorkflowWaitResolver.captureWorkflowWaitResolverConsumerGroupRetirement",
                "LilacBus.retireTopicConsumerGroup",
              ],
            ].flatMap(([exportName, externalExportName]) => [
              {
                identity: {
                  module: "src/workflow/workflow-wait-resolver.ts",
                  exportName,
                },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason: "Preserves Panic identity at a workflow wait resolver bus boundary.",
              },
              {
                identity: {
                  module: "src/workflow/workflow-wait-resolver.ts",
                  exportName,
                },
                category: "external-to-result" as const,
                externalApi: {
                  package: "@stanley2058/lilac-event-bus",
                  exportName: externalExportName,
                },
                direction: "capture-external" as const,
                reason: "Maps an event-bus rejection to an owned wait resolver Result error.",
              },
            ]),
            ...[
              [
                "src/workflow/workflow-action-resolver.ts",
                "adaptWorkflowActionSubscriptionStartResultToHost",
                "startWorkflowActionResolver",
              ],
              [
                "src/workflow/workflow-action-resolver.ts",
                "adaptWorkflowActionSubscriptionStopResultToHost",
                "WorkflowActionResolver.stop",
              ],
              [
                "src/workflow/workflow-progress-projector.ts",
                "adaptWorkflowProgressSubscriptionStartResultToHost",
                "WorkflowProgressProjector.start",
              ],
              [
                "src/workflow/workflow-progress-projector.ts",
                "adaptWorkflowProgressSubscriptionStopResultToHost",
                "WorkflowProgressProjector.stop",
              ],
              [
                "src/workflow/workflow-wait-resolver.ts",
                "adaptWorkflowWaitResolverStartResultToHost",
                "WorkflowWaitResolver.start",
              ],
              [
                "src/workflow/workflow-wait-resolver.ts",
                "adaptWorkflowWaitResolverStopResultToHost",
                "WorkflowWaitResolver.stop",
              ],
            ].map(([module, exportName, externalExportName]) => ({
              identity: { module, exportName },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-core",
                exportName: externalExportName,
              },
              direction: "signal-host" as const,
              reason:
                "Adapts a typed event-bus subscription Result to the owner's existing lifecycle rejection contract.",
            })),
            {
              identity: {
                module: "src/workflow/workflow-engine.ts",
                exportName: "runWorkflowTimerTick",
              },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason:
                "Preserves Panic while mapping a supervised workflow timer rejection to an owned Result error.",
            },
            ...[
              [
                "captureWorkflowTerminalReceiptAdoption",
                "@stanley2058/lilac-core",
                "WorkflowEngine.adoptTerminalReceipt",
                "terminal receipt adoption",
              ],
            ].flatMap(([exportName, packageName, externalExportName, operation]) => [
              {
                identity: { module: "src/workflow/workflow-engine.ts", exportName },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason: `Preserves Panic while capturing workflow ${operation}.`,
              },
              {
                identity: { module: "src/workflow/workflow-engine.ts", exportName },
                category: "external-to-result" as const,
                externalApi: { package: packageName, exportName: externalExportName },
                direction: "capture-external" as const,
                reason: `Maps workflow ${operation} rejection to an owned Result error.`,
              },
            ]),
            ...[
              "WorkflowLiveParentBridge.registerParent",
              "WorkflowLiveParentBridge.registerParent.cancelAll",
              "WorkflowLiveParentBridge.cancelRun",
            ].map((exportName) => ({
              identity: {
                module: "src/workflow/workflow-live-parent-bridge.ts",
                exportName,
              },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-core",
                exportName: "live-parent lifecycle host",
              },
              direction: "signal-host" as const,
              reason:
                "Adapts live-parent invariant or publication failure to the established lifecycle rejection contract.",
            })),
            ...[
              ["requireSubscriptionStart", "LilacBus.subscribeTopic"],
              ["requireSubscriptionStop", "LilacBus.subscribeTopic"],
              ["requireChildOutputBatch", "LilacBus.fetchTopic"],
            ].map(([exportName, externalExportName]) => ({
              identity: {
                module: "src/workflow/workflow-live-parent-bridge.ts",
                exportName,
              },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-event-bus",
                exportName: externalExportName,
              },
              direction: "signal-host" as const,
              reason:
                "Adapts a typed event-bus Result to the bridge's existing startup, cleanup, or reconciliation rejection contract.",
            })),
            {
              identity: {
                module: "src/workflow/workflow-engine.ts",
                exportName: "requireWorkflowEngineSubscriptionStart",
              },
              category: "result-to-framework",
              externalApi: {
                package: "@stanley2058/lilac-event-bus",
                exportName: "LilacBus.subscribeTopic",
              },
              direction: "signal-host",
              reason:
                "Adapts workflow-engine subscription startup failure to its existing host rejection contract.",
            },
            {
              identity: { module: "src/mcp/error-format.ts", exportName: "rethrowPanic" },
              category: "defect-supervisor",
              externalApi: { package: "better-result", exportName: "Panic.is" },
              direction: "observe-panic",
              reason:
                "Narrow helper propagates Panic without exempting its callers' ordinary throws.",
            },
            {
              identity: { module: "src/mcp/error-format.ts", exportName: "opaqueErrorMessage" },
              category: "compatibility",
              externalApi: { package: "global", exportName: "Error.message" },
              direction: "capture-external",
              reason:
                "Contains hostile Error.message getters while producing bounded compatibility text.",
            },
            {
              identity: {
                module: "src/mcp/oauth-provider.ts",
                exportName: "McpOAuthProvider.clientInformationForSdkAttempt",
              },
              category: "result-to-framework",
              externalApi: {
                package: "@ai-sdk/mcp",
                exportName: "OAuthClientProvider.clientInformation",
              },
              direction: "signal-host",
              reason:
                "OAuthClientProvider requires credential failure through its rejection channel.",
            },
            {
              identity: {
                module: "src/tool-server/tools/mcp.ts",
                exportName: "resultToMcpToolValue",
              },
              category: "result-to-framework",
              externalApi: {
                package: "@stanley2058/lilac-plugin-runtime",
                exportName: "ServerTool",
              },
              direction: "signal-host",
              reason: "ServerTool reports a failed tool call through the host exception channel.",
            },
          ] satisfies readonly ExceptionAdapter[])
        : []),
      ...(root === "packages/utils"
        ? ([
            {
              identity: {
                module: "persistence.ts",
                exportName: "classifyBunSqliteError",
              },
              category: "compatibility",
              externalApi: { package: "bun:sqlite", exportName: "SQLiteError" },
              direction: "capture-external",
              reason:
                "Contains hostile SQLiteError brand and field inspection while returning only a bounded driver code.",
            },
          ] satisfies readonly ExceptionAdapter[])
        : []),
      ...(root === "apps/core" ? CORE_TOOL_SERVER_EXCEPTION_ADAPTERS : []),
      ...(root === "apps/core" ? CORE_PARTITION_8_EXCEPTION_ADAPTERS : []),
      ...(root === "apps/core" ? CORE_REVIEWED_PANIC_ADAPTERS : []),
      ...(root === "apps/core" ? CORE_FATAL_SIGNAL_ADAPTERS : []),
      ...(root === "apps/core" ? CORE_ADAPTER_EVENT_EXCEPTION_ADAPTERS : []),
      ...(root === "packages/plugin-runtime"
        ? ([
            ...[
              ["adaptToolInputResultToServerToolHost", "ServerTool.call input validation"],
              ["adaptToolInputResultToZodHost", "legacy ServerTool.call Zod validation"],
            ].map(([exportName, externalExportName]) => ({
              identity: { module: "validation-error-message.ts", exportName },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-plugin-runtime",
                exportName: externalExportName,
              },
              direction: "signal-host" as const,
              reason:
                "Adapts one typed tool boundary Result to the established rejecting tool host contract.",
            })),
            {
              identity: { module: "zod-cli.ts", exportName: "adaptZodCliResultToToolHost" },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-plugin-runtime",
                exportName: "ServerTool.list CLI projection",
              },
              direction: "signal-host" as const,
              reason:
                "Adapts invalid Zod CLI projection state to the established rejecting ServerTool list contract.",
            },
            {
              identity: {
                module: "define-server-tool.ts",
                exportName: "adaptServerToolDispatchResultToHost",
              },
              category: "result-to-framework" as const,
              externalApi: {
                package: "@stanley2058/lilac-plugin-runtime",
                exportName: "ServerTool.call callable dispatch",
              },
              direction: "signal-host" as const,
              reason:
                "Adapts an unknown callable Result to the established rejecting ServerTool call contract.",
            },
          ] satisfies readonly ExceptionAdapter[])
        : []),
      ...(root === "packages/mini-lilac-runtime" ? MINI_WORKSPACE_HISTORY_EXCEPTION_ADAPTERS : []),
      ...preciseExceptionAdapters(PRECISE_EXCEPTION_IDENTITIES[root] ?? []),
    ],
    structuredLoggers:
      root === "apps/core"
        ? [
            "debug",
            "error",
            "fatal",
            "info",
            "log",
            "logDebug",
            "logError",
            "logFatal",
            "logInfo",
            "logWarn",
            "warn",
          ].map((exportName) => ({
            sink: {
              kind: "external" as const,
              package: "@stanley2058/simple-module-logger",
              exportName,
            },
            reason: "Core logger arguments are generically serialized in text or JSONL output.",
          }))
        : [],
    operationalResultApis: [
      ...(WAVE_3_OPERATIONAL_RESULT_APIS.get(root) ?? []),
      ...(root === "apps/core"
        ? [
            ...["captureBuildOperation", "buildRemoteRunner"].map((exportName) => ({
              module: "build-remote-runner.ts",
              exportName,
            })),
            ...[
              "parsePositiveInt",
              "parseBackend",
              "parseBenchmarkArgs",
              "countGlobResult",
              "countGrepResult",
              "runCase",
              "runBenchmark",
            ].map((exportName) => ({ module: "scripts/bench-fs-search.ts", exportName })),
            ...[
              "parseRelativeDurationMs",
              "parseEpochMs",
              "resolveOffsetTimeMs",
              "resolveLookbackDurationMs",
              "resolveTimeWindow",
              "DiscoveryService.searchResult",
              "DiscoveryService.closeResult",
            ].map((exportName) => ({
              module: "src/discovery/discovery-service.ts",
              exportName,
            })),
            ...["reloadHeartbeatCoreConfig", "computeHeartbeatCronAtMs"].map((exportName) => ({
              module: "src/heartbeat/heartbeat-service.ts",
              exportName,
            })),
            {
              module: "src/shared/req-context.ts",
              exportName: "decodeRequiredRequestContext",
            },
            {
              module: "src/shared/tool-server-context.ts",
              exportName: "decodeToolServerHeaders",
            },
            ...["resolveToolPathForRequestContextResult", "decodeDataUrlResult"].map(
              (exportName) => ({ module: "src/shared/attachment-utils.ts", exportName }),
            ),
            ...["readConfiguredSshHostsResult", "requireConfiguredSshHostResult"].map(
              (exportName) => ({ module: "src/ssh/ssh-config.ts", exportName }),
            ),
            {
              module: "src/tool-server/tools/programmatic-workflow.ts",
              exportName: "decodeWorkflowJsonObject",
            },
            {
              module: "src/tool-server/tools/ssh.ts",
              exportName: "decodeSshProbeOutput",
            },
            {
              module: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
              exportName: "decodeFirecrawlSearchResponse",
            },
            {
              module: "src/tool-server/tools/web.ts",
              exportName: "decodeFirecrawlScrapeResponse",
            },
            {
              module: "src/tool-server/tools/onboarding.ts",
              exportName: "decodeGithubReleaseResponse",
            },
            ...[
              "decodeThreadMaterializerWorkerRequest",
              "decodeThreadMaterializerWorkerResponse",
            ].map((exportName) => ({
              module: "src/conversation/thread-materializer-worker-protocol.ts",
              exportName,
            })),
            ...["decodeGithubAppSecret", "readGithubAppSecretResult"].map((exportName) => ({
              module: "src/github/github-app.ts",
              exportName,
            })),
            {
              module: "src/github/github-api.ts",
              exportName: "decodeGithubApiErrorResponse",
            },
            ...["decodeGithubUserTokenSecret", "readGithubUserTokenSecretResult"].map(
              (exportName) => ({ module: "src/github/github-user-token.ts", exportName }),
            ),
            ...["captureGithubWebhookOperation", "superviseGithubWebhookHandler"].map(
              (exportName) => ({
                module: "src/github/webhook/github-webhook-server.ts",
                exportName,
              }),
            ),
            ...CORE_THREAD_PERSISTED_CODECS.map(({ identity }) => identity),
            ...CORE_THREAD_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...CORE_TRANSCRIPT_PERSISTED_CODECS.map(({ identity }) => identity),
            ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity,
            CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER.identity,
            CORE_GRACEFUL_RESTART_ENCODER_CONSUMER.identity,
            {
              module: "src/runtime/graceful-restart-store.ts",
              exportName: "decodeOpaqueSuperJsonValue",
            },
            CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity,
            CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity,
            CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER.identity,
            ...CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...CORE_WORKFLOW_STORE_READ_RESULT_APIS,
            {
              module: "src/workflow/workflow-artifact-store.ts",
              exportName: "writeWorkflowValueArtifact",
            },
            ...CORE_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity),
            ...[
              "SqliteTranscriptStore.getCoreNamedClaudeSessionBinding",
              "SqliteTranscriptStore.readCoreNamedClaudeSessionBinding",
              "SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding",
              "SqliteTranscriptStore.readCorePrimaryClaudeSessionBinding",
            ].map((exportName) => ({
              module: "src/transcript/transcript-store.ts",
              exportName,
            })),
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.search",
            },
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.read",
            },
            {
              module: "src/conversation/thread-service.ts",
              exportName: "ConversationThreadService.metadata",
            },
            {
              module: "src/surface/bridge/bus-agent-runner.ts",
              exportName: "startBusAgentRunner.handleCmdRequestMessage",
            },
          ]
        : []),
      ...(root === "packages/plugin-runtime"
        ? [{ module: "validation-error-message.ts", exportName: "decodeToolInput" }]
        : []),
      ...(root === "packages/tool-results"
        ? [
            TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity,
            TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity,
            ...[
              "init",
              "create",
              "createFromFile",
              "createFromStream",
              "read",
              "readWindow",
              "maintain",
            ].map((method) => ({
              module: "src/tool-result-artifact-store.ts",
              exportName: `createToolResultArtifactStore.${method}`,
            })),
          ]
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? [
            ...MINI_RUNTIME_OPERATIONAL_RESULT_APIS,
            ...MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => identity),
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS.map(({ identity }) => identity),
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...MINI_SQLITE_BOUNDARY_DECODER_IDENTITIES,
            ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS.map(({ identity }) => identity),
            ...MINI_SQLITE_STORE_RESULT_APIS,
            ...MINI_SESSION_SERVICE_RESULT_APIS,
            MINI_SQLITE_TODO_PERSISTED_CODEC.identity,
            MINI_SQLITE_TODO_PERSISTED_CONSUMER.identity,
            MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER.identity,
          ]
        : []),
      ...(root === "packages/utils"
        ? [{ module: "persistence.ts", exportName: "runBunSqliteTransaction" }]
        : []),
      ...(root === "packages/claude-code-bridge"
        ? [
            {
              module: "claude-code-run.ts",
              exportName: "MaterializedClaudeCodeRun.createUtilityModelResult",
            },
          ]
        : []),
      ...(root === "apps/mini-lilac-tui"
        ? [
            {
              module: "src/tool-observation-projection.ts",
              exportName: "decodeKnownToolObservation",
            },
          ]
        : []),
      ...(root === "apps/core"
        ? [
            { module: "src/mcp/config-file.ts", exportName: "readMcpConfigFile" },
            { module: "src/mcp/config-file.ts", exportName: "writeMcpConfigFileAtomic" },
            { module: "src/mcp/config-file.ts", exportName: "mutateMcpConfigFile" },
            ...[
              "resolveMcpOAuthCredentialPathResult",
              "readMcpOAuthCredentialFileResult",
              "writeMcpOAuthCredentialFileAtomicResult",
              "updateMcpOAuthCredentialFileResult",
            ].map((exportName) => ({ module: "src/mcp/credential-file.ts", exportName })),
            ...[
              "captureOAuthAttempt",
              "McpOAuthProvider.startAuthorizationResult",
              "McpOAuthProvider.completeAuthorizationResult",
              "McpOAuthProvider.createPendingAuthorization",
              "McpOAuthProviderService.startAuthorizationResult",
            ].map((exportName) => ({ module: "src/mcp/oauth-provider.ts", exportName })),
            { module: "src/mcp/value-source.ts", exportName: "resolveJsonPointer" },
            { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSource" },
            { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSourceMap" },
            { module: "src/mcp/value-source.ts", exportName: "validateHttpHeaders" },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "startWorkflowActionResolver.stopWorkflowActionSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-action-resolver.ts",
              exportName: "captureWorkflowActionOutboxPublication",
            },
            {
              module: "src/workflow/workflow-progress-projector.ts",
              exportName: "WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
            },
            {
              module: "src/workflow/workflow-progress-projector.ts",
              exportName: "WorkflowProgressProjector.stopWorkflowProgressSubscriptionResult",
            },
            ...[
              "startWorkflowWaitResolverResult",
              "acquireLeaseResult",
              "startWorkflowWaitSubscriptionResult",
              "captureWorkflowWaitResolverTrim",
              "captureWorkflowWaitResolverConsumerGroupRetirement",
              "failWorkflowWaitResolverActivation",
              "activateSubscriptionResult",
              "recoverSubscriptionResult",
              "stopWorkflowWaitSubscriptionResult",
              "stopWorkflowWaitResolverResult",
              "captureWorkflowWaitResolverBarrierPublication",
              "reconcileTimersResult",
              "captureWorkflowWaitResolverWakeupPublication",
            ].map((exportName) => ({
              module: "src/workflow/workflow-wait-resolver.ts",
              exportName: `WorkflowWaitResolver.${exportName}`,
            })),
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "WorkflowEngine.startWakeSubscription",
            },
            { module: "src/workflow/workflow-engine.ts", exportName: "runWorkflowTimerTick" },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "captureWorkflowTerminalReceiptAdoption",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "captureWorkflowIdleCancellationPublication",
            },
            {
              module: "src/workflow/workflow-engine.ts",
              exportName: "fetchWorkflowTerminalReceipt",
            },
          ]
        : []),
      ...(STAGE_3_OPERATIONAL_RESULT_APIS.get(root) ?? []),
    ],
    taggedErrorFormatters: [
      ...(root === "apps/core"
        ? [
            {
              kind: "external" as const,
              package: "@stanley2058/lilac-utils",
              exportName: "formatTaggedErrorForLog",
            },
            {
              kind: "local" as const,
              module: "src/tool-server/create-tool-server.ts",
              exportName: "toolServerTaggedErrorLogProjection",
            },
            ...["formatBridgeLogContext", "formatBridgeTaggedErrorForLog"].map((exportName) => ({
              kind: "local" as const,
              module: "src/surface/bridge/bridge-log.ts",
              exportName,
            })),
            {
              kind: "local" as const,
              module: "src/surface/bridge/bus-agent-runner.ts",
              exportName: "formatClaudeLifecycleLogFields",
            },
          ]
        : []),
      ...(root === "packages/remote-fs-runner"
        ? ["responseError", "responseSuccess"].map((exportName) => ({
            kind: "local" as const,
            module: "src/cli.ts",
            exportName,
          }))
        : []),
    ],
    name: root,
    packageName,
    root,
    tsconfig: `${root}/tsconfig.json`,
  } satisfies WorkspaceArchitecture;
});

function preciseExceptionAdapterKey(
  workspace: string,
  module: string,
  exportName: string,
  direction: ExceptionAdapter["direction"],
): string {
  return `${workspace}\0${module}\0${exportName}\0${direction}`;
}

const PRECISE_EXCEPTION_ADAPTER_KEYS = new Set(
  Object.entries(PRECISE_EXCEPTION_IDENTITIES).flatMap(([workspace, identities]) =>
    identities.flatMap(([module, exportName, mode]) => {
      const signalDirection = exportName.startsWith("preserve")
        ? ("observe-panic" as const)
        : ("signal-host" as const);
      switch (mode) {
        case "capture":
          return [preciseExceptionAdapterKey(workspace, module, exportName, "capture-external")];
        case "signal":
          return [preciseExceptionAdapterKey(workspace, module, exportName, signalDirection)];
        case "both":
          return [
            preciseExceptionAdapterKey(workspace, module, exportName, "capture-external"),
            preciseExceptionAdapterKey(workspace, module, exportName, signalDirection),
          ];
      }
    }),
  ),
);

const REVIEWED_INJECTED_EXTERNAL_EFFECT_KEYS = new Set([
  preciseExceptionAdapterKey(
    "apps/core",
    "src/mcp/config-file.ts",
    "captureFileOperation",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "apps/core",
    "src/mcp/value-source.ts",
    "captureTextFileRead",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "packages/event-bus",
    "redis-streams-bus.ts",
    "RedisStreamsBus.subscribe.reportFatal",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "apps/core",
    "src/transcript/transcript-store.ts",
    "SqliteTranscriptStore.readFromSqlite",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "apps/core",
    "src/workflow/workflow-engine.ts",
    "captureWorkflowTerminalReceiptAdoption",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "apps/core",
    "src/ssh/ssh-config.ts",
    "readConfiguredSshHostsResult",
    "capture-external",
  ),
  preciseExceptionAdapterKey(
    "apps/core",
    "src/surface/github/github-runtime-descriptor.ts",
    "deleteGithubAcknowledgement",
    "capture-external",
  ),
]);

function exceptionAdapterSyntaxKinds(
  direction: ExceptionAdapter["direction"],
): readonly ExceptionAdapterSyntaxKind[] {
  switch (direction) {
    case "capture-external":
      return ["catch-clause", "rejection-callback"];
    case "signal-host":
      return ["throw-statement", "host-rejection-call", "registered-host-signal-call"];
    case "observe-panic":
      return ["panic-observation"];
  }
}

function exceptionAdapterProvenance(
  workspace: string,
  adapter: ExceptionAdapter,
): ExceptionAdapterProvenance {
  const { module, exportName } = adapter.identity;
  if (
    REVIEWED_INJECTED_EXTERNAL_EFFECT_KEYS.has(
      preciseExceptionAdapterKey(workspace, module, exportName, adapter.direction),
    )
  ) {
    return "reviewed-injected-external-effect";
  }
  if (
    PRECISE_EXCEPTION_ADAPTER_KEYS.has(
      preciseExceptionAdapterKey(workspace, module, exportName, adapter.direction),
    )
  ) {
    return "precise-exception-identities";
  }
  if (
    workspace === "apps/core" &&
    adapter.direction === "observe-panic" &&
    CORE_REVIEWED_PANIC_IDENTITIES.some(
      ([candidateModule, candidateExport]) =>
        candidateModule === module && candidateExport === exportName,
    )
  ) {
    return "core-reviewed-panic-identities";
  }
  if (
    workspace === "apps/core" &&
    adapter.direction === "signal-host" &&
    CORE_FATAL_SIGNAL_IDENTITIES.some(
      ([candidateModule, candidateExport]) =>
        candidateModule === module && candidateExport === exportName,
    )
  ) {
    return "core-fatal-signal-identities";
  }
  return "workspace-reviewed-manifest";
}

function exceptionAdapterRelationship(
  workspace: string,
  packageName: string,
  adapter: ExceptionAdapter,
): ExceptionAdapterRelationship {
  if (
    REVIEWED_INJECTED_EXTERNAL_EFFECT_KEYS.has(
      preciseExceptionAdapterKey(
        workspace,
        adapter.identity.module,
        adapter.identity.exportName,
        adapter.direction,
      ),
    )
  ) {
    return "injected-external-effect";
  }
  if (adapter.externalApi.package === "global") return "language-runtime";
  if (adapter.externalApi.package === "Intl") return "language-runtime";
  if (
    adapter.externalApi.package === "better-result" &&
    adapter.externalApi.exportName === "Panic.is"
  ) {
    return "panic-brand";
  }
  if (
    adapter.direction === "signal-host" &&
    (adapter.category === "result-to-framework" || adapter.category === "defect-supervisor")
  ) {
    return "host-contract";
  }
  if (
    adapter.direction === "capture-external" &&
    adapter.identity.exportName.includes(".catch") &&
    adapter.externalApi.package !== packageName
  ) {
    return "external-rejection";
  }
  return "external-package";
}

export const APPROVED_EXCEPTION_ADAPTER_CATALOG = ARCHITECTURE_WORKSPACES.flatMap((workspace) =>
  workspace.exceptionAdapters.map(
    (adapter): ApprovedExceptionAdapter => ({
      workspace: workspace.name,
      callable: adapter.identity,
      category: adapter.category,
      externalApi: adapter.externalApi,
      mode: adapter.direction,
      syntaxKinds: exceptionAdapterSyntaxKinds(adapter.direction),
      relationship: exceptionAdapterRelationship(workspace.name, workspace.packageName, adapter),
      provenance: exceptionAdapterProvenance(workspace.name, adapter),
      reason: adapter.reason,
    }),
  ),
);

function approvedExceptionAdapterCatalogSha256(
  approvals: readonly ApprovedExceptionAdapter[],
): string {
  const hash = createHash("sha256");
  for (const approval of approvals) {
    hash.update(
      JSON.stringify([
        approval.workspace,
        approval.callable.module,
        approval.callable.exportName,
        approval.category,
        approval.externalApi.package,
        approval.externalApi.exportName,
        approval.mode,
        approval.syntaxKinds,
        approval.relationship,
        approval.provenance,
        approval.reason,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export const APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256 =
  "507fdbc46ed807d47ea64cbe741c48cabf6daff4d8c956580aa85b6712c8e388";

export const architectureManifest = {
  version: 1,
  approvedExceptionAdapters: APPROVED_EXCEPTION_ADAPTER_CATALOG,
  approvedExceptionAdapterCatalogSha256: APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256,
  workspaces: ARCHITECTURE_WORKSPACES,
} satisfies ArchitectureManifest;

function requireNonempty(value: string, description: string): void {
  if (!value.trim()) throw new Error(`Architecture manifest ${description} must be nonempty.`);
}

function requireExactIdentity(identity: SymbolIdentity, description: string): void {
  requireNonempty(identity.module, `${description} module`);
  requireNonempty(identity.exportName, `${description} exportName`);
  if (
    identity.module.includes("*") ||
    identity.exportName.includes("*") ||
    identity.exportName === "<module>"
  ) {
    throw new Error(
      `Architecture manifest ${description} must name an exact symbol: ${identity.module}#${identity.exportName}.`,
    );
  }
}

function requireExactModule(module: string, description: string): void {
  requireNonempty(module, `${description} module`);
  if (module.includes("*")) {
    throw new Error(`Architecture manifest ${description} must name an exact module: ${module}.`);
  }
}

function requireExactExceptionAdapterIdentity(adapter: ExceptionAdapter): void {
  if (adapter.identity.exportName !== "<module>") {
    requireExactIdentity(adapter.identity, "exception adapter");
    return;
  }
  requireExactModule(adapter.identity.module, "module entrypoint exception adapter");
  if (adapter.category !== "compatibility" || adapter.direction !== "signal-host") {
    throw new Error(
      `Architecture manifest module entrypoint exception adapter must signal an exact compatibility host contract: ${adapter.identity.module}.`,
    );
  }
}

function identityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
}

function approvedExceptionAdapterKey(
  workspace: string,
  identity: SymbolIdentity,
  direction: ExceptionAdapter["direction"],
): string {
  return `${workspace}/${identityKey(identity)}@${direction}`;
}

function exceptionAdapterMatchesApproval(
  adapter: ExceptionAdapter,
  approval: ApprovedExceptionAdapter,
): boolean {
  return (
    identityKey(adapter.identity) === identityKey(approval.callable) &&
    adapter.category === approval.category &&
    adapter.externalApi.package === approval.externalApi.package &&
    adapter.externalApi.exportName === approval.externalApi.exportName &&
    adapter.direction === approval.mode &&
    adapter.reason === approval.reason
  );
}

function requireParameterIndex(value: number, description: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Architecture manifest ${description} must be a nonnegative integer.`);
  }
}

function requireUniqueValues(values: readonly string[], description: string): Set<string> {
  const unique = new Set<string>();
  for (const value of values) {
    requireNonempty(value, description);
    if (unique.has(value)) {
      throw new Error(`Architecture manifest ${description} contains duplicate '${value}'.`);
    }
    unique.add(value);
  }
  return unique;
}

function requiredExactRuleModules(
  workspace: WorkspaceArchitecture,
): ReadonlyMap<ArchitectureRule, ReadonlySet<string>> {
  const modules = new Map<ArchitectureRule, Set<string>>();
  const add = (rule: ArchitectureRule, module: string): void => {
    const registered = modules.get(rule) ?? new Set<string>();
    registered.add(module);
    modules.set(rule, registered);
  };
  for (const { identity } of workspace.openProtocolAdapters) {
    add("architecture/open-protocol-normalization", identity.module);
  }
  for (const { identity } of workspace.eventCodecRegistries) {
    add("architecture/complete-event-codec-registry", identity.module);
  }
  for (const { identity, aliases } of workspace.toolCodecRegistries) {
    for (const registered of [identity, ...aliases]) {
      add("architecture/complete-tool-codec-registry", registered.module);
    }
  }
  for (const { identity } of workspace.resultDecoders) {
    add("architecture/result-decoder-contract", identity.module);
  }
  for (const { module } of workspace.unknownFreeModules) {
    add("architecture/unknown-free-module", module);
  }
  for (const { identity } of workspace.persistedCodecs) {
    add("architecture/persisted-codec-contract", identity.module);
    add("architecture/persisted-codec-fixture-catalog", identity.module);
  }
  for (const { identity } of workspace.persistedStoreConsumers) {
    add("architecture/persisted-codec-contract", identity.module);
  }
  for (const { identity } of workspace.sqliteTransactionAdapters) {
    add("architecture/sqlite-transaction-adapter-contract", identity.module);
    add("architecture/no-result-err-in-sqlite-callback", identity.module);
  }
  for (const { identity } of workspace.sqliteTransactionConsumers) {
    add("architecture/sqlite-transaction-consumer", identity.module);
    add("architecture/no-result-err-in-sqlite-callback", identity.module);
  }
  for (const { identity } of workspace.rawEventMessageBoundaries) {
    add("architecture/raw-event-message-boundary", identity.module);
  }
  for (const { identity, deliveryPolicy } of workspace.eventDeliveryApis) {
    add("architecture/event-handler-result", identity.module);
    add("architecture/event-delivery-policy-exhaustiveness", deliveryPolicy.module);
  }
  return modules;
}

function requiredOperationalResultApis(
  workspace: WorkspaceArchitecture,
): readonly SymbolIdentity[] {
  return [
    ...workspace.resultDecoders.map(({ identity }) => identity),
    ...workspace.persistedCodecs.map(({ identity }) => identity),
    ...workspace.persistedStoreConsumers.map(({ identity }) => identity),
    ...workspace.sqliteTransactionAdapters.map(({ identity }) => identity),
    ...workspace.sqliteTransactionConsumers.map(({ identity }) => identity),
    ...workspace.eventDeliveryApis.map(({ identity }) => identity),
  ];
}

export function assertArchitectureManifestIntegrity(manifest: ArchitectureManifest): void {
  const workspacesByName = new Map(
    manifest.workspaces.map((workspace) => [workspace.name, workspace] as const),
  );
  const hasExceptionAdapters = manifest.workspaces.some(
    (workspace) => workspace.exceptionAdapters.length > 0,
  );
  if (
    hasExceptionAdapters &&
    (manifest.approvedExceptionAdapters === undefined ||
      manifest.approvedExceptionAdapterCatalogSha256 === undefined)
  ) {
    throw new Error(
      "Architecture manifests with exception adapters must declare the approved global catalog and its exact digest.",
    );
  }
  if (
    (manifest.approvedExceptionAdapters === undefined) !==
    (manifest.approvedExceptionAdapterCatalogSha256 === undefined)
  ) {
    throw new Error(
      "Architecture manifest approved exception adapters and catalog digest must be declared together.",
    );
  }
  const approvedExceptionAdapters = new Map<string, ApprovedExceptionAdapter>();
  if (manifest.approvedExceptionAdapterCatalogSha256 !== undefined) {
    const actualDigest = approvedExceptionAdapterCatalogSha256(
      manifest.approvedExceptionAdapters ?? [],
    );
    if (
      manifest.approvedExceptionAdapterCatalogSha256 !==
        APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256 ||
      actualDigest !== APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256
    ) {
      throw new Error(
        `Approved global exception adapter catalog digest mismatch: expected ${APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256}, received ${actualDigest}.`,
      );
    }
  }
  for (const approval of manifest.approvedExceptionAdapters ?? []) {
    requireExactIdentity(approval.callable, "approved exception adapter callable");
    requireNonempty(approval.externalApi.package, "approved exception adapter external package");
    requireNonempty(
      approval.externalApi.exportName,
      "approved exception adapter external exportName",
    );
    requireNonempty(approval.reason, "approved exception adapter reason");
    const expectedSyntaxKinds = exceptionAdapterSyntaxKinds(approval.mode);
    if (
      approval.syntaxKinds.length !== expectedSyntaxKinds.length ||
      approval.syntaxKinds.some((kind, index) => kind !== expectedSyntaxKinds[index])
    ) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has syntax kinds that do not match its mode.`,
      );
    }
    const expectedProvenance = exceptionAdapterProvenance(approval.workspace, {
      identity: approval.callable,
      category: approval.category,
      externalApi: approval.externalApi,
      direction: approval.mode,
      reason: approval.reason,
    });
    if (approval.provenance !== expectedProvenance) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has mismatched provenance.`,
      );
    }
    const expectedRelationship = exceptionAdapterRelationship(
      approval.workspace,
      workspacesByName.get(approval.workspace)?.packageName ?? "",
      {
        identity: approval.callable,
        category: approval.category,
        externalApi: approval.externalApi,
        direction: approval.mode,
        reason: approval.reason,
      },
    );
    if (approval.relationship !== expectedRelationship) {
      throw new Error(
        `Approved exception adapter ${approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode)} has a mismatched external/host relationship.`,
      );
    }
    const key = approvedExceptionAdapterKey(approval.workspace, approval.callable, approval.mode);
    if (approvedExceptionAdapters.has(key)) {
      throw new Error(`Duplicate approved exception adapter: ${key}.`);
    }
    approvedExceptionAdapters.set(key, approval);
  }
  const registeredExceptionAdapters = new Set<string>();
  for (const workspace of manifest.workspaces) {
    const operationalResultApiKeys = new Set(
      workspace.operationalResultApis.map((identity) => identityKey(identity)),
    );
    for (const rule of FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES) {
      const zones = workspace.ruleZones[rule] ?? [];
      if (zones.length !== 1 || zones[0]?.include !== "**") {
        throw new Error(
          `Workspace ${workspace.name} must enforce permanent package-wide rule ${rule} with the single '**' zone.`,
        );
      }
    }
    const requiredModules = requiredExactRuleModules(workspace);
    for (const rule of EXACT_REGISTRATION_ARCHITECTURE_RULES) {
      const actual = new Set((workspace.ruleZones[rule] ?? []).map(({ include }) => include));
      const expected = requiredModules.get(rule) ?? new Set<string>();
      if (actual.size !== expected.size || [...expected].some((module) => !actual.has(module))) {
        throw new Error(
          `Workspace ${workspace.name} exact ${rule} zones must equal registered modules; expected ${[...expected].sort().join(", ") || "none"}; received ${[...actual].sort().join(", ") || "none"}. Remove broad or stale zones and register every exact owner.`,
        );
      }
    }
    for (const identity of requiredOperationalResultApis(workspace)) {
      if (!operationalResultApiKeys.has(identityKey(identity))) {
        throw new Error(
          `Workspace ${workspace.name} registered Result boundary ${identityKey(identity)} must also be listed in operationalResultApis.`,
        );
      }
    }
    const unknownFreeModules = new Map<string, UnknownFreeModuleRegistration>();
    for (const registration of workspace.unknownFreeModules) {
      requireExactModule(registration.module, "unknown-free registration");
      if (unknownFreeModules.has(registration.module)) {
        throw new Error(
          `Duplicate unknown-free module registration in ${workspace.name}: ${registration.module}.`,
        );
      }
      unknownFreeModules.set(registration.module, registration);
      if (
        !(workspace.ruleZones["architecture/unknown-free-module"] ?? []).some(
          (zone) => zone.include === registration.module,
        )
      ) {
        throw new Error(
          `Unknown-free module ${registration.module} in ${workspace.name} is outside its workspace rule zones.`,
        );
      }
    }
    const decoderIdentities = new Set<string>();
    for (const decoder of workspace.boundaryDecoders) {
      requireExactIdentity(decoder.identity, "boundary decoder");
      const key = identityKey(decoder.identity);
      if (decoderIdentities.has(key)) {
        throw new Error(`Duplicate boundary decoder registration in ${workspace.name}: ${key}.`);
      }
      decoderIdentities.add(key);
      if (unknownFreeModules.has(decoder.identity.module)) {
        throw new Error(
          `Unknown-free module ${decoder.identity.module} cannot own boundary decoder ${key}.`,
        );
      }
    }
    const resultDecoderIdentities = new Set<string>();
    for (const decoder of workspace.resultDecoders) {
      requireExactIdentity(decoder.identity, "Result decoder");
      requireParameterIndex(decoder.inputParameter, "Result decoder inputParameter");
      const key = identityKey(decoder.identity);
      if (resultDecoderIdentities.has(key)) {
        throw new Error(`Duplicate Result decoder registration in ${workspace.name}: ${key}.`);
      }
      resultDecoderIdentities.add(key);
      if (unknownFreeModules.has(decoder.identity.module)) {
        throw new Error(
          `Unknown-free module ${decoder.identity.module} cannot own Result decoder ${key}.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/result-decoder-contract"] ?? []).some(
          (zone) => zone.include === decoder.identity.module,
        )
      ) {
        throw new Error(`Result decoder ${key} is outside its workspace rule zones.`);
      }
    }
    const persistedCodecIdentities = new Set<string>();
    for (const codec of workspace.persistedCodecs) {
      requireExactIdentity(codec.identity, "persisted codec");
      requireExactIdentity(codec.fixtureCatalog, "persisted codec fixture catalog");
      requireParameterIndex(codec.inputParameter, "persisted codec inputParameter");
      const key = identityKey(codec.identity);
      if (persistedCodecIdentities.has(key)) {
        throw new Error(`Duplicate persisted codec registration in ${workspace.name}: ${key}.`);
      }
      persistedCodecIdentities.add(key);
      const provenance = requireUniqueValues(codec.provenance, `persisted codec ${key} provenance`);
      for (const required of ["current", "migrated"] as const) {
        if (!provenance.has(required)) {
          throw new Error(`Persisted codec ${key} must declare '${required}' provenance.`);
        }
      }
      if (codec.missingOutcomes !== undefined) {
        const families = Object.entries(codec.missingOutcomes);
        if (families.length === 0) {
          throw new Error(`Persisted codec ${key} missing-outcome registry must not be empty.`);
        }
        for (const [family, outcome] of families) {
          requireNonempty(family, `persisted codec ${key} missing-outcome family`);
          if (outcome === "missing-defaulted" && !provenance.has("missing-defaulted")) {
            throw new Error(
              `Persisted codec ${key} family ${family} defaults missing data without declaring missing-defaulted provenance.`,
            );
          }
        }
      }
      for (const rule of [
        "architecture/persisted-codec-contract",
        "architecture/persisted-codec-fixture-catalog",
      ] as const) {
        if (
          !(workspace.ruleZones[rule] ?? []).some((zone) => zone.include === codec.identity.module)
        ) {
          throw new Error(`Persisted codec ${key} is outside ${rule} workspace rule zones.`);
        }
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(`Persisted codec ${key} must be linked as an operational Result API.`);
      }
    }
    const persistedConsumerIdentities = new Set<string>();
    for (const consumer of workspace.persistedStoreConsumers) {
      requireExactIdentity(consumer.identity, "persisted store consumer");
      const key = identityKey(consumer.identity);
      if (persistedConsumerIdentities.has(key)) {
        throw new Error(`Duplicate persisted store consumer in ${workspace.name}: ${key}.`);
      }
      persistedConsumerIdentities.add(key);
      if (consumer.codecs.length === 0) {
        throw new Error(`Persisted store consumer ${key} must declare at least one codec.`);
      }
      for (const codec of consumer.codecs) {
        requireExactIdentity(codec, "persisted store consumer codec");
        const targetWorkspace =
          codec.package === undefined
            ? workspace
            : manifest.workspaces.find((candidate) => candidate.packageName === codec.package);
        if (
          !targetWorkspace?.persistedCodecs.some(
            (candidate) => identityKey(candidate.identity) === identityKey(codec),
          )
        ) {
          throw new Error(
            `Persisted store consumer ${key} references unregistered codec ${codec.package ?? workspace.packageName}/${identityKey(codec)}.`,
          );
        }
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `Persisted store consumer ${key} must be linked as an operational Result API.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/persisted-codec-contract"] ?? []).some(
          (zone) => zone.include === consumer.identity.module,
        )
      ) {
        throw new Error(`Persisted store consumer ${key} is outside its workspace rule zones.`);
      }
    }
    const transactionAdapterIdentities = new Set<string>();
    for (const adapter of workspace.sqliteTransactionAdapters) {
      requireExactIdentity(adapter.identity, "SQLite transaction adapter");
      requireExactIdentity(adapter.rollbackSentinel, "SQLite rollback sentinel");
      requireExactIdentity(adapter.driverErrorClassifier, "SQLite driver error classifier");
      requireNonempty(adapter.panicClassifier.package, "SQLite Panic classifier package");
      requireNonempty(adapter.panicClassifier.exportName, "SQLite Panic classifier exportName");
      requireParameterIndex(adapter.databaseParameter, "SQLite adapter databaseParameter");
      requireParameterIndex(adapter.operationParameter, "SQLite adapter operationParameter");
      if (adapter.databaseParameter === adapter.operationParameter) {
        throw new Error(
          `SQLite transaction adapter ${identityKey(adapter.identity)} must use distinct database and operation parameters.`,
        );
      }
      if (
        adapter.panicClassifier.package !== "better-result" ||
        adapter.panicClassifier.exportName !== "Panic.is"
      ) {
        throw new Error(
          `SQLite transaction adapter ${identityKey(adapter.identity)} must use exact better-result#Panic.is classification.`,
        );
      }
      const key = identityKey(adapter.identity);
      if (transactionAdapterIdentities.has(key)) {
        throw new Error(`Duplicate SQLite transaction adapter in ${workspace.name}: ${key}.`);
      }
      transactionAdapterIdentities.add(key);
      if (
        !(workspace.ruleZones["architecture/sqlite-transaction-adapter-contract"] ?? []).some(
          (zone) => zone.include === adapter.identity.module,
        )
      ) {
        throw new Error(`SQLite transaction adapter ${key} is outside its workspace rule zones.`);
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `SQLite transaction adapter ${key} must be linked as an operational Result API.`,
        );
      }
    }
    const transactionConsumerIdentities = new Set<string>();
    for (const consumer of workspace.sqliteTransactionConsumers) {
      requireExactIdentity(consumer.identity, "SQLite transaction consumer");
      requireExactIdentity(consumer.adapter, "SQLite transaction consumer adapter");
      const key = identityKey(consumer.identity);
      if (transactionConsumerIdentities.has(key)) {
        throw new Error(`Duplicate SQLite transaction consumer in ${workspace.name}: ${key}.`);
      }
      transactionConsumerIdentities.add(key);
      const adapterWorkspace =
        consumer.adapter.package === undefined
          ? workspace
          : manifest.workspaces.find(
              (candidate) => candidate.packageName === consumer.adapter.package,
            );
      if (
        !adapterWorkspace?.sqliteTransactionAdapters.some(
          (candidate) => identityKey(candidate.identity) === identityKey(consumer.adapter),
        )
      ) {
        throw new Error(
          `SQLite transaction consumer ${key} references unregistered adapter ${consumer.adapter.package ?? workspace.packageName}/${identityKey(consumer.adapter)}.`,
        );
      }
      if (!operationalResultApiKeys.has(key)) {
        throw new Error(
          `SQLite transaction consumer ${key} must be linked as an operational Result API.`,
        );
      }
      if (
        !(workspace.ruleZones["architecture/sqlite-transaction-consumer"] ?? []).some(
          (zone) => zone.include === consumer.identity.module,
        )
      ) {
        throw new Error(`SQLite transaction consumer ${key} is outside its workspace rule zones.`);
      }
    }
    for (const exception of [...workspace.opaqueUnknown, ...workspace.capabilityPredicates]) {
      requireExactIdentity(exception.identity, "reasoned symbol registration");
      requireNonempty(exception.reason, "reasoned symbol registration reason");
    }
    for (const adapter of workspace.exceptionAdapters) {
      requireExactExceptionAdapterIdentity(adapter);
      requireNonempty(adapter.externalApi.package, "exception adapter external package");
      requireNonempty(adapter.externalApi.exportName, "exception adapter external exportName");
      requireNonempty(adapter.reason, "exception adapter reason");
      const key = approvedExceptionAdapterKey(workspace.name, adapter.identity, adapter.direction);
      const approval = approvedExceptionAdapters.get(key);
      if (!approval || !exceptionAdapterMatchesApproval(adapter, approval)) {
        throw new Error(
          `Exception adapter ${key} is not an exact member of the approved global catalog.`,
        );
      }
      if (registeredExceptionAdapters.has(key)) {
        throw new Error(`Duplicate exception adapter registration: ${key}.`);
      }
      registeredExceptionAdapters.add(key);
    }
    for (const api of workspace.operationalResultApis) {
      requireExactIdentity(api, "operational Result API");
    }
    const codecRegistries = new Set<string>();
    for (const registry of workspace.eventCodecRegistries) {
      requireExactIdentity(registry.identity, "event codec registry");
      requireExactIdentity(registry.catalog, "canonical event catalog");
      requireExactIdentity(registry.catalogHelper, "event catalog helper");
      requireExactIdentity(registry.registryHelper, "event codec registry helper");
      const key = identityKey(registry.identity);
      if (unknownFreeModules.has(registry.identity.module)) {
        throw new Error(
          `Unknown-free module ${registry.identity.module} cannot own event codec registry ${key}.`,
        );
      }
      if (codecRegistries.has(key)) {
        throw new Error(
          `Duplicate event codec registry registration in ${workspace.name}: ${key}.`,
        );
      }
      codecRegistries.add(key);
    }
    const toolCodecRegistries = new Set<string>();
    for (const registry of workspace.toolCodecRegistries) {
      requireExactIdentity(registry.identity, "tool codec registry");
      requireExactIdentity(registry.canonicalTools, "canonical tool catalog");
      if (
        registry.canonicalTools.package !== undefined &&
        !manifest.workspaces.some(
          (candidate) => candidate.packageName === registry.canonicalTools.package,
        )
      ) {
        throw new Error(
          `Canonical tool catalog package ${registry.canonicalTools.package} is not an active workspace package.`,
        );
      }
      const key = identityKey(registry.identity);
      if (unknownFreeModules.has(registry.identity.module)) {
        throw new Error(
          `Unknown-free module ${registry.identity.module} cannot own tool codec registry ${key}.`,
        );
      }
      if (toolCodecRegistries.has(key)) {
        throw new Error(`Duplicate tool codec registry registration in ${workspace.name}: ${key}.`);
      }
      toolCodecRegistries.add(key);
      const aliases = new Set<string>();
      for (const alias of registry.aliases) {
        requireExactIdentity(alias, "tool codec registry alias");
        const aliasKey = identityKey(alias);
        if (aliasKey === key || aliases.has(aliasKey)) {
          throw new Error(
            `Duplicate tool codec registry value registration in ${workspace.name}: ${aliasKey}.`,
          );
        }
        aliases.add(aliasKey);
        if (unknownFreeModules.has(alias.module)) {
          throw new Error(
            `Unknown-free module ${alias.module} cannot own tool codec registry alias ${aliasKey}.`,
          );
        }
      }
      if (
        !(workspace.ruleZones["architecture/complete-tool-codec-registry"] ?? []).some(
          (zone) => zone.include === registry.identity.module,
        )
      ) {
        throw new Error(`Tool codec registry ${key} is outside its workspace rule zones.`);
      }
    }
    const rawBoundaryIdentities = new Set<string>();
    for (const boundary of workspace.rawEventMessageBoundaries) {
      requireExactIdentity(boundary.identity, "raw event message boundary");
      requireNonempty(boundary.messageType.package, "raw event message type package");
      requireNonempty(boundary.messageType.exportName, "raw event message type exportName");
      requireParameterIndex(boundary.handlerParameter, "raw event handlerParameter");
      requireParameterIndex(boundary.messageParameter, "raw event messageParameter");
      requireParameterIndex(boundary.contextParameter, "raw event contextParameter");
      if (boundary.messageParameter === boundary.contextParameter) {
        throw new Error(
          `Architecture manifest raw event boundary ${identityKey(boundary.identity)} must use distinct message and context parameters.`,
        );
      }
      const key = identityKey(boundary.identity);
      if (rawBoundaryIdentities.has(key)) {
        throw new Error(`Duplicate raw event message boundary in ${workspace.name}: ${key}.`);
      }
      rawBoundaryIdentities.add(key);
    }
    const deliveryApiIdentities = new Set<string>();
    for (const api of workspace.eventDeliveryApis) {
      requireExactIdentity(api.identity, "event delivery API");
      requireExactIdentity(api.deliveryPolicy, "event delivery policy");
      requireParameterIndex(api.handlerParameter, "event delivery handlerParameter");
      requireParameterIndex(api.handlerMessageParameter, "event delivery handlerMessageParameter");
      requireParameterIndex(api.handlerContextParameter, "event delivery handlerContextParameter");
      requireParameterIndex(api.deliveryErrorParameter, "event delivery deliveryErrorParameter");
      if (api.handlerMessageParameter === api.handlerContextParameter) {
        throw new Error(
          `Architecture manifest event delivery API ${identityKey(api.identity)} must use distinct handler message and context parameters.`,
        );
      }
      const key = identityKey(api.identity);
      if (deliveryApiIdentities.has(key)) {
        throw new Error(`Duplicate event delivery API registration in ${workspace.name}: ${key}.`);
      }
      deliveryApiIdentities.add(key);
    }
    const deliveryConsumerIdentities = new Set<string>();
    for (const consumer of workspace.eventDeliveryConsumers) {
      requireExactIdentity(consumer.identity, "event delivery consumer");
      requireNonempty(consumer.apiPackage, "event delivery consumer apiPackage");
      const key = identityKey(consumer.identity);
      if (deliveryConsumerIdentities.has(key)) {
        throw new Error(
          `Duplicate event delivery consumer registration in ${workspace.name}: ${key}.`,
        );
      }
      deliveryConsumerIdentities.add(key);
      const operations = requireUniqueValues(
        consumer.operations,
        `event delivery consumer ${key} operations`,
      );
      if (operations.size === 0) {
        throw new Error(
          `Architecture manifest event delivery consumer ${key} must declare operations.`,
        );
      }
    }
    const openProtocolZones = workspace.ruleZones["architecture/open-protocol-normalization"] ?? [];
    for (const zone of openProtocolZones) {
      requireNonempty(zone.include, "open-protocol rule zone");
      if (zone.include.includes("*")) {
        throw new Error(
          `Architecture manifest open-protocol rule zone in ${workspace.name} must name an exact module: ${zone.include}.`,
        );
      }
    }
    const identities = new Set<string>();
    for (const adapter of workspace.openProtocolAdapters) {
      requireNonempty(adapter.identity.module, "open-protocol adapter module");
      requireNonempty(adapter.identity.exportName, "open-protocol adapter exportName");
      requireNonempty(adapter.externalProtocol.package, "open-protocol package");
      requireNonempty(adapter.externalProtocol.exportName, "open-protocol exportName");
      requireNonempty(adapter.fallbackVariant.discriminant, "open-protocol fallback discriminant");
      requireNonempty(adapter.fallbackVariant.value, "open-protocol fallback value");
      requireNonempty(adapter.reason, "open-protocol adapter reason");
      if (!Number.isInteger(adapter.protocolParameter) || adapter.protocolParameter < 0) {
        throw new Error(
          `Architecture manifest open-protocol adapter ${adapter.identity.module}#${adapter.identity.exportName} has an invalid protocolParameter.`,
        );
      }
      if (!openProtocolZones.some((zone) => zone.include === adapter.identity.module)) {
        throw new Error(
          `Architecture manifest open-protocol adapter ${adapter.identity.module}#${adapter.identity.exportName} is outside its workspace rule zones.`,
        );
      }
      const identity = `${adapter.identity.module}#${adapter.identity.exportName}`;
      if (identities.has(identity)) {
        throw new Error(
          `Duplicate open-protocol adapter registration in ${workspace.name}: ${identity}.`,
        );
      }
      identities.add(identity);
    }
  }
  for (const key of approvedExceptionAdapters.keys()) {
    if (!registeredExceptionAdapters.has(key)) {
      throw new Error(
        `Approved global exception adapter ${key} is not registered by its workspace.`,
      );
    }
  }
}
