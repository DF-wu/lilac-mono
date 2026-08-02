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

const DEFAULT_RULE_ZONES = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [
    rule,
    STAGE_1_PILOT_RULES.has(rule) ? [] : [{ include: "**" }],
  ]),
);

const EMPTY_POLICY = {
  status: "inventory",
  ruleZones: DEFAULT_RULE_ZONES,
  boundaryDecoders: [],
  opaqueUnknown: [],
  capabilityPredicates: [],
  exceptionAdapters: [],
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

export const architectureManifest = {
  version: 1,
  workspaces: ACTIVE_WORKSPACES.map(([root, packageName]) => ({
    ...EMPTY_POLICY,
    ruleZones:
      root === "apps/core"
        ? {
            ...EMPTY_POLICY.ruleZones,
            "architecture/no-unhandled-exception-contract": [
              { include: "src/mcp/value-source.ts" },
              { include: "src/mcp/config-file.ts" },
            ],
            "architecture/no-unredacted-tagged-error-log": [
              { include: "src/mcp/value-source.ts" },
              { include: "src/mcp/config-file.ts" },
            ],
            "architecture/fallible-api-result": [
              { include: "src/mcp/value-source.ts" },
              { include: "src/mcp/config-file.ts" },
            ],
          }
        : EMPTY_POLICY.ruleZones,
    boundaryDecoders:
      root === "apps/core"
        ? [
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
          ]
        : [],
    opaqueUnknown:
      root === "apps/core"
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
        : [],
    exceptionAdapters:
      root === "apps/core"
        ? [
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
          ]
        : [],
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
    operationalResultApis:
      root === "apps/core"
        ? [
            { module: "src/mcp/config-file.ts", exportName: "readMcpConfigFile" },
            { module: "src/mcp/config-file.ts", exportName: "writeMcpConfigFileAtomic" },
            { module: "src/mcp/config-file.ts", exportName: "mutateMcpConfigFile" },
            { module: "src/mcp/value-source.ts", exportName: "resolveJsonPointer" },
            { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSource" },
            { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSourceMap" },
            { module: "src/mcp/value-source.ts", exportName: "validateHttpHeaders" },
          ]
        : [],
    taggedErrorFormatters:
      root === "apps/core"
        ? [
            {
              kind: "external",
              package: "@stanley2058/lilac-utils",
              exportName: "formatTaggedErrorForLog",
            },
          ]
        : [],
    name: root,
    packageName,
    root,
    tsconfig: `${root}/tsconfig.json`,
  })),
} satisfies ArchitectureManifest;
