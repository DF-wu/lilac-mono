import type { ArchitectureManifest, WorkspaceArchitecture } from "../../manifest.ts";

const EMPTY_POLICY = {
  ruleZones: {
    "architecture/no-unknown-assertion": [{ include: "**" }],
  },
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

const workspaces = [
  {
    ...EMPTY_POLICY,
    name: "fixture-clean",
    packageName: "architecture-workspace-runner-clean-fixture",
    root: "scripts/architecture/fixtures/workspace-runner/clean",
    tsconfig: "scripts/architecture/fixtures/workspace-runner/clean/tsconfig.json",
  },
  {
    ...EMPTY_POLICY,
    name: "fixture-findings",
    packageName: "architecture-workspace-runner-findings-fixture",
    root: "scripts/architecture/fixtures/workspace-runner/findings",
    tsconfig: "scripts/architecture/fixtures/workspace-runner/findings/tsconfig.json",
  },
] as const satisfies readonly WorkspaceArchitecture[];

export const workspaceRunnerFixtureManifest = {
  version: 1,
  workspaces,
} as const satisfies ArchitectureManifest;
