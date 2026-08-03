import { ARCHITECTURE_RULES, type ArchitectureRule } from "./model.ts";

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

export interface ZeroBaselineScope {
  readonly module: string;
  readonly symbol?: string;
}

const SOURCE_MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

export function zeroBaselineScopeOwns(
  scope: ZeroBaselineScope,
  module: string,
  symbol: string,
): boolean {
  if (
    scope.module.replace(SOURCE_MODULE_EXTENSION, "") !==
    module.replace(SOURCE_MODULE_EXTENSION, "")
  ) {
    return false;
  }
  return (
    scope.symbol === undefined || symbol === scope.symbol || symbol.startsWith(`${scope.symbol}.`)
  );
}

export type ArchitectureRegistrationStatus = "advisory" | "enforced";

export interface EventCodecRegistryRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly canonicalEvents: SymbolIdentity;
  readonly canonicalMembers: readonly string[];
  readonly codecMembers: readonly string[];
}

export interface ToolCodecRegistryRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly aliases: readonly SymbolIdentity[];
  readonly canonicalTools: PackageSymbolIdentity;
}

export interface ResultDecoderRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly category: BoundaryCategory;
  readonly inputParameter: number;
}

export interface UnknownFreeModuleRegistration {
  readonly status: ArchitectureRegistrationStatus;
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
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly inputParameter: number;
  readonly fixtureCatalog: SymbolIdentity;
  readonly provenance: readonly PersistedValueProvenance[];
  readonly missingOutcomes?: Readonly<Record<string, PersistedMissingOutcome>>;
}

export interface PersistedStoreConsumerRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly codecs: readonly PackageSymbolIdentity[];
}

export interface SqliteTransactionAdapterRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly databaseParameter: number;
  readonly operationParameter: number;
  readonly rollbackSentinel: SymbolIdentity;
  readonly panicClassifier: ExternalSymbolIdentity;
  readonly driverErrorClassifier: SymbolIdentity;
}

export interface SqliteTransactionConsumerRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly adapter: PackageSymbolIdentity;
}

export interface RawEventMessageBoundaryRegistration {
  readonly status: ArchitectureRegistrationStatus;
  readonly identity: SymbolIdentity;
  readonly messageType: ExternalSymbolIdentity;
  readonly handlerParameter: number;
  readonly messageParameter: number;
  readonly contextParameter: number;
}

