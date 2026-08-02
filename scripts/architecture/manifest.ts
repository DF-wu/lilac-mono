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

const SCOPED_STAGE_2_RULES = new Set<ArchitectureRule>([
  "architecture/open-protocol-normalization",
]);

const DEFAULT_RULE_ZONES = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [
    rule,
    STAGE_1_PILOT_RULES.has(rule) || SCOPED_STAGE_2_RULES.has(rule) ? [] : [{ include: "**" }],
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
  "packages/utils",
]);

export const STAGE_3_MODULES = new Map<string, readonly string[]>([
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
    "apps/core",
    [
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
    "packages/utils",
    [
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

export const architectureManifest = {
  version: 1,
  workspaces: ACTIVE_WORKSPACES.map(([root, packageName]) => {
    const stage3Zones = (STAGE_3_MODULES.get(root) ?? []).map((include) => ({ include }));
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
          [...(root === "apps/core" ? STAGE_1_CORE_RULE_ZONES : []), ...stage3Zones],
        ]),
      ),
      "architecture/open-protocol-normalization": OPEN_PROTOCOL_RULE_ZONES.get(root) ?? [],
    };
    return {
      ...EMPTY_POLICY,
      ruleZones,
      boundaryDecoders: [
        ...(root === "apps/core"
          ? ([
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
            ] satisfies readonly BoundaryDecoder[])
          : []),
        ...(INTEGRATED_BOUNDARY_DECODERS.get(root) ?? []),
      ],
      openProtocolAdapters: INTEGRATED_OPEN_PROTOCOL_ADAPTERS.get(root) ?? [],
      opaqueUnknown: [
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
        ...(INTEGRATED_OPAQUE_UNKNOWN.get(root) ?? []),
      ],
      capabilityPredicates: INTEGRATED_CAPABILITY_PREDICATES.get(root) ?? [],
      exceptionAdapters: [
        ...(root === "apps/core"
          ? ([
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
              { module: "src/mcp/config-file.ts", exportName: "readMcpConfigFile" },
              { module: "src/mcp/config-file.ts", exportName: "writeMcpConfigFileAtomic" },
              { module: "src/mcp/config-file.ts", exportName: "mutateMcpConfigFile" },
              { module: "src/mcp/value-source.ts", exportName: "resolveJsonPointer" },
              { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSource" },
              { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSourceMap" },
              { module: "src/mcp/value-source.ts", exportName: "validateHttpHeaders" },
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

export function assertArchitectureManifestIntegrity(manifest: ArchitectureManifest): void {
  for (const workspace of manifest.workspaces) {
    for (const decoder of workspace.boundaryDecoders) {
      requireExactIdentity(decoder.identity, "boundary decoder");
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