export interface EventDeliveryApiRegistration {
  readonly status: ArchitectureRegistrationStatus;
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

export interface EventFamilyMigration {
  readonly family: string;
  readonly status: "advisory" | "migrating" | "migrated";
  readonly codecRegistry: SymbolIdentity;
  readonly members: readonly string[];
  readonly zeroBaselineScopes: readonly (ZeroBaselineScope & { readonly workspace: string })[];
}

export interface WorkspaceArchitecture {
  readonly name: string;
  readonly packageName: string;
  readonly root: string;
  readonly tsconfig: string;
  readonly status: "inventory" | "migrating" | "migrated";
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
  readonly zeroBaselineScopes: readonly ZeroBaselineScope[];
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
  readonly eventFamilyMigrations: readonly EventFamilyMigration[];
  readonly baselines: {
    readonly boundaryValidation: string;
    readonly failureFlow: string;
  };
}

export interface ArchitectureManifest {
  readonly version: 1;
  readonly workspaces: readonly WorkspaceArchitecture[];
}

const STAGE_1_PILOT_RULES = new Set<ArchitectureRule>([
  "architecture/no-unhandled-exception-contract",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
]);

const SCOPED_ARCHITECTURE_RULES = new Set<ArchitectureRule>([
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

const DEFAULT_RULE_ZONES = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [
    rule,
    STAGE_1_PILOT_RULES.has(rule) || SCOPED_ARCHITECTURE_RULES.has(rule) ? [] : [{ include: "**" }],
  ]),
);

const EMPTY_POLICY = {
  status: "inventory",
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
  zeroBaselineScopes: [],
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
  eventFamilyMigrations: [],
  baselines: {
    boundaryValidation: "scripts/architecture/boundary-validation.baseline.ts",
    failureFlow: "scripts/architecture/failure-flow.baseline.ts",
  },
} as const;

const ACTIVE_WORKSPACES = [
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

const MIGRATING_WORKSPACES = new Set<string>([
  "apps/core",
  "packages/coding-tools",
  "packages/fs",
  "packages/plugin-runtime",
  "packages/remote-fs-runner",
  "packages/tool-results",
  "packages/utils",
]);

const STAGE_3_ZERO_BASELINE_MODULES = new Map<string, readonly string[]>([
  [
    "apps/core",
    [
      "src/conversation/thread-summarization-worker-protocol.ts",
      "src/conversation/thread-summarization-worker.ts",
      "src/conversation/thread-worker.ts",
      "src/custom-commands/manager.ts",
      "src/plugins/manager.ts",
      "src/ssh/remote-js/bundled-runner-failure.ts",
      "src/ssh/remote-js/remote-runner-entry.ts",
      "src/ssh/remote-js.ts",
      "src/ssh/ssh-exec.ts",
      "src/tool-server/create-tool-server.ts",
      "src/tool-server/tools/conversation-thread.ts",
      "src/tools/fs/remote-fs.ts",
    ],
  ],
  ["packages/coding-tools", ["src/filesystem.ts"]],
  ["packages/fs", ["src/remote-runner-protocol.ts"]],
  [
    "packages/plugin-runtime",
    ["capabilities.ts", "discovery.ts", "hooks.ts", "loader.ts", "manager.ts"],
  ],
  ["packages/remote-fs-runner", ["src/cli.ts"]],
  ["packages/utils", ["custom-commands.ts"]],
]);

const STAGE_3_OPERATIONAL_RESULT_APIS = new Map<string, readonly SymbolIdentity[]>([
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
        exportName: "startHeartbeatService.startHeartbeatLifecycleResult",
      },
      {
        module: "src/heartbeat/heartbeat-service.ts",
        exportName: "startHeartbeatService.stopHeartbeatLifecycleResult",
      },
      {
        module: "src/tool-server/request-message-cache.ts",
        exportName: "createRequestMessageCache.startRequestMessageCacheResult",
      },
      {
        module: "src/tool-server/request-message-cache.ts",
        exportName: "createRequestMessageCache.stopRequestMessageCacheResult",
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
      "decodeBundledRemoteRunnerRequest",
      "decodeBundledRemoteRunnerRequestJson",
      "decodeRemoteFsRequest",
      "decodeRemoteFsRequestJson",
      "decodeRemoteFsDaemonRequest",
      "decodeRemoteFsDaemonRequestJson",
      "decodeRemoteRunnerResponse",
      "decodeRemoteRunnerResponseJson",
    ].map((exportName) => ({ module: "src/remote-runner-protocol.ts", exportName })),
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

const STAGE_3_BOUNDARY_RULES = [
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
] as const satisfies readonly ArchitectureRule[];

const STAGE_3_RESULT_RULES = [
  "architecture/no-unhandled-exception-contract",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
] as const satisfies readonly ArchitectureRule[];

const STAGE_1_CORE_RULE_ZONES = [
  { include: "src/mcp/value-source.ts" },
  { include: "src/mcp/config-file.ts" },
] as const satisfies readonly RuleZone[];

const INTEGRATED_BOUNDARY_DECODERS = new Map<string, readonly BoundaryDecoder[]>([
  [
    "apps/core",
    [
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
          module: "src/tool-server/request-message-cache.ts",
          exportName: "resolveAuthenticatedOrigin",
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
      {
        identity: {
          module: "src/filesystem.ts",
          exportName: "createFilesystemTools.toModelOutput",
        },
        category: "projection",
      },
    ],
  ],
  [
    "apps/mini-lilac-tui",
    [
      {
        identity: {
          module: "src/ui-message-chunk-projection.ts",
          exportName: "projectMiniLilacStreamChunk",
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
      {
        identity: { module: "src/main.ts", exportName: "parseCliArgs" },
        category: "request",
      },
    ],
  ],
  [
    "packages/mini-lilac-client",
    [
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "normalizeStreamChunk" },
        category: "wire",
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
    ],
  ],
]);

const INTEGRATED_OPAQUE_UNKNOWN = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "apps/core",
    [
      {
        identity: { module: "src/tools/batch.ts", exportName: "batchTool" },
        reason: "Carries an AI SDK tool-call payload opaquely to the selected child tool boundary.",
      },
      {
        identity: {
          module: "src/plugins/manager.ts",
          exportName: "createCoreToolPluginManager.buildLevel1Toolset.resolveEditTargets",
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
    ],
  ],
  [
    "packages/plugin-runtime",
    [
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
    ],
  ],
]);

const INTEGRATED_CAPABILITY_PREDICATES = new Map<string, readonly ReasonedSymbolException[]>([
  [
    "packages/plugin-runtime",
    ["isFunctionCapability", "isPluginPanic"].map((exportName) => ({
      identity: { module: "capabilities.ts", exportName },
      reason: "Checks one exact runtime capability without interpreting plugin-owned domain data.",
    })),
  ],
  [
    "packages/utils",
    [
      {
        identity: { module: "runtime-utils.ts", exportName: "isPanic" },
        reason:
          "Checks exact Panic identity while treating hostile classifier inspection as ordinary opaque failure.",
      },
    ],
  ],
]);

const INTEGRATED_OPEN_PROTOCOL_ADAPTERS = new Map<string, readonly OpenProtocolAdapter[]>([
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
  ["apps/acp-controller", [{ include: "session-history.ts" }]],
  [
    "apps/mini-lilac-tui",
    [{ include: "src/ui-message-chunk-projection.ts" }, { include: "src/render.ts" }],
  ],
]);

const INTEGRATED_EXCEPTION_ADAPTERS = new Map<string, readonly ExceptionAdapter[]>([
  [
    "apps/mini-lilac-tui",
    [
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
          module: "src/conversation/thread-worker.ts",
          exportName: "signalConversationThreadWorkerPanicToProcess",
        },
        category: "result-to-framework",
        externalApi: { package: "node", exportName: "process.uncaughtException" },
        direction: "signal-host",
        reason:
          "Schedules the same terminal worker Panic for the existing fatal process exception supervisor.",
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
        [
          "src/tool-server/request-message-cache.ts",
          "adaptRequestMessageCacheStartResultToHost",
          "createRequestMessageCache",
        ],
        [
          "src/tool-server/request-message-cache.ts",
          "adaptRequestMessageCacheStopResultToHost",
          "RequestMessageCache.stop",
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
          module: "src/runtime/create-core-runtime.ts",
          exportName: "createCoreEventBusFatalReporter.report",
        },
        category: "defect-supervisor",
        externalApi: {
          package: "@stanley2058/lilac-event-bus",
          exportName: "EventDeliveryFatalReporter.report",
        },
        direction: "observe-panic",
        reason:
          "Normalizes an opaque event-delivery defect at the exact external fatal-reporter boundary without treating it as domain data.",
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
      {
        identity: {
          module: "src/runtime/create-core-runtime.ts",
          exportName: "createCoreRuntimeCleanupSupervisor.finish",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic",
        reason:
          "Propagates the first cleanup Panic only after all cleanup operations have been supervised.",
      },
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
          exportName: "adaptPanicToToolServerHost",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic" },
        direction: "observe-panic",
        reason: "Propagates Panic unchanged through the tool-server host defect channel.",
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
          module: "src/tool-server/create-tool-server.ts",
          exportName: "superviseToolCallRejections",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.then" },
        direction: "observe-panic",
        reason:
          "Projects and supervises rejected tool-call settlements before the timeout race can consume them.",
      },
      {
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: "signalFatalToolCallDefectToProcess",
        },
        category: "result-to-framework",
        externalApi: { package: "node", exportName: "process.uncaughtException" },
        direction: "signal-host",
        reason: "Schedules an uncaught tool-call defect for the existing fatal process supervisor.",
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
        [
          "startBusAgentRunner.drainSessionQueue.decideIdleRecovery",
          "AiSdkPiAgent.requestIdleRecovery",
        ],
        [
          "startBusAgentRunner.drainSessionQueue.<callback>.turnErrorHandler",
          "AiSdkPiAgent.turnErrorHandler",
        ],
        [
          "startBusAgentRunner.drainSessionQueue.<callback>.reportServerCompactionError",
          "attachAutoCompaction.onServerCompactionError",
        ],
        [
          "startBusAgentRunner.drainSessionQueue.<callback>.reportAutoInjectedThreadSearchError",
          "ConversationThreadToolService error callback",
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
        "startBusRequestRouter.reloadCoreConfigIfNeeded",
        "startBusRequestRouter.evaluateAdapterSuppression",
        "startBusRequestRouter.evaluateDirectReplyRouterGate",
      ].flatMap((exportName) => [
        {
          identity: { module: "src/surface/bridge/bus-request-router.ts", exportName },
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
          identity: { module: "src/surface/bridge/bus-request-router.ts", exportName },
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
          module: "src/surface/bridge/bus-request-router/common.ts",
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
          identity: { module: "src/surface/bridge/bus-request-router.ts", exportName },
          category: "external-to-result" as const,
          externalApi,
          direction: "capture-external" as const,
          reason,
        },
        {
          identity: { module: "src/surface/bridge/bus-request-router.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason: "Preserves Panic identity at the exact gate or detached timer boundary.",
        },
      ]),
      ...[
        "adaptRouterSubscriptionStart",
        "superviseRouterSubscriptionsDone",
        "adaptRouterSubscriptionsStop",
      ].map((exportName) => ({
        identity: { module: "src/surface/bridge/bus-request-router.ts", exportName },
        category: "result-to-framework" as const,
        externalApi: { package: "@stanley2058/lilac-core", exportName: "request router lifecycle" },
        direction: "signal-host" as const,
        reason:
          "Adapts the event-delivery lifecycle Result at the existing request-router host boundary.",
      })),
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
          module: "src/runtime/create-core-runtime.ts",
          exportName: "superviseCoreRouterDone",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.then" },
        direction: "observe-panic",
        reason:
          "Observes typed router termination and forwards unexpected Results or rejections to fatal runtime supervision.",
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
          exportName: "startBusAgentRunner.startSessionQueueDrain",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.catch" },
        direction: "observe-panic",
        reason:
          "Syntax-visible identity for attaching the exact named detached-drain supervisor callback.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.superviseSubscriptionDone",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.catch" },
        direction: "observe-panic",
        reason:
          "Observes the typed command-request subscription completion at its runtime host boundary and reports rejected Panic without converting it to delivery error data.",
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
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner",
        },
        category: "defect-supervisor",
        externalApi: { package: "global", exportName: "Promise.catch" },
        direction: "observe-panic",
        reason:
          "Attaches the named command-request subscription completion supervisor and observes its rethrow.",
      },
      {
        identity: {
          module: "src/surface/bridge/bus-agent-runner.ts",
          exportName: "startBusAgentRunner.stopSubscription",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-event-bus",
          exportName: "subscription stop/done",
        },
        direction: "signal-host",
        reason:
          "Maps typed subscription stop and completion failures to the runner shutdown host while preserving rejected Panic.",
      },
      {
        identity: {
          module: "src/runtime/process-handlers.ts",
          exportName: "createProcessHandlers.reportFatalError",
        },
        category: "result-to-framework",
        externalApi: { package: "node", exportName: "fatal process lifecycle" },
        direction: "signal-host",
        reason:
          "Signals an explicitly reported background Panic through supervised process shutdown rather than the nonfatal unhandled-rejection observer.",
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
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeJson.catch",
        },
        category: "external-to-result",
        externalApi: { package: "global", exportName: "JSON.parse" },
        direction: "capture-external",
        reason: "Maps malformed remote runner JSON to the protocol-owned decode error.",
      },
      {
        identity: {
          module: "src/remote-runner-protocol.ts",
          exportName: "decodeJson.catch",
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
      ...["persistBashArtifact", "cleanupBashSpoolAfterExecution", "executeLocalBash"].map(
        (exportName) => ({
          identity: { module: "src/bash.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason:
            "Preserves Panic identity while applying Bash artifact-retention policy and cleanup.",
        }),
      ),
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
        identity: {
          module: "src/tool-result-output-normalizer.ts",
          exportName: "createOverflowReferenceNormalizer.normalizeCapturedText",
        },
        category: "compatibility",
        externalApi: {
          package: "@stanley2058/lilac-tool-results",
          exportName: "ToolResultArtifactStore.create",
        },
        direction: "capture-external",
        reason:
          "Maps a non-Panic rejected artifact adapter to the established no-URI overflow reference.",
      },
      {
        identity: {
          module: "src/tool-result-output-normalizer.ts",
          exportName: "createOverflowReferenceNormalizer.normalizeCapturedText",
        },
        category: "defect-supervisor",
        externalApi: { package: "better-result", exportName: "Panic.is" },
        direction: "observe-panic",
        reason: "Preserves Panic identity through overflow artifact retention policy.",
      },
      ...[
        "createToolResultArtifactStore.rethrowAfterCleanup",
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
            "Maps the immediate artifact filesystem, source stream, or AES-GCM exception to an owned Result error.",
        },
        {
          identity: { module: "src/tool-result-artifact-store.ts", exportName },
          category: "defect-supervisor" as const,
          externalApi: { package: "better-result", exportName: "Panic.is" },
          direction: "observe-panic" as const,
          reason:
            "Preserves Panic and unrecognized defect identity across the artifact Result adapter.",
        },
      ]),
    ],
  ],
  [
    "packages/mini-lilac-runtime",
    [
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
      {
        identity: { module: "src/server.ts", exportName: "createMiniLilacServer" },
        category: "compatibility",
        externalApi: { package: "elysia", exportName: "HTTP request handler" },
        direction: "capture-external",
        reason:
          "Maps request-time configuration exceptions to the established HTTP error contract.",
      },
      {
        identity: { module: "src/server.ts", exportName: "createMiniLilacServer" },
        category: "result-to-framework",
        externalApi: { package: "elysia", exportName: "HTTP request handler" },
        direction: "signal-host",
        reason: "Signals request policy failures through Elysia's HTTP exception contract.",
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
        identity: {
          module: "mini-lilac-transport.ts",
          exportName: "MiniLilacTransport.responseStream",
        },
        category: "result-to-framework",
        externalApi: { package: "ai", exportName: "ChatTransport" },
        direction: "signal-host",
        reason: "Reports an invalid chat response through the ChatTransport rejection contract.",
      },
    ],
  ],
]);

const CANONICAL_LILAC_EVENT_MEMBERS = [
  "cmd.request.message",
  "cmd.surface.output.reanchor",
  "evt.adapter.message.created",
  "evt.adapter.message.updated",
  "evt.adapter.message.deleted",
  "evt.adapter.reaction.added",
  "evt.adapter.reaction.removed",
  "evt.adapter.action.invoked",
  "evt.adapter.workflow-wait-resolver.barrier",
  "evt.request.lifecycle.changed",
  "evt.request.reply",
  "evt.surface.output.message.created",
  "evt.workflow.run.changed",
  "evt.workflow.operation.changed",
  "evt.workflow.progress.requested",
  "evt.workflow.usage.changed",
  "evt.workflow.result.ready",
  "cmd.agent.create",
  "evt.agent.output.delta.reasoning",
  "evt.agent.output.delta.text",
  "evt.agent.output.text.reset",
  "evt.agent.output.response.text",
  "evt.agent.output.response.binary",
  "evt.agent.output.toolcall",
  "evt.agent.output.activity",
] as const;

const EVENT_BUS_CODEC_REGISTRY: EventCodecRegistryRegistration = {
  status: "enforced",
  identity: { module: "lilac-codecs.ts", exportName: "lilacEventCodecRegistry" },
  canonicalEvents: { module: "lilac-spec.ts", exportName: "lilacEventTypes" },
  canonicalMembers: CANONICAL_LILAC_EVENT_MEMBERS,
  codecMembers: CANONICAL_LILAC_EVENT_MEMBERS,
};

const TUI_TOOL_CODEC_REGISTRY: ToolCodecRegistryRegistration = {
  status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/tool-observation-projection.ts",
    exportName: "decodeKnownToolObservation",
  },
  category: "projection",
  inputParameter: 0,
};

const TUI_UNKNOWN_FREE_MODULES = [
  { status: "enforced", module: "src/render.ts" },
  { status: "enforced", module: "src/transcript-buffer.ts" },
] as const satisfies readonly UnknownFreeModuleRegistration[];

const STAGE_5_TUI_MODULES = [
  "src/render.ts",
  "src/ui-message-chunk-projection.ts",
  "src/tool-observation-projection.ts",
  "src/transcript-buffer.ts",
] as const;

const CORE_THREAD_PERSISTED_CODECS = [
  {
    status: "enforced",
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
    status: "enforced",
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
    status: "enforced",
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
    status: "enforced",
    identity: { module: "src/transcript/transcript-store.ts", exportName: String(exportName) },
    codecs: (codecIndexes as number[]).map(
      (index) => CORE_TRANSCRIPT_PERSISTED_CODECS[index]!.identity,
    ),
  }),
);

const CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC = {
  status: "enforced",
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
  status: "enforced",
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
    status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/workflow/workflow-artifact-store.ts",
    exportName: "readWorkflowValueArtifact",
  },
  codecs: [CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const TOOL_RESULT_ARTIFACT_METADATA_CODEC = {
  status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/tool-result-artifact-store.ts",
    exportName: "createToolResultArtifactStore.readMetadata",
  },
  codecs: [TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_GRACEFUL_RESTART_PERSISTED_CODEC = {
  status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/runtime/graceful-restart-store.ts",
    exportName: "SqliteGracefulRestartStore.loadAndConsumeCompletedSnapshot",
  },
  codecs: [CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const CORE_GRACEFUL_RESTART_ENCODER_CONSUMER = {
  status: "enforced",
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
    status: "enforced",
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
    status: "enforced",
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
    status: "enforced",
    identity: { module: "src/sqlite-persistence-codec.ts", exportName },
    inputParameter: 0,
    fixtureCatalog: { module: "src/sqlite-persistence-codec.ts", exportName: fixtureExportName },
    provenance: ["current", "migrated", "missing-defaulted"],
  }),
);

const MINI_SQLITE_TODO_PERSISTED_CODEC = {
  status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/sqlite-todo-persistence-codec.ts",
    exportName: "readMiniLilacTodos",
  },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER = {
  status: "enforced",
  identity: { module: "src/sqlite-store.ts", exportName: "decodeMiniLilacTodos" },
  codecs: [MINI_SQLITE_TODO_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC = {
  status: "enforced",
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
  status: "enforced",
  identity: {
    module: "src/sqlite-history-persistence-codec.ts",
    exportName: "decodeMiniLilacMigrationRunRow",
  },
  category: "persistence",
  inputParameter: 0,
} as const satisfies ResultDecoderRegistration;

const MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER = {
  status: "enforced",
  identity: {
    module: "src/sqlite-store.ts",
    exportName: "MiniLilacSqliteStore.decodeStructuralHistoryRow",
  },
  codecs: [MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC.identity],
} as const satisfies PersistedStoreConsumerRegistration;

const MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER = {
  status: "enforced",
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
    status: "enforced",
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
  MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER.identity,
];

const MINI_SQLITE_STORE_RESULT_APIS = [
  "MiniLilacSqliteStore.decodeStructuralHistoryRow",
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

const UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY = {
  package: "@stanley2058/lilac-utils",
  module: "persistence.ts",
  exportName: "runBunSqliteTransaction",
} as const satisfies PackageSymbolIdentity;

const CORE_SQLITE_TRANSACTION_CONSUMERS = [
  {
    module: "src/conversation/thread-store.ts",
    exportName: "ConversationThreadStore.upsertSummary",
    status: "enforced" as const,
  },
  {
    module: "src/transcript/transcript-store.ts",
    exportName: "SqliteTranscriptStore.saveRequestTranscript",
    status: "enforced" as const,
  },
  ...[
    "SqliteTranscriptStore.admitCoreSurfaceProjection",
    "SqliteTranscriptStore.saveCorePrimaryLineageManifest",
    "SqliteTranscriptStore.unlinkSurfaceMessage",
    "SqliteTranscriptStore.deleteUnlinkedCheckpointCandidate",
    "SqliteTranscriptStore.publishCoreNamedClaudeSuccess",
    "SqliteTranscriptStore.publishCorePrimaryClaudeSuccess",
  ].map((exportName) => ({
    module: "src/transcript/transcript-store.ts",
    exportName,
    status: "enforced" as const,
  })),
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.createInvocation",
    status: "enforced" as const,
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "DurableWorkflowStore.applySurfaceAction",
    status: "enforced" as const,
  },
  {
    module: "src/workflow/durable-workflow-store.ts",
    exportName: "runWorkflowTransaction",
    status: "enforced" as const,
  },
  {
    module: "src/workflow/workflow-migrations.ts",
    exportName: "applyWorkflowSchemaMigrations",
    status: "enforced" as const,
  },
  ...[
    "SqliteGracefulRestartStore.clear",
    "SqliteGracefulRestartStore.saveCompletedSnapshot",
    "SqliteGracefulRestartStore.loadAndConsumeCompletedSnapshot",
  ].map((exportName) => ({
    module: "src/runtime/graceful-restart-store.ts",
    exportName,
    status: "enforced" as const,
  })),
].map(
  ({ status, ...identity }): SqliteTransactionConsumerRegistration => ({
    status,
    identity,
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  }),
);

const MINI_SQLITE_TRANSACTION_CONSUMERS = [
  {
    status: "enforced",
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.initializeSchemaResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
  {
    status: "enforced",
    identity: {
      module: "src/sqlite-store.ts",
      exportName: "MiniLilacSqliteStore.runStoreTransactionResult",
    },
    adapter: UTILS_SQLITE_TRANSACTION_ADAPTER_IDENTITY,
  },
] as const satisfies readonly SqliteTransactionConsumerRegistration[];

function coreEventScope(module: string, symbol: string) {
  return { workspace: "apps/core", module, symbol } as const;
}

const EVENT_BUS_FAMILY_MIGRATIONS = [
  {
    family: "command-request",
    members: ["cmd.request.message", "cmd.surface.output.reanchor", "cmd.agent.create"],
    scopes: [
      coreEventScope(
        "src/tool-server/request-message-cache.ts",
        "createRequestMessageCache.startRequestMessageCacheResult",
      ),
      coreEventScope("src/surface/bridge/bus-agent-runner.ts", "startBusAgentRunner"),
      coreEventScope("src/surface/bridge/subscribe-from-bus.ts", "bridgeBusToAdapter"),
    ],
  },
  {
    family: "workflow-control",
    members: [
      "evt.adapter.workflow-wait-resolver.barrier",
      "evt.workflow.run.changed",
      "evt.workflow.operation.changed",
      "evt.workflow.progress.requested",
      "evt.workflow.usage.changed",
      "evt.workflow.result.ready",
    ],
    scopes: [
      coreEventScope("src/workflow/workflow-engine.ts", "WorkflowEngine.startWakeSubscription"),
      coreEventScope(
        "src/workflow/workflow-live-parent-bridge.ts",
        "WorkflowLiveParentBridge.start",
      ),
      coreEventScope(
        "src/workflow/workflow-progress-projector.ts",
        "WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
      ),
    ],
  },
  {
    family: "lifecycle",
    members: ["evt.request.lifecycle.changed", "evt.request.reply"],
    scopes: [
      coreEventScope(
        "src/heartbeat/heartbeat-service.ts",
        "startHeartbeatService.startHeartbeatLifecycleResult",
      ),
      coreEventScope("src/surface/bridge/bus-request-router.ts", "startBusRequestRouter"),
      coreEventScope("src/surface/bridge/subscribe-from-bus.ts", "bridgeBusToAdapter"),
      coreEventScope("src/workflow/workflow-engine.ts", "WorkflowEngine.waitForAgentRequest"),
    ],
  },
  {
    family: "adapter",
    members: [
      "evt.adapter.message.created",
      "evt.adapter.message.updated",
      "evt.adapter.message.deleted",
      "evt.adapter.reaction.added",
      "evt.adapter.reaction.removed",
      "evt.adapter.action.invoked",
    ],
    scopes: [
      coreEventScope("src/surface/bridge/bus-request-router.ts", "startBusRequestRouter"),
      coreEventScope(
        "src/workflow/workflow-action-resolver.ts",
        "startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
      ),
      coreEventScope(
        "src/workflow/workflow-wait-resolver.ts",
        "WorkflowWaitResolver.startWorkflowWaitSubscriptionResult",
      ),
    ],
  },
  {
    family: "surface",
    members: ["evt.surface.output.message.created"],
    scopes: [coreEventScope("src/surface/bridge/bus-request-router.ts", "startBusRequestRouter")],
  },
  {
    family: "agent-output",
    members: [
      "evt.agent.output.delta.reasoning",
      "evt.agent.output.delta.text",
      "evt.agent.output.text.reset",
      "evt.agent.output.response.text",
      "evt.agent.output.response.binary",
      "evt.agent.output.toolcall",
      "evt.agent.output.activity",
    ],
    scopes: [
      coreEventScope("src/surface/bridge/subscribe-from-bus.ts", "bridgeBusToAdapter"),
      coreEventScope("src/workflow/workflow-engine.ts", "WorkflowEngine.waitForAgentRequest"),
      coreEventScope(
        "src/workflow/workflow-live-parent-bridge.ts",
        "WorkflowLiveParentBridge.ensureChildOutputSubscription",
      ),
      coreEventScope(
        "src/workflow/workflow-live-parent-bridge.ts",
        "WorkflowLiveParentBridge.reconcileTerminalChildActivity",
      ),
    ],
  },
].map(
  ({ family, members, scopes }): EventFamilyMigration => ({
    family,
    status: "migrated",
    codecRegistry: EVENT_BUS_CODEC_REGISTRY.identity,
    members,
    zeroBaselineScopes: scopes,
  }),
);

const CORE_EVENT_DELIVERY_CONSUMERS = [
  {
    identity: {
      module: "src/heartbeat/heartbeat-service.ts",
      exportName: "startHeartbeatService.startHeartbeatLifecycleResult",
    },
    apiPackage: "@stanley2058/lilac-event-bus",
    operations: ["subscribeTopic"],
  },
  {
    identity: {
      module: "src/tool-server/request-message-cache.ts",
      exportName: "createRequestMessageCache.startRequestMessageCacheResult",
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
      module: "src/surface/bridge/bus-request-router.ts",
      exportName: "startBusRequestRouter",
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

export const architectureManifest = {
  version: 1,
  workspaces: ACTIVE_WORKSPACES.map(([root, packageName]) => {
    const zeroBaselineScopes = [
      ...(STAGE_3_ZERO_BASELINE_MODULES.get(root) ?? []).map((module) => ({ module })),
      ...(root === "apps/core"
        ? [
            {
              module: "src/surface/bridge/bus-request-router/common.ts",
              symbol: "getDiscordFlags",
            },
            ...CORE_EVENT_DELIVERY_CONSUMERS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            ...CORE_THREAD_PERSISTED_CONSUMERS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            ...CORE_THREAD_PERSISTED_CODECS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            ...CORE_TRANSCRIPT_PERSISTED_CODECS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            {
              module: CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity.module,
              symbol: CORE_GRACEFUL_RESTART_PERSISTED_CODEC.identity.exportName,
            },
            {
              module: CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER.identity.module,
              symbol: CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER.identity.exportName,
            },
            {
              module: CORE_GRACEFUL_RESTART_ENCODER_CONSUMER.identity.module,
              symbol: CORE_GRACEFUL_RESTART_ENCODER_CONSUMER.identity.exportName,
            },
            {
              module: "src/runtime/graceful-restart-store.ts",
              symbol: "decodeOpaqueSuperJsonValue",
            },
            {
              module: CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity.module,
              symbol: CORE_WORKFLOW_ARTIFACT_PERSISTED_CODEC.identity.exportName,
            },
            {
              module: CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity.module,
              symbol: CORE_WORKFLOW_ROW_PERSISTED_CODEC.identity.exportName,
            },
            {
              module: CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER.identity.module,
              symbol: CORE_WORKFLOW_ARTIFACT_PERSISTED_CONSUMER.identity.exportName,
            },
            ...CORE_WORKFLOW_ROW_PERSISTED_CONSUMERS.map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
            ...CORE_WORKFLOW_STORE_READ_RESULT_APIS.map(({ module, exportName }) => ({
              module,
              symbol: exportName,
            })),
            {
              module: "src/workflow/workflow-artifact-store.ts",
              symbol: "writeWorkflowValueArtifact",
            },
            ...CORE_SQLITE_TRANSACTION_CONSUMERS.filter(
              ({ status, identity }) =>
                status === "enforced" &&
                ![
                  ...CORE_TRANSCRIPT_PERSISTED_CONSUMERS,
                  CORE_GRACEFUL_RESTART_PERSISTED_CONSUMER,
                ].some(
                  (consumer) =>
                    consumer.identity.module === identity.module &&
                    consumer.identity.exportName === identity.exportName,
                ),
            ).map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            })),
          ]
        : []),
      ...(root === "apps/mini-lilac-tui" ? STAGE_5_TUI_MODULES.map((module) => ({ module })) : []),
      ...(root === "packages/tool-results"
        ? [
            {
              module: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.module,
              symbol: TOOL_RESULT_ARTIFACT_METADATA_CODEC.identity.exportName,
            },
            {
              module: TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity.module,
              symbol: TOOL_RESULT_ARTIFACT_METADATA_CONSUMER.identity.exportName,
            },
            ...[
              "createToolResultArtifactStore.init",
              "createToolResultArtifactStore.create",
              "createToolResultArtifactStore.createFromFile",
              "createToolResultArtifactStore.createFromStream",
              "createToolResultArtifactStore.read",
              "createToolResultArtifactStore.readWindow",
              "createToolResultArtifactStore.maintain",
            ].map((symbol) => ({ module: "src/tool-result-artifact-store.ts", symbol })),
          ]
        : []),
      ...(root === "packages/mini-lilac-runtime"
        ? [
            ...MINI_WORKSPACE_HISTORY_PERSISTED_CODECS,
            ...MINI_SQLITE_TRANSCRIPT_PERSISTED_CODECS.filter(
              ({ status }) => status === "enforced",
            ),
            MINI_SQLITE_TODO_PERSISTED_CODEC,
            MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CODEC,
          ]
            .map(({ identity }) => ({
              module: identity.module,
              symbol: identity.exportName,
            }))
            .concat({
              module: MINI_SQLITE_TODO_PERSISTED_CONSUMER.identity.module,
              symbol: MINI_SQLITE_TODO_PERSISTED_CONSUMER.identity.exportName,
            })
            .concat({
              module: MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER.identity.module,
              symbol: MINI_SQLITE_TODO_STORE_PERSISTED_CONSUMER.identity.exportName,
            })
            .concat({
              module: MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER.identity.module,
              symbol: MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER.identity.exportName,
            })
            .concat({
              module: MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER.identity.module,
              symbol: MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER.identity.exportName,
            })
            .concat(
              MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS.filter(
                ({ status }) => status === "enforced",
              ).map(({ identity }) => ({
                module: identity.module,
                symbol: identity.exportName,
              })),
            )
            .concat(
              MINI_WORKSPACE_HISTORY_PERSISTED_CONSUMERS.map(({ identity }) => ({
                module: identity.module,
                symbol: identity.exportName,
              })),
            )
            .concat(
              MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => ({
                module: identity.module,
                symbol: identity.exportName,
              })),
            )
            .concat(
              MINI_SQLITE_STORE_RESULT_APIS.filter(
                ({ module, exportName }) =>
                  !MINI_SQLITE_TRANSCRIPT_PERSISTED_CONSUMERS.some(
                    ({ identity }) =>
                      identity.module === module && identity.exportName === exportName,
                  ) &&
                  !(
                    MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER.identity.module === module &&
                    MINI_SQLITE_STRUCTURAL_HISTORY_PERSISTED_CONSUMER.identity.exportName ===
                      exportName
                  ) &&
                  !(
                    MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER.identity.module === module &&
                    MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER.identity.exportName ===
                      exportName
                  ),
              ).map(({ module, exportName }) => ({ module, symbol: exportName })),
            )
            .concat(
              MINI_SESSION_SERVICE_RESULT_APIS.map(({ module, exportName }) => ({
                module,
                symbol: exportName,
              })),
            )
        : []),
    ];
    const stage3Zones = [
      ...(STAGE_3_ZERO_BASELINE_MODULES.get(root) ?? []),
      ...(root === "packages/tool-results"
        ? ["src/tool-result-artifact-metadata-codec.ts", "src/tool-result-artifact-store.ts"]
        : []),
    ].map((include) => ({ include }));
    const ruleZones: WorkspaceArchitecture["ruleZones"] = {
      ...EMPTY_POLICY.ruleZones,
      ...Object.fromEntries(
        STAGE_3_BOUNDARY_RULES.map((rule) => [
          rule,
          [...(EMPTY_POLICY.ruleZones[rule] ?? []), ...stage3Zones],
        ]),
      ),
      ...Object.fromEntries(
        STAGE_3_RESULT_RULES.map((rule) => [
          rule,
          [
            ...(root === "apps/core" ? STAGE_1_CORE_RULE_ZONES : []),
            ...(root === "apps/mini-lilac-tui"
              ? [{ include: "src/tool-observation-projection.ts" }]
              : []),
            ...stage3Zones,
          ],
        ]),
      ),
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
            : [],
      "architecture/unknown-free-module":
        root === "apps/mini-lilac-tui"
          ? TUI_UNKNOWN_FREE_MODULES.map(({ module }) => ({ include: module }))
          : [],
      "architecture/persisted-codec-contract":
        root === "packages/tool-results"
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
              : [],
      "architecture/persisted-codec-fixture-catalog":
        root === "packages/tool-results"
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
              : [],
      "architecture/sqlite-transaction-adapter-contract":
        root === "packages/utils" ? [{ include: "persistence.ts" }] : [],
      "architecture/sqlite-transaction-consumer":
        root === "apps/core"
          ? CORE_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => ({
              include: identity.module,
            }))
          : root === "packages/mini-lilac-runtime"
            ? MINI_SQLITE_TRANSACTION_CONSUMERS.map(({ identity }) => ({
                include: identity.module,
              }))
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
      zeroBaselineScopes,
      eventCodecRegistries: root === "packages/event-bus" ? [EVENT_BUS_CODEC_REGISTRY] : [],
      toolCodecRegistries: root === "apps/mini-lilac-tui" ? [TUI_TOOL_CODEC_REGISTRY] : [],
      resultDecoders:
        root === "apps/mini-lilac-tui"
          ? [TUI_RESULT_DECODER]
          : root === "packages/mini-lilac-runtime"
            ? [MINI_SQLITE_MIGRATION_RUN_RESULT_DECODER]
            : [],
      unknownFreeModules: root === "apps/mini-lilac-tui" ? TUI_UNKNOWN_FREE_MODULES : [],
      persistedCodecs:
        root === "packages/tool-results"
          ? [TOOL_RESULT_ARTIFACT_METADATA_CODEC]
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
        root === "packages/tool-results"
          ? [TOOL_RESULT_ARTIFACT_METADATA_CONSUMER]
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
                  MINI_SQLITE_HISTORY_RECOVERY_PERSISTED_CONSUMER,
                ]
              : [],
      sqliteTransactionAdapters:
        root === "packages/utils"
          ? [
              {
                status: "enforced",
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
                status: "enforced",
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
                status: "enforced",
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
                status: "enforced",
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
      eventFamilyMigrations: root === "packages/event-bus" ? EVENT_BUS_FAMILY_MIGRATIONS : [],
      boundaryDecoders: [
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
                  module: "src/surface/bridge/bus-request-router/common.ts",
                  exportName: "getDiscordFlags",
                },
                category: "projection",
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
      capabilityPredicates: INTEGRATED_CAPABILITY_PREDICATES.get(root) ?? [],
      exceptionAdapters: [
        ...(root === "packages/event-bus"
          ? ([
              {
                identity: {
                  module: "event-dead-letter.ts",
                  exportName: "checkedDeadLetterAcceptance",
                },
                category: "defect-supervisor",
                externalApi: { package: "better-result", exportName: "Panic" },
                direction: "observe-panic",
                reason:
                  "Signals a Panic only when a dead-letter adapter violates its nominal Result or receipt contract.",
              },
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
                ["event-dead-letter.ts", "captureDeadLetterAcceptance.catch"],
                ["lilac-bus.ts", "checkedDisposition"],
                ["lilac-bus.ts", "checkedHandlerResult"],
                ["lilac-bus.ts", "createLilacBus.bus.fetchTopic"],
                ["lilac-codecs.ts", "validateRequestPrimaryLineage"],
                ["lilac-codecs.ts", "decodeSchema"],
                ["redis-streams-bus.ts", "deliveryAction"],
                ["redis-streams-bus.ts", "RedisStreamsBus.subscribe"],
                ["redis-streams-bus.ts", "RedisStreamsBus.subscribe.acknowledge"],
                ["redis-streams-bus.ts", "RedisStreamsBus.subscribe.handleEntry"],
                ["redis-streams-bus.ts", "RedisStreamsBus.subscribe.stop"],
              ].map(([module, exportName]) => ({
                identity: { module, exportName },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason: "Preserves Panic while supervising an immediate event delivery boundary.",
              })),
              ...[
                ["redis-streams-bus.ts", "decodeSuperJson", "superjson", "SuperJSON.parse"],
                [
                  "redis-streams-bus.ts",
                  "RedisStreamsBus.subscribe.reportFatal",
                  "@stanley2058/lilac-event-bus",
                  "EventDeliveryFatalReporter.report",
                ],
              ].map(([module, exportName, packageName, externalName]) => ({
                identity: { module, exportName },
                category: "external-to-result" as const,
                externalApi: { package: packageName, exportName: externalName },
                direction: "capture-external" as const,
                reason:
                  "Captures the immediate external event transport or compatibility exception.",
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
                ["decodeRedisEventDeadLetterCiphertextEnvelope", "JSON.parse"],
                ["decryptRedisEventDeadLetterRecord", "SuperJSON.parse"],
              ].map(([exportName, externalName]) => ({
                identity: { module: "redis-event-dead-letter.ts", exportName },
                category: "external-to-result" as const,
                externalApi: { package: "serialization", exportName: externalName },
                direction: "capture-external" as const,
                reason:
                  "Maps malformed persisted dead-letter serialization to an owned recovery Result error.",
              })),
              ...[["redis-event-dead-letter.ts", "RedisEventDeadLetter.accept"]].map(
                ([module, exportName]) => ({
                  identity: { module, exportName },
                  category: "compatibility" as const,
                  externalApi: { package: "global", exportName: "Promise" },
                  direction: "signal-host" as const,
                  reason: "Signals through a temporary legacy or Result-capture host contract.",
                }),
              ),
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
                  "src/transcript/transcript-persistence-codec.ts",
                  "decodeSerialized",
                  "serialization",
                  "JSON.parse or SuperJSON.parse",
                  "Maps malformed transcript serialization to an owned persistence Result error.",
                ],
                [
                  "src/transcript/transcript-store.ts",
                  "SqliteTranscriptStore.readFromSqlite",
                  "bun:sqlite",
                  "Database.query",
                  "Maps immediate SQLite read failures to an owned transcript store Result error.",
                ],
                [
                  "src/transcript/transcript-store.ts",
                  "SqliteTranscriptStore.getCoreSurfaceProjection",
                  "node:crypto",
                  "createHash",
                  "Maps persisted owned-blob integrity failures to the projection read Result.",
                ],
              ].map(([module, exportName, packageName, externalName, reason]) => ({
                identity: { module, exportName },
                category: "external-to-result" as const,
                externalApi: { package: packageName, exportName: externalName },
                direction: "capture-external" as const,
                reason,
              })),
              ...[
                [
                  "src/transcript/transcript-store.ts",
                  "SqliteTranscriptStore.migrate",
                  "Signals migration validation failure through bun:sqlite's transaction rollback contract.",
                ],
              ].map(([module, exportName, reason]) => ({
                identity: { module, exportName },
                category: "rollback" as const,
                externalApi: { package: "bun:sqlite", exportName: "Database.transaction" },
                direction: "signal-host" as const,
                reason,
              })),
              ...[
                ["src/runtime/graceful-restart-store.ts", "parsePersistedPayload"],
                ["src/runtime/graceful-restart-store.ts", "encodeGracefulRestartSnapshot"],
                ["src/runtime/graceful-restart-store.ts", "decodeOpaqueSuperJsonValue"],
                ["src/transcript/transcript-persistence-codec.ts", "decodeSerialized"],
                ["src/transcript/transcript-store.ts", "SqliteTranscriptStore.readFromSqlite"],
                [
                  "src/transcript/transcript-store.ts",
                  "SqliteTranscriptStore.getCoreSurfaceProjection",
                ],
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
                  exportName: "captureIo.catch",
                },
                category: "external-to-result",
                externalApi: { package: "node:fs/promises", exportName: "filesystem operation" },
                direction: "capture-external",
                reason:
                  "Maps workflow artifact filesystem rejection to a bounded owned Result error.",
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
                externalApi: { package: "node:fs/promises", exportName: "lstat" },
                direction: "capture-external",
                reason:
                  "Separates an absent workflow artifact root from other filesystem failures.",
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
                reason:
                  "Preserves Panic identity while workflow artifact I/O is mapped to Results.",
              },
              {
                identity: {
                  module: "src/conversation/thread-summary-persistence-codec.ts",
                  exportName: "parseJson",
                },
                category: "external-to-result",
                externalApi: { package: "global", exportName: "JSON.parse" },
                direction: "capture-external",
                reason:
                  "Maps malformed persisted summary JSON to an owned persistence Result error.",
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
                reason:
                  "Preserves the original key read Panic when file-handle cleanup also fails.",
              },
              ...["captureFileOperation", "readMcpConfigFile", "serializeConfig"].map(
                (exportName) => ({
                  identity: { module: "src/mcp/config-file.ts", exportName: `${exportName}.catch` },
                  category: "defect-supervisor" as const,
                  externalApi: { package: "better-result", exportName: "Panic.is" },
                  direction: "observe-panic" as const,
                  reason:
                    "Preserves Panic while mapping the immediate filesystem or serialization exception.",
                }),
              ),
              ...["captureTextFileRead", "decodeJsonValue"].map((exportName) => ({
                identity: { module: "src/mcp/value-source.ts", exportName: `${exportName}.catch` },
                category: "defect-supervisor" as const,
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic" as const,
                reason: "Preserves Panic while mapping the immediate filesystem or JSON exception.",
              })),
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
              {
                identity: {
                  module: "src/workflow/workflow-action-resolver.ts",
                  exportName: "captureWorkflowActionOutboxPublication",
                },
                category: "defect-supervisor",
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic",
                reason: "Preserves Panic identity while capturing action outbox publication.",
              },
              {
                identity: {
                  module: "src/workflow/workflow-action-resolver.ts",
                  exportName: "captureWorkflowActionOutboxPublication",
                },
                category: "external-to-result",
                externalApi: {
                  package: "@stanley2058/lilac-event-bus",
                  exportName: "LilacBus.publish",
                },
                direction: "capture-external",
                reason: "Maps action outbox publication rejection to an owned Result error.",
              },
              ...[
                [
                  "WorkflowWaitResolver.captureWorkflowWaitResolverTrim",
                  "LilacBus.trimTopicBeforeCheckpoint",
                ],
                [
                  "WorkflowWaitResolver.captureWorkflowWaitResolverConsumerGroupRetirement",
                  "LilacBus.retireTopicConsumerGroup",
                ],
                [
                  "WorkflowWaitResolver.captureWorkflowWaitResolverBarrierPublication",
                  "LilacBus.publish",
                ],
                [
                  "WorkflowWaitResolver.captureWorkflowWaitResolverWakeupPublication",
                  "LilacBus.publish",
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
              {
                identity: {
                  module: "src/workflow/workflow-wait-resolver.ts",
                  exportName: "WorkflowWaitResolver.startWorkflowWaitSubscriptionResult",
                },
                category: "defect-supervisor",
                externalApi: {
                  package: "@stanley2058/lilac-event-bus",
                  exportName: "LilacBus.subscribeTopic",
                },
                direction: "observe-panic",
                reason:
                  "Releases the resolver lease while preserving a rejected subscription defect exactly.",
              },
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
                [
                  "captureWorkflowIdleCancellationPublication",
                  "@stanley2058/lilac-event-bus",
                  "LilacBus.publish",
                  "idle cancellation publication",
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
              {
                identity: {
                  module: "src/workflow/workflow-live-parent-bridge.ts",
                  exportName: "WorkflowLiveParentBridge.publishParentDisplay",
                },
                category: "defect-supervisor",
                externalApi: { package: "better-result", exportName: "Panic.is" },
                direction: "observe-panic",
                reason: "Preserves Panic while supervising queued live-parent status publication.",
              },
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
                identity: { module: "src/mcp/error-format.ts", exportName: "redactUrl" },
                category: "external-to-result",
                externalApi: { package: "global", exportName: "URL" },
                direction: "capture-external",
                reason: "Maps malformed URL text to a bounded redacted fallback.",
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
                  module: "src/mcp/registry.ts",
                  exportName: "McpRegistry.resolveTransport.catch",
                },
                category: "external-to-result",
                externalApi: {
                  package: "@stanley2058/lilac-core",
                  exportName: "McpRegistryDependencies.createAuthProvider/tokens",
                },
                direction: "capture-external",
                reason:
                  "Maps auth-provider creation and token-read rejections to owned Result errors.",
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
        ...(INTEGRATED_EXCEPTION_ADAPTERS.get(root) ?? []),
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
        ...(root === "apps/core"
          ? [
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
            ]
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
      status: MIGRATING_WORKSPACES.has(root) ? "migrating" : "inventory",
      name: root,
      packageName,
      root,
      tsconfig: `${root}/tsconfig.json`,
    };
  }),
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

function identityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
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

function scopeKey(scope: ZeroBaselineScope): string {
  return `${scope.module}#${scope.symbol ?? "**"}`;
}

export function zeroBaselineScopesByWorkspace(
  manifest: ArchitectureManifest,
): ReadonlyMap<string, readonly ZeroBaselineScope[]> {
  return new Map(
    manifest.workspaces.map((workspace) => [workspace.name, workspace.zeroBaselineScopes]),
  );
}

export function assertArchitectureManifestIntegrity(manifest: ArchitectureManifest): void {
  const workspacesByName = new Map(
    manifest.workspaces.map((workspace) => [workspace.name, workspace] as const),
  );
  for (const workspace of manifest.workspaces) {
    const operationalResultApiKeys = new Set(
      workspace.operationalResultApis.map((identity) => identityKey(identity)),
    );
    const zeroScopeKeys = new Set<string>();
    for (const scope of workspace.zeroBaselineScopes) {
      requireNonempty(scope.module, "zero-baseline scope module");
      if (scope.module.includes("*")) {
        throw new Error(
          `Architecture manifest zero-baseline scope must name an exact module: ${scope.module}.`,
        );
      }
      if (scope.symbol !== undefined) {
        requireNonempty(scope.symbol, "zero-baseline scope symbol");
        if (scope.symbol.includes("*") || scope.symbol === "<module>") {
          throw new Error(
            `Architecture manifest zero-baseline scope must name an exact symbol: ${scope.module}#${scope.symbol}.`,
          );
        }
      }
      const key = scopeKey(scope);
      if (zeroScopeKeys.has(key)) {
        throw new Error(`Duplicate zero-baseline scope in ${workspace.name}: ${key}.`);
      }
      zeroScopeKeys.add(key);
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
      if (
        consumer.status === "enforced" &&
        !workspace.zeroBaselineScopes.some((scope) =>
          zeroBaselineScopeOwns(scope, consumer.identity.module, consumer.identity.exportName),
        )
      ) {
        throw new Error(
          `Enforced persisted store consumer ${key} must be owned by a descendant-aware zero-baseline scope.`,
        );
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
      if (
        consumer.status === "enforced" &&
        !workspace.zeroBaselineScopes.some((scope) =>
          zeroBaselineScopeOwns(scope, consumer.identity.module, consumer.identity.exportName),
        )
      ) {
        throw new Error(
          `Enforced SQLite transaction consumer ${key} must be owned by a descendant-aware zero-baseline scope.`,
        );
      }
    }
    for (const exception of [...workspace.opaqueUnknown, ...workspace.capabilityPredicates]) {
      requireExactIdentity(exception.identity, "reasoned symbol registration");
      requireNonempty(exception.reason, "reasoned symbol registration reason");
    }
    for (const adapter of workspace.exceptionAdapters) {
      requireExactIdentity(adapter.identity, "exception adapter");
      requireNonempty(adapter.externalApi.package, "exception adapter external package");
      requireNonempty(adapter.externalApi.exportName, "exception adapter external exportName");
      requireNonempty(adapter.reason, "exception adapter reason");
    }
    for (const api of workspace.operationalResultApis) {
      requireExactIdentity(api, "operational Result API");
    }
    const codecRegistries = new Map<string, EventCodecRegistryRegistration>();
    for (const registry of workspace.eventCodecRegistries) {
      requireExactIdentity(registry.identity, "event codec registry");
      requireExactIdentity(registry.canonicalEvents, "canonical event catalog");
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
      codecRegistries.set(key, registry);
      const canonical = requireUniqueValues(
        registry.canonicalMembers,
        `event codec registry ${key} canonicalMembers`,
      );
      if (canonical.size === 0) {
        throw new Error(`Architecture manifest event codec registry ${key} must declare members.`);
      }
      const codecs = requireUniqueValues(
        registry.codecMembers,
        `event codec registry ${key} codecMembers`,
      );
      for (const member of codecs) {
        if (!canonical.has(member)) {
          throw new Error(
            `Architecture manifest event codec registry ${key} covers noncanonical member '${member}'.`,
          );
        }
      }
      if (registry.status === "enforced" && codecs.size !== canonical.size) {
        throw new Error(
          `Enforced event codec registry ${key} must declare codec coverage for every canonical member.`,
        );
      }
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
      if (
        !zeroScopeKeys.has(
          scopeKey({ module: consumer.identity.module, symbol: consumer.identity.exportName }),
        )
      ) {
        throw new Error(
          `Event delivery consumer ${key} must own an exact workspace zero-baseline symbol scope.`,
        );
      }
    }
    const familyNames = new Set<string>();
    const claimedMembers = new Map<string, string>();
    for (const family of workspace.eventFamilyMigrations) {
      requireNonempty(family.family, "event family name");
      if (familyNames.has(family.family)) {
        throw new Error(`Duplicate event family migration in ${workspace.name}: ${family.family}.`);
      }
      familyNames.add(family.family);
      const registryKey = identityKey(family.codecRegistry);
      requireExactIdentity(family.codecRegistry, "event family codec registry");
      const registry = codecRegistries.get(registryKey);
      if (!registry) {
        throw new Error(
          `Event family ${family.family} in ${workspace.name} references unregistered codec registry ${registryKey}.`,
        );
      }
      const members = requireUniqueValues(family.members, `event family ${family.family} members`);
      if (members.size === 0) {
        throw new Error(
          `Architecture manifest event family ${family.family} must declare members.`,
        );
      }
      for (const member of members) {
        const previous = claimedMembers.get(`${registryKey}\0${member}`);
        if (previous) {
          throw new Error(
            `Event family members must not overlap in ${workspace.name}: '${member}' is claimed by ${previous} and ${family.family}.`,
          );
        }
        claimedMembers.set(`${registryKey}\0${member}`, family.family);
        if (!registry.canonicalMembers.includes(member)) {
          throw new Error(
            `Event family ${family.family} in ${workspace.name} contains noncanonical member '${member}'.`,
          );
        }
        if (family.status === "migrated" && !registry.codecMembers.includes(member)) {
          throw new Error(
            `Migrated event family ${family.family} lacks codec coverage for '${member}'.`,
          );
        }
      }
      if (family.status === "migrated") {
        if (family.zeroBaselineScopes.length === 0) {
          throw new Error(
            `Migrated event family ${family.family} must declare at least one zero-baseline scope.`,
          );
        }
        for (const scope of family.zeroBaselineScopes) {
          requireNonempty(scope.workspace, "event family zero-baseline workspace");
          requireNonempty(scope.module, "event family zero-baseline module");
          requireNonempty(scope.symbol ?? "", "event family zero-baseline symbol");
          const targetWorkspace = workspacesByName.get(scope.workspace);
          const owned = targetWorkspace?.zeroBaselineScopes.some(
            (candidate) => scopeKey(candidate) === scopeKey(scope),
          );
          if (!targetWorkspace || !owned) {
            throw new Error(
              `Migrated event family ${family.family} zero-baseline scope ${scope.workspace}/${scopeKey(scope)} is not owned by that workspace.`,
            );
          }
          const registeredOwner =
            targetWorkspace.eventDeliveryConsumers.some(
              (consumer) =>
                consumer.identity.module === scope.module &&
                consumer.identity.exportName === scope.symbol,
            ) ||
            targetWorkspace.eventDeliveryApis.some(
              (api) =>
                api.identity.module === scope.module && api.identity.exportName === scope.symbol,
            );
          if (!registeredOwner) {
            throw new Error(
              `Migrated event family ${family.family} zero-baseline scope ${scope.workspace}/${scopeKey(scope)} is not an exact event delivery registration.`,
            );
          }
        }
      }
    }
    for (const [registryKey, registry] of codecRegistries) {
      const unclaimed = registry.canonicalMembers.filter(
        (member) => !claimedMembers.has(`${registryKey}\0${member}`),
      );
      if (unclaimed.length > 0) {
        throw new Error(
          `Event family declarations for ${registryKey} are not exhaustive; missing ${unclaimed.join(", ")}.`,
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
}
