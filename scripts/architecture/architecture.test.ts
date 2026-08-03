import path from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";
import ts from "typescript-codegen";

import { analyzeWorkspace, declarationPackageName } from "./analyzer.ts";
import { applyBaselines, baselineFromFindings, formatBaselineModule } from "./baseline.ts";
import { boundaryValidationBaseline } from "./boundary-validation.baseline.ts";
import { failureFlowBaseline } from "./failure-flow.baseline.ts";
import { createFingerprint } from "./fingerprint.ts";
import type {
  ArchitectureManifest,
  OpenProtocolAdapter,
  PersistedCodecRegistration,
  ResultDecoderRegistration,
  SqliteTransactionAdapterRegistration,
  ToolCodecRegistryRegistration,
  WorkspaceArchitecture,
  ZeroBaselineScope,
} from "./manifest.ts";
import {
  architectureManifest,
  assertArchitectureManifestIntegrity,
  zeroBaselineScopeOwns,
} from "./manifest.ts";
import type {
  ArchitectureBaseline,
  ArchitectureDiagnostic,
  ArchitectureRule,
  BaselineEntry,
} from "./model.ts";
import { createWorkspaceProgram } from "./program.ts";
import { analyzeArchitecture } from "./runner.ts";
import { isProductionFileName } from "./source-policy.ts";
import {
  assertWorkspaceInventoryMatches,
  compareWorkspaceInventory,
} from "./workspace-inventory.ts";
import { syntaxBaseline } from "../oxlint-plugins/syntax-baseline.mts";
import type {
  SyntaxBaseline,
  SyntaxBaselineEntry,
} from "../oxlint-plugins/check-syntax-ratchet.mts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE_ROOT = path.join(import.meta.dir, "fixtures/stage0");
const FIXTURE_TSCONFIG = "scripts/architecture/fixtures/stage0/tsconfig.json";

const BASE_WORKSPACE = {
  name: "fixture",
  packageName: "architecture-fixture",
  root: "scripts/architecture/fixtures/stage0",
  tsconfig: FIXTURE_TSCONFIG,
  status: "migrating",
  ruleZones: {},
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
    boundaryValidation: "boundary-validation.baseline.ts",
    failureFlow: "failure-flow.baseline.ts",
  },
} as const satisfies WorkspaceArchitecture;

const fixtureProgram = createWorkspaceProgram(REPOSITORY_ROOT, BASE_WORKSPACE).program;

function findingsFor(
  rule: ArchitectureRule,
  file: string,
  overrides: Partial<WorkspaceArchitecture> = {},
): readonly ArchitectureDiagnostic[] {
  const workspace = {
    ...BASE_WORKSPACE,
    ...overrides,
    ruleZones: { [rule]: [{ include: file }] },
  } satisfies WorkspaceArchitecture;
  return analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram);
}

function openProtocolAdapter(
  exportName: string,
  overrides: Partial<OpenProtocolAdapter> = {},
): OpenProtocolAdapter {
  return {
    identity: { module: "unions.ts", exportName },
    externalProtocol: { package: "open-protocol-sdk", exportName: "ProtocolEvent" },
    protocolParameter: 0,
    fallbackVariant: { discriminant: "kind", value: "unsupported" },
    reason: "Fixture open protocol normalization boundary.",
    ...overrides,
  };
}

const FIXTURE_EVENT_MEMBERS = ["fixture.alpha", "fixture.beta", "fixture.gamma"] as const;

function fixtureCodecRegistry(exportName: string) {
  return {
    status: "enforced" as const,
    identity: { module: "stage4-events.ts", exportName },
    canonicalEvents: {
      module: "stage4-events.ts",
      exportName: "canonicalFixtureEvents",
    },
    canonicalMembers: FIXTURE_EVENT_MEMBERS,
    codecMembers: FIXTURE_EVENT_MEMBERS,
  };
}

function fixtureRawBoundary(exportName: string) {
  return {
    status: "enforced" as const,
    identity: { module: "stage4-events.ts", exportName },
    messageType: { package: "architecture-fixture", exportName: "Message" },
    handlerParameter: 0,
    messageParameter: 0,
    contextParameter: 1,
  };
}

function fixtureDeliveryApi(exportName: string, deliveryPolicy: string) {
  return {
    status: "enforced" as const,
    identity: { module: "stage4-events.ts", exportName },
    handlerParameter: 0,
    handlerMessageParameter: 0,
    handlerContextParameter: 1,
    deliveryPolicy: { module: "stage4-events.ts", exportName: deliveryPolicy },
    deliveryErrorParameter: 0,
  };
}

function fixtureToolCodecRegistry(exportName: string): ToolCodecRegistryRegistration {
  return {
    status: "enforced",
    identity: { module: "stage5-tools.ts", exportName },
    aliases: [],
    canonicalTools: { module: "stage5-tools.ts", exportName: "canonicalTuiToolNames" },
  };
}

function fixtureResultDecoder(exportName: string): ResultDecoderRegistration {
  return {
    status: "enforced",
    identity: { module: "stage5-tools.ts", exportName },
    category: "projection",
    inputParameter: 0,
  };
}

describe("boundary validation rules", () => {
  test("resolves imported schemas and aliases but permits registered decoder ownership", () => {
    const findings = findingsFor("architecture/no-unregistered-decoder", "**", {
      boundaryDecoders: [
        {
          identity: { module: "boundary.ts", exportName: "registeredDecode" },
          category: "request",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location?.line).toBe(18);
    expect(findings[0]?.suggestion).toContain("registered boundary decoder");
  });

  test("rejects domain unknown including z.input while allowing typed output and reasoned opaque utilities", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "domain.ts", {
      opaqueUnknown: [
        {
          identity: { module: "domain.ts", exportName: "opaqueStringify" },
          reason: "This utility preserves an opaque value and only requests String coercion.",
        },
      ],
    });
    const names = findings.map((finding) => finding.message);
    expect(names.some((message) => message.includes("consumeUnknown"))).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 9)).toBeTrue();
    expect(findings.some((finding) => finding.location?.line === 13)).toBeTrue();
    expect(findings.some((finding) => finding.location?.line === 17)).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 21)).toBeFalse();
  });

  test("matches reasoned opaque interface methods without exempting their module", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "domain.ts", {
      opaqueUnknown: [
        {
          identity: { module: "domain.ts", exportName: "OpaqueContract.accept" },
          reason: "Fixture interface method deliberately accepts an opaque extension value.",
        },
      ],
    });
    expect(findings.some((finding) => finding.location?.line === 51)).toBeFalse();
    expect(findings.some((finding) => finding.location?.line === 52)).toBeTrue();
  });

  test("exception adapters exempt only their exact callable unknown parameters", () => {
    const findings = findingsFor("architecture/no-domain-unknown", "exception-adapter.ts", {
      exceptionAdapters: [
        {
          identity: { module: "exception-adapter.ts", exportName: "exactExceptionAdapter" },
          category: "external-to-result",
          externalApi: { package: "fixture", exportName: "operation" },
          direction: "capture-external",
          reason: "Fixture exact exception adapter.",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("payload");
    expect(findings[0]?.identity).toContain("exactExceptionAdapter.inspectNested");
  });

  test("rejects only structured assertions whose resolved source is unknown", () => {
    const findings = findingsFor("architecture/no-unknown-assertion", "domain.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location?.line).toBe(26);
  });

  test("handles overloads and callbacks and permits exact capability predicates", () => {
    const findings = findingsFor("architecture/no-rich-unknown-predicate", "domain.ts", {
      capabilityPredicates: [
        {
          identity: { module: "domain.ts", exportName: "isCapability" },
          reason: "Checks the exact optional protocol capability before adapter normalization.",
        },
      ],
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      "Predicate isDomain promises a structured type from unknown.",
      "Predicate overloaded promises a structured type from unknown.",
      "Predicate <callback> promises a structured type from unknown.",
    ]);
  });

  test("does not resolve unrelated calls or functions without explicit predicates", () => {
    const checker = fixtureProgram.getTypeChecker();
    let resolvedCalls = 0;
    let resolvedPredicates = 0;
    const instrumentedChecker = new Proxy(checker, {
      get(target, property, receiver) {
        if (property === "getResolvedSignature") {
          return (...parameters: Parameters<ts.TypeChecker["getResolvedSignature"]>) => {
            resolvedCalls += 1;
            return target.getResolvedSignature(...parameters);
          };
        }
        if (property === "getSignatureFromDeclaration") {
          return (...parameters: Parameters<ts.TypeChecker["getSignatureFromDeclaration"]>) => {
            resolvedPredicates += 1;
            return target.getSignatureFromDeclaration(...parameters);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const instrumentedProgram = new Proxy(fixtureProgram, {
      get(target, property, receiver) {
        if (property === "getTypeChecker") return () => instrumentedChecker;
        return Reflect.get(target, property, receiver);
      },
    });
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/no-production-unwrap": [{ include: "performance.ts" }],
        "architecture/no-rich-unknown-predicate": [{ include: "performance.ts" }],
      },
    } satisfies WorkspaceArchitecture;

    expect(analyzeWorkspace(workspace, FIXTURE_ROOT, instrumentedProgram)).toHaveLength(0);
    expect(resolvedCalls).toBe(0);
    expect(resolvedPredicates).toBe(0);
  });
});

describe("failure flow rules", () => {
  test("resolves instance and aliased unsafe Result extraction", () => {
    const findings = findingsFor("architecture/no-production-unwrap", "result.ts");
    expect(findings).toHaveLength(4);
  });

  test("rejects only captures whose selected overload exposes UnhandledException", () => {
    const findings = findingsFor("architecture/no-unmapped-result-capture", "result.ts");
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.message.includes("UnhandledException"))).toBeTrue();
  });

  test("registers Panic by movement-tolerant exact callsite fingerprint", () => {
    const initial = findingsFor("architecture/registered-panic-site", "result.ts");
    expect(initial).toHaveLength(2);
    const findings = findingsFor("architecture/registered-panic-site", "result.ts", {
      panicSites: [
        {
          fingerprint: initial[0]?.fingerprint ?? "missing",
          reason: "The fixture proves exact hard-invariant registration.",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).not.toBe(initial[0]?.fingerprint);
  });

  test("uses resolved Result and TaggedError types only at registered outputs", () => {
    const findings = findingsFor("architecture/no-result-wire-leak", "result.ts", {
      compatibilityOutputs: [
        {
          sink: { kind: "external", package: "wire-api", exportName: "send" },
          category: "worker",
          reason: "The worker wire contract predates better-result.",
        },
        {
          sink: { kind: "local", module: "result.ts", exportName: "localJsonResponse" },
          category: "http",
          reason: "The HTTP response shape predates better-result.",
        },
      ],
    });
    expect(findings).toHaveLength(4);
    expect(findings.some((finding) => finding.message.includes("worker"))).toBeTrue();
    expect(findings.some((finding) => finding.message.includes("http"))).toBeTrue();
  });
});

describe("Stage 2 union rules", () => {
  test("requires exhaustive project-owned switches across imports, aliases, discriminants, and generics", () => {
    const findings = findingsFor("architecture/closed-union-exhaustiveness", "unions.ts");
    expect(findings).toHaveLength(11);
    expect(findings.some((finding) => finding.message.includes('missing "complete"'))).toBeTrue();
    expect(findings.some((finding) => finding.message.includes('missing "deleted"'))).toBeTrue();
    expect(
      findings.some((finding) => finding.message.includes("uses a silent default")),
    ).toBeTrue();
    expect(findings.every((finding) => finding.suggestion.includes("never sink"))).toBeTrue();
    expect(findings.some((finding) => finding.identity.includes("thirdPartySwitch"))).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("launderedThirdPartySwitch")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("wrappedThirdPartySwitch")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("exhaustiveWithNeverSink")),
    ).toBeFalse();
    expect(
      findings.some((finding) => finding.identity.includes("exhaustivePropertyWithNeverSink")),
    ).toBeFalse();
    expect(findings.some((finding) => finding.identity.includes("unrelatedNeverSink"))).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredFunctionSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteInferredObjectSwitch")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("incompleteShorthandObjectSwitch")),
    ).toBeTrue();
  });

  test("follows imported maps and accepts checked imported and intermediate assignments", () => {
    const findings = findingsFor("architecture/closed-union-map-exhaustiveness", "unions.ts");
    expect(findings).toHaveLength(7);
    expect(findings.every((finding) => finding.message.includes("compiler-checked"))).toBeTrue();
    expect(findings.some((finding) => finding.location?.file === "union-types.ts")).toBeTrue();
    expect(findings.filter((finding) => finding.location?.file === "union-types.ts")).toHaveLength(
      2,
    );
  });

  test("deduplicates exhaustive map findings by source file and position", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/closed-union-map-exhaustiveness": [
          { include: "map-a.ts" },
          { include: "map-b.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    const findings = analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.location?.file).sort()).toEqual([
      "map-a.ts",
      "map-b.ts",
    ]);
  });

  test("checks unindexed nested map property assignments and preserves exhaustive contracts", () => {
    const findings = findingsFor("architecture/closed-union-map-exhaustiveness", "nested-maps.ts");
    expect(findings).toHaveLength(7);
    expect(findings.every((finding) => finding.location?.file === "nested-maps.ts")).toBeTrue();
    expect(findings.every((finding) => finding.message.includes("compiler-checked"))).toBeTrue();
  });

  test("validates exact external input, closed local output, and explicit open fallback", () => {
    const valid = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    });
    expect(valid).toEqual([]);

    const missingFallback = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeWithoutExplicitFallback"),
      ],
    });
    expect(missingFallback).toHaveLength(1);
    expect(missingFallback[0]?.message).toContain("never explicitly returns");

    const wrongInput = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeLocalValue"),
      ],
    });
    expect(wrongInput).toHaveLength(1);
    expect(wrongInput[0]?.message).toContain("not the named external protocol");

    const aliasInput = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
      openProtocolAdapters: [
        openProtocolAdapter("normalizeProtocolEvent"),
        openProtocolAdapter("normalizeAliasedProtocolEvent"),
      ],
    });
    expect(aliasInput).toEqual([]);

    for (const exportName of ["normalizeWrappedProtocolEvent", "normalizeUnionProtocolEvent"]) {
      const inexact = findingsFor("architecture/open-protocol-normalization", "unions.ts", {
        openProtocolAdapters: [
          openProtocolAdapter("normalizeProtocolEvent"),
          openProtocolAdapter(exportName),
        ],
      });
      expect(inexact).toHaveLength(1);
      expect(inexact[0]?.message).toContain("not the named external protocol");
    }
  });

  test("rejects direct external protocol switching outside the exact adapter", () => {
    const findings = findingsFor("architecture/open-protocol-normalization", "open-consumer.ts", {
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    });
    expect(findings).toHaveLength(4);
    expect(findings.every((finding) => finding.message.includes("switched directly"))).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeAliasedProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) => finding.identity.includes("consumeDestructuredProtocolDirectly")),
    ).toBeTrue();
    expect(
      findings.some((finding) =>
        finding.identity.includes("consumePropertyAliasedProtocolDirectly"),
      ),
    ).toBeTrue();
    expect(
      findings.every((finding) =>
        finding.suggestion.includes("exactly registered open-protocol adapter"),
      ),
    ).toBeTrue();
  });

  test("fails stale open-protocol registrations that do not resolve to a callable", () => {
    expect(() =>
      findingsFor("architecture/open-protocol-normalization", "unions.ts", {
        openProtocolAdapters: [openProtocolAdapter("misspelledProtocolAdapter")],
      }),
    ).toThrow("must resolve to exactly one callable implementation; found 0");
  });

  test("requires nonempty unique open-protocol registrations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/open-protocol-normalization": [{ include: "unions.ts" }],
      },
      openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent")],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            openProtocolAdapters: [
              openProtocolAdapter("normalizeProtocolEvent"),
              openProtocolAdapter("normalizeProtocolEvent"),
            ],
          },
        ],
      }),
    ).toThrow("Duplicate open-protocol adapter registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            openProtocolAdapters: [openProtocolAdapter("normalizeProtocolEvent", { reason: "" })],
          },
        ],
      }),
    ).toThrow("reason must be nonempty");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            ruleZones: {
              "architecture/open-protocol-normalization": [{ include: "consumer.ts" }],
            },
          },
        ],
      }),
    ).toThrow("outside its workspace rule zones");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...workspace,
            ruleZones: {
              "architecture/open-protocol-normalization": [{ include: "**" }],
            },
          },
        ],
      }),
    ).toThrow("must name an exact module");
  });

  test("activates closed unions globally and open protocols only in exact registered zones", () => {
    expect(() => assertArchitectureManifestIntegrity(architectureManifest)).not.toThrow();
    for (const workspace of architectureManifest.workspaces) {
      const zones: WorkspaceArchitecture["ruleZones"] = workspace.ruleZones;
      expect(zones["architecture/closed-union-exhaustiveness"]).toEqual([{ include: "**" }]);
      expect(zones["architecture/closed-union-map-exhaustiveness"]).toEqual([{ include: "**" }]);
    }
    const acp = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/acp-controller",
    );
    const tui = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/mini-lilac-tui",
    );
    expect(acp?.ruleZones["architecture/open-protocol-normalization"]).toEqual([
      { include: "session-history.ts" },
    ]);
    expect(acp?.openProtocolAdapters).toEqual([
      {
        identity: { module: "session-history.ts", exportName: "projectSessionUpdate" },
        externalProtocol: { package: "@agentclientprotocol/sdk", exportName: "SessionUpdate" },
        protocolParameter: 0,
        fallbackVariant: { discriminant: "type", value: "unsupported" },
        reason:
          "Defense-in-depth projection for runtime ACP version skew; the SDK normally validates SessionUpdate before this adapter runs.",
      },
    ]);
    expect(tui?.ruleZones["architecture/open-protocol-normalization"]).toEqual([
      { include: "src/ui-message-chunk-projection.ts" },
      { include: "src/render.ts" },
    ]);
    expect(tui?.openProtocolAdapters).toEqual([
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
    ]);
    expect(
      architectureManifest.workspaces
        .filter(
          (workspace) =>
            workspace.root !== "apps/acp-controller" && workspace.root !== "apps/mini-lilac-tui",
        )
        .every(
          (workspace) =>
            workspace.ruleZones["architecture/open-protocol-normalization"]?.length === 0 &&
            workspace.openProtocolAdapters.length === 0,
        ),
    ).toBeTrue();
  });

  test("registers exact wire, projection, CLI, and remote-runner boundary decoders", () => {
    const acp = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/acp-controller",
    );
    const miniServer = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/mini-lilac-server",
    );
    const miniRuntime = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/mini-lilac-runtime",
    );
    const remoteRunner = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/remote-fs-runner",
    );
    const fs = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/fs",
    );
    const tui = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/mini-lilac-tui",
    );
    const miniClient = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/mini-lilac-client",
    );
    expect(acp?.boundaryDecoders).toEqual([]);
    expect(tui?.boundaryDecoders).toEqual([
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
    ]);
    expect(miniClient?.boundaryDecoders).toEqual([
      {
        identity: { module: "mini-lilac-transport.ts", exportName: "normalizeStreamChunk" },
        category: "wire",
      },
    ]);
    expect(miniServer?.boundaryDecoders).toEqual([
      {
        identity: { module: "src/main.ts", exportName: "parseCliArgs" },
        category: "request",
      },
    ]);
    expect(remoteRunner?.boundaryDecoders).toEqual([]);
    expect(fs?.boundaryDecoders).toEqual([
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
    ]);
    expect(
      miniRuntime?.boundaryDecoders.some(
        (decoder) => decoder.identity.exportName === "SessionActor.summarizeForCompaction",
      ),
    ).toBeFalse();
  });

  test("registers exact stream validation and ChatTransport host rejection adapters", () => {
    const miniClient = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/mini-lilac-client",
    );
    expect(miniClient?.exceptionAdapters).toEqual([
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
    ]);
  });

  test("registers exact heartbeat and request-cache lifecycle Result boundaries", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    const modules = new Set([
      "src/heartbeat/heartbeat-service.ts",
      "src/tool-server/request-message-cache.ts",
    ]);

    expect(core?.operationalResultApis.filter((api) => modules.has(api.module))).toEqual([
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
    ]);
    expect(
      core?.exceptionAdapters
        .filter((adapter) => modules.has(adapter.identity.module))
        .map((adapter) => ({
          identity: adapter.identity,
          category: adapter.category,
          externalApi: adapter.externalApi,
          direction: adapter.direction,
        })),
    ).toEqual([
      {
        identity: {
          module: "src/heartbeat/heartbeat-service.ts",
          exportName: "adaptHeartbeatLifecycleStartResultToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "startHeartbeatService",
        },
        direction: "signal-host",
      },
      {
        identity: {
          module: "src/heartbeat/heartbeat-service.ts",
          exportName: "adaptHeartbeatLifecycleStopResultToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "HeartbeatService.stop",
        },
        direction: "signal-host",
      },
      {
        identity: {
          module: "src/tool-server/request-message-cache.ts",
          exportName: "adaptRequestMessageCacheStartResultToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "createRequestMessageCache",
        },
        direction: "signal-host",
      },
      {
        identity: {
          module: "src/tool-server/request-message-cache.ts",
          exportName: "adaptRequestMessageCacheStopResultToHost",
        },
        category: "result-to-framework",
        externalApi: {
          package: "@stanley2058/lilac-core",
          exportName: "RequestMessageCache.stop",
        },
        direction: "signal-host",
      },
    ]);
  });

  test("registers workflow action and projector Result boundaries", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    const operationalNames = core?.operationalResultApis.map(
      (api) => `${api.module}#${api.exportName}`,
    );
    expect(core?.boundaryDecoders).toContainEqual({
      identity: {
        module: "src/workflow/workflow-action-resolver.ts",
        exportName: "decodeWorkflowActionOutboxEvent",
      },
      category: "persistence",
    });
    expect(core?.boundaryDecoders).toContainEqual({
      identity: {
        module: "src/workflow/workflow-action-resolver.ts",
        exportName: "decodeWorkflowSurfaceAction",
      },
      category: "projection",
    });
    for (const identity of [
      "src/workflow/workflow-action-resolver.ts#captureWorkflowActionOutboxPublication",
      "src/workflow/workflow-action-resolver.ts#startWorkflowActionResolver.startWorkflowActionSubscriptionResult",
      "src/workflow/workflow-action-resolver.ts#startWorkflowActionResolver.stopWorkflowActionSubscriptionResult",
      "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.startWorkflowProgressSubscriptionResult",
      "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.stopWorkflowProgressSubscriptionResult",
    ]) {
      expect(operationalNames).toContain(identity);
    }
    for (const exportName of [
      "adaptWorkflowActionSubscriptionStartResultToHost",
      "adaptWorkflowActionSubscriptionStopResultToHost",
      "adaptWorkflowProgressSubscriptionStartResultToHost",
      "adaptWorkflowProgressSubscriptionStopResultToHost",
    ]) {
      expect(core?.exceptionAdapters).toContainEqual(
        expect.objectContaining({
          identity: expect.objectContaining({ exportName }),
          category: "result-to-framework",
          direction: "signal-host",
        }),
      );
    }
    expect(
      core?.exceptionAdapters
        .filter(
          (adapter) =>
            adapter.identity.module === "src/workflow/workflow-action-resolver.ts" &&
            adapter.identity.exportName === "captureWorkflowActionOutboxPublication",
        )
        .map((adapter) => ({
          category: adapter.category,
          direction: adapter.direction,
          externalApi: adapter.externalApi,
        })),
    ).toEqual([
      {
        category: "defect-supervisor",
        direction: "observe-panic",
        externalApi: { package: "better-result", exportName: "Panic.is" },
      },
      {
        category: "external-to-result",
        direction: "capture-external",
        externalApi: {
          package: "@stanley2058/lilac-event-bus",
          exportName: "LilacBus.publish",
        },
      },
    ]);
  });

  test("registers workflow wait resolver Result and exception boundaries", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    const operationalNames = core?.operationalResultApis.map(
      (api) => `${api.module}#${api.exportName}`,
    );
    for (const exportName of [
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
    ]) {
      expect(operationalNames).toContain(
        `src/workflow/workflow-wait-resolver.ts#WorkflowWaitResolver.${exportName}`,
      );
    }
    for (const exportName of [
      "adaptWorkflowWaitResolverStartResultToHost",
      "adaptWorkflowWaitResolverStopResultToHost",
    ]) {
      expect(core?.exceptionAdapters).toContainEqual(
        expect.objectContaining({
          identity: {
            module: "src/workflow/workflow-wait-resolver.ts",
            exportName,
          },
          category: "result-to-framework",
          direction: "signal-host",
        }),
      );
    }
    for (const exportName of [
      "WorkflowWaitResolver.captureWorkflowWaitResolverTrim",
      "WorkflowWaitResolver.captureWorkflowWaitResolverConsumerGroupRetirement",
      "WorkflowWaitResolver.captureWorkflowWaitResolverBarrierPublication",
      "WorkflowWaitResolver.captureWorkflowWaitResolverWakeupPublication",
    ]) {
      expect(
        core?.exceptionAdapters
          .filter(
            (adapter) =>
              adapter.identity.module === "src/workflow/workflow-wait-resolver.ts" &&
              adapter.identity.exportName === exportName,
          )
          .map((adapter) => adapter.category),
      ).toEqual(["defect-supervisor", "external-to-result"]);
    }
  });

  test("registers exact Stage 3 decoders, opaque inputs, capabilities, and adapters", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    const coding = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/coding-tools",
    );
    const plugins = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/plugin-runtime",
    );
    const utils = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/utils",
    );
    const remoteRunner = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/remote-fs-runner",
    );

    expect(core?.status).toBe("migrating");
    expect(coding?.status).toBe("migrating");
    expect(plugins?.status).toBe("migrating");
    expect(utils?.status).toBe("migrating");
    expect(core?.boundaryDecoders.map((decoder) => decoder.identity.exportName)).toContain(
      "decodeThreadSummarizationWorkerRequest",
    );
    expect(core?.boundaryDecoders.map((decoder) => decoder.identity.exportName)).toContain(
      "decodeThreadSummarizationWorkerResponse",
    );
    expect(coding?.boundaryDecoders).toContainEqual({
      identity: { module: "src/filesystem.ts", exportName: "createFilesystemTools.toModelOutput" },
      category: "projection",
    });
    expect(utils?.boundaryDecoders).toContainEqual({
      identity: { module: "custom-commands.ts", exportName: "decodeCustomCommandResult" },
      category: "plugin",
    });
    expect(utils?.boundaryDecoders).toContainEqual({
      identity: { module: "custom-commands.ts", exportName: "readCustomCommandDefinition" },
      category: "plugin",
    });
    expect(plugins?.capabilityPredicates).toEqual([
      {
        identity: { module: "capabilities.ts", exportName: "isFunctionCapability" },
        reason:
          "Checks one exact runtime capability without interpreting plugin-owned domain data.",
      },
      {
        identity: { module: "capabilities.ts", exportName: "isPluginPanic" },
        reason:
          "Checks one exact runtime capability without interpreting plugin-owned domain data.",
      },
    ]);
    expect(utils?.capabilityPredicates).toContainEqual({
      identity: { module: "runtime-utils.ts", exportName: "isPanic" },
      reason:
        "Checks exact Panic identity while treating hostile classifier inspection as ordinary opaque failure.",
    });
    expect(utils?.exceptionAdapters).toContainEqual({
      identity: { module: "runtime-utils.ts", exportName: "isPanic" },
      category: "defect-supervisor",
      externalApi: { package: "better-result", exportName: "Panic.is" },
      direction: "observe-panic",
      reason:
        "Recognizes genuine Panic while containing hostile proxy classification traps as ordinary opaque failure.",
    });
    expect(
      plugins?.boundaryDecoders.some(
        (decoder) => decoder.identity.exportName === "decodeDynamicToolPluginModule",
      ),
    ).toBeTrue();
    expect(
      plugins?.opaqueUnknown.some(
        (entry) => entry.identity.exportName === "Level1ToolSpec.formatArgs",
      ),
    ).toBeTrue();
    expect(
      plugins?.opaqueUnknown.some((entry) => entry.identity.exportName === "<module>"),
    ).toBeFalse();
    expect(
      plugins?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName === "loadToolPluginModuleCapability" &&
          adapter.direction === "capture-external",
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) => adapter.identity.exportName === "CustomCommandManager.execute",
      ),
    ).toBeFalse();
    expect(
      core?.exceptionAdapters.filter((adapter) =>
        [
          "rethrowConversationThreadWorkerPanic",
          "rethrowBusAgentRunnerPanic",
          "rethrowBundledRemoteRunnerPanic",
        ].includes(adapter.identity.exportName),
      ),
    ).toHaveLength(3);
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName ===
            "startConversationThreadSummarizationWorker.handleWorkerPanic" &&
          adapter.category === "defect-supervisor" &&
          adapter.direction === "observe-panic",
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.module === "src/tool-server/tools/conversation-thread.ts" &&
          adapter.identity.exportName === "ConversationThread.call" &&
          adapter.category === "result-to-framework" &&
          adapter.externalApi.exportName === "ServerTool.call" &&
          adapter.direction === "signal-host",
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.module === "src/runtime/create-core-runtime.ts" &&
          adapter.identity.exportName === "adaptCustomCommandInitializationResultToStartup" &&
          adapter.category === "result-to-framework" &&
          adapter.direction === "signal-host" &&
          adapter.reason.includes("host startup"),
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName === "signalConversationThreadWorkerPanicToProcess" &&
          adapter.category === "result-to-framework" &&
          adapter.direction === "signal-host",
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) => adapter.identity.exportName === "startBusAgentRunner.drainSessionQueue",
      ),
    ).toBeFalse();
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName ===
            "startBusAgentRunner.startSessionQueueDrain.superviseDetachedDrain" &&
          adapter.category === "defect-supervisor" &&
          adapter.direction === "observe-panic",
      ),
    ).toBeTrue();
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName === "createProcessHandlers.reportFatalError" &&
          adapter.category === "result-to-framework" &&
          adapter.direction === "signal-host",
      ),
    ).toBeTrue();
    expect(
      remoteRunner?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName === "preservePanic" &&
          adapter.category === "defect-supervisor",
      ),
    ).toBeTrue();
    const remoteRunnerCaptureAdapters = remoteRunner?.exceptionAdapters
      .filter((adapter) => adapter.direction === "capture-external")
      .map((adapter) => adapter.identity.exportName);
    expect(remoteRunnerCaptureAdapters).toContain("spawnDaemon");
    expect(remoteRunnerCaptureAdapters).toContain("releaseStartupLock");
    expect(remoteRunnerCaptureAdapters).not.toContain("tryAcquireStartupLock");
    expect(
      core?.exceptionAdapters.find(
        (adapter) => adapter.identity.exportName === "decodeRemoteFsRunnerPackageSpec",
      ),
    ).toMatchObject({ category: "external-to-result", direction: "capture-external" });
    expect(
      core?.exceptionAdapters.some(
        (adapter) =>
          adapter.identity.exportName === "decodeRemoteFsRunnerPackageSpec" &&
          adapter.category === "result-to-framework",
      ),
    ).toBeFalse();
  });

  test("activates exact Stage 3 Result and boundary zones and APIs", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    const plugins = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/plugin-runtime",
    );
    const remoteRunner = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "packages/remote-fs-runner",
    );
    if (!core || !plugins || !remoteRunner) throw new Error("Stage 3 workspace missing");

    for (const rule of [
      "architecture/no-unhandled-exception-contract",
      "architecture/no-unredacted-tagged-error-log",
      "architecture/fallible-api-result",
    ] as const) {
      expect(core.ruleZones[rule]).toContainEqual({
        include: "src/conversation/thread-worker.ts",
      });
      expect(plugins.ruleZones[rule]).toContainEqual({ include: "manager.ts" });
      expect(remoteRunner.ruleZones[rule]).toEqual([{ include: "src/cli.ts" }]);
    }
    expect(core.ruleZones["architecture/no-domain-unknown"]).toContainEqual({
      include: "src/custom-commands/manager.ts",
    });
    expect(core.operationalResultApis).toContainEqual({
      module: "src/custom-commands/manager.ts",
      exportName: "CustomCommandManager.execute",
    });
    for (const decoder of [
      { exportName: "decodeToolRequestHeaders", category: "request" },
      { exportName: "decodeToolPayload", category: "plugin" },
      { exportName: "projectUnhandledRejectionReason", category: "projection" },
      {
        exportName: "createToolServer.recordUnhandledRejectionAtBoundary",
        category: "projection",
      },
      { exportName: "projectFatalToolCallDefect", category: "projection" },
    ] as const) {
      expect(core.boundaryDecoders).toContainEqual({
        identity: {
          module: "src/tool-server/create-tool-server.ts",
          exportName: decoder.exportName,
        },
        category: decoder.category,
      });
    }
    for (const exportName of [
      "validateToolServerOptions",
      "createToolServer.authenticateContext",
      "createToolServer.resolveSafetyMode",
      "createToolServer.lookupTool",
    ]) {
      expect(core.operationalResultApis).toContainEqual({
        module: "src/tool-server/create-tool-server.ts",
        exportName,
      });
    }
    for (const exportName of [
      "adaptToolServerOptionsResultToHost",
      "adaptToolAuthenticationResultToElysia",
      "adaptSafetyModeResultToElysia",
      "adaptToolRouteResultToElysia",
      "adaptPluginLifecycleResultToHost",
      "adaptPluginListResultToElysia",
    ]) {
      expect(core.exceptionAdapters).toContainEqual(
        expect.objectContaining({
          identity: { module: "src/tool-server/create-tool-server.ts", exportName },
          category: "result-to-framework",
          direction: "signal-host",
        }),
      );
    }
    for (const registration of [
      {
        exportName: "observeToolCallRejection",
        category: "defect-supervisor",
        direction: "observe-panic",
      },
      {
        exportName: "superviseToolCallRejections",
        category: "defect-supervisor",
        direction: "observe-panic",
      },
      {
        exportName: "signalFatalToolCallDefectToProcess",
        category: "result-to-framework",
        direction: "signal-host",
      },
    ] as const) {
      expect(core.exceptionAdapters).toContainEqual(
        expect.objectContaining({
          identity: {
            module: "src/tool-server/create-tool-server.ts",
            exportName: registration.exportName,
          },
          category: registration.category,
          direction: registration.direction,
        }),
      );
    }
    expect(plugins.operationalResultApis).toContainEqual({
      module: "manager.ts",
      exportName: "ToolPluginManager.reload",
    });
    expect(remoteRunner.operationalResultApis).toContainEqual({
      module: "src/cli.ts",
      exportName: "tryAcquireStartupLock",
    });
    expect(remoteRunner.operationalResultApis).toContainEqual({
      module: "src/cli.ts",
      exportName: "runRequest",
    });
  });

  test("keeps every manifest-owned Stage 3 zero-baseline scope debt-free", () => {
    const semanticBaselines: readonly ArchitectureBaseline[] = [
      boundaryValidationBaseline,
      failureFlowBaseline,
    ];
    const typedSyntaxBaseline: SyntaxBaseline = syntaxBaseline;
    const stage3Debt: Array<{
      readonly workspace: string;
      readonly module: string;
      readonly semanticDebt: readonly BaselineEntry[];
      readonly syntaxDebt: readonly SyntaxBaselineEntry[];
    }> = [];
    for (const workspacePolicy of architectureManifest.workspaces) {
      const workspace = workspacePolicy.name;
      const semanticEntries = semanticBaselines.flatMap((baseline) =>
        Object.values(baseline[workspace] ?? {}).flatMap((entries) => entries ?? []),
      );
      const syntaxEntries = Object.values(typedSyntaxBaseline[workspace] ?? {}).flatMap(
        (entries) => entries ?? [],
      );
      for (const scope of workspacePolicy.zeroBaselineScopes) {
        const typedScope: ZeroBaselineScope = scope;
        const module = scope.module;
        const syntaxModule = module.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
        const moduleDebt = {
          workspace,
          module,
          semanticDebt: semanticEntries.filter(
            (entry) =>
              entry.location.file === module &&
              zeroBaselineScopeOwns(
                typedScope,
                entry.location.file,
                entry.identity.slice(entry.identity.indexOf("#") + 1).split("[")[0] ?? "",
              ),
          ),
          syntaxDebt: syntaxEntries.filter(
            (entry) =>
              entry.module === syntaxModule &&
              zeroBaselineScopeOwns(typedScope, entry.module, entry.symbol),
          ),
        };
        if (moduleDebt.semanticDebt.length || moduleDebt.syntaxDebt.length) {
          stage3Debt.push(moduleDebt);
        }
      }
    }
    expect(stage3Debt).toEqual([]);
  });

  test("requires exact reasoned and exception-adapter registrations", () => {
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            opaqueUnknown: [
              { identity: { module: "domain.ts", exportName: "<module>" }, reason: "broad" },
            ],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            exceptionAdapters: [
              {
                identity: { module: "adapter.ts", exportName: "capture.catch" },
                category: "external-to-result",
                externalApi: { package: "fixture", exportName: "operation" },
                direction: "capture-external",
                reason: "",
              },
            ],
          },
        ],
      }),
    ).toThrow("reason must be nonempty");
  });

  test("excludes the generated Core remote runner bundle but not its source", () => {
    const root = path.join(REPOSITORY_ROOT, "apps/core");
    expect(
      isProductionFileName(path.join(root, "src/ssh/remote-js/remote-runner.cjs"), root),
    ).toBeFalse();
    expect(
      isProductionFileName(path.join(root, "src/ssh/remote-js/remote-runner-entry.ts"), root),
    ).toBeTrue();
    expect(isProductionFileName(path.join(root, "test/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "tests/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "__tests__/support.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "src/generated/output.ts"), root)).toBeFalse();
    expect(isProductionFileName(path.join(root, "src/fixtures/production.ts"), root)).toBeFalse();
  });
});

describe("Stage 4 event architecture rules", () => {
  test("registers enforced production foundations and a migrated exhaustive family partition", () => {
    const eventBus = architectureManifest.workspaces.find(
      (workspace) => workspace.name === "packages/event-bus",
    );
    if (!eventBus) throw new Error("event-bus workspace missing");

    expect(eventBus.eventCodecRegistries).toHaveLength(1);
    expect(eventBus.eventCodecRegistries[0]).toMatchObject({
      status: "enforced",
      identity: { module: "lilac-codecs.ts", exportName: "lilacEventCodecRegistry" },
      canonicalEvents: { module: "lilac-spec.ts", exportName: "lilacEventTypes" },
    });
    expect(eventBus.rawEventMessageBoundaries).toContainEqual(
      expect.objectContaining({
        status: "enforced",
        identity: { module: "raw-bus.ts", exportName: "RawBus.subscribe" },
        handlerParameter: 2,
        messageParameter: 0,
      }),
    );
    expect(eventBus.eventDeliveryApis).toContainEqual(
      expect.objectContaining({
        status: "enforced",
        identity: { module: "lilac-bus.ts", exportName: "LilacBus.subscribeTopic" },
        handlerParameter: 2,
        handlerMessageParameter: 0,
        handlerContextParameter: 1,
      }),
    );
    expect(eventBus.eventFamilyMigrations.map((family) => family.family)).toEqual([
      "command-request",
      "workflow-control",
      "lifecycle",
      "adapter",
      "surface",
      "agent-output",
    ]);
    expect(eventBus.eventFamilyMigrations.every((family) => family.status === "migrated")).toBe(
      true,
    );
    expect(eventBus.eventCodecRegistries[0]?.canonicalMembers).toHaveLength(25);
    expect(eventBus.boundaryDecoders).toContainEqual({
      identity: {
        module: "core-primary-lineage.ts",
        exportName: "decodeCorePrimaryLineageV1",
      },
      category: "projection",
    });
    expect(eventBus.exceptionAdapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: {
            module: "event-dead-letter.ts",
            exportName: "checkedDeadLetterAcceptance",
          },
          category: "defect-supervisor",
          direction: "observe-panic",
        }),
        expect.objectContaining({
          identity: {
            module: "core-primary-lineage.ts",
            exportName: "decodeCorePrimaryLineageV1",
          },
          category: "defect-supervisor",
          direction: "observe-panic",
        }),
        expect.objectContaining({
          identity: {
            module: "redis-event-dead-letter.ts",
            exportName: "RedisEventDeadLetter.constructor",
          },
          category: "compatibility",
          direction: "signal-host",
        }),
      ]),
    );
    expect(
      eventBus.eventFamilyMigrations.every((family) => family.zeroBaselineScopes.length > 0),
    ).toBe(true);
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.name === "apps/core",
    );
    if (!core) throw new Error("core workspace missing");
    expect(core.eventDeliveryConsumers).toHaveLength(13);
    expect(core.boundaryDecoders).toContainEqual({
      identity: {
        module: "src/surface/bridge/bus-agent-runner/raw.ts",
        exportName: "parseRequestControlFromRaw",
      },
      category: "projection",
    });
    expect(
      core.eventDeliveryConsumers.every((consumer) =>
        core.zeroBaselineScopes.some(
          (scope) =>
            scope.module === consumer.identity.module &&
            (scope as ZeroBaselineScope).symbol === consumer.identity.exportName,
        ),
      ),
    ).toBe(true);
    expect(core.eventDeliveryConsumers).toContainEqual(
      expect.objectContaining({
        identity: {
          module: "src/workflow/workflow-engine.ts",
          exportName: "WorkflowEngine.startWakeSubscription",
        },
        operations: ["subscribeTopic"],
      }),
    );
    expect(core.operationalResultApis).toEqual(
      expect.arrayContaining([
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
        { module: "src/workflow/workflow-engine.ts", exportName: "fetchWorkflowTerminalReceipt" },
      ]),
    );
    expect(core.exceptionAdapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: {
            module: "src/workflow/workflow-engine.ts",
            exportName: "requireWorkflowEngineSubscriptionStart",
          },
          category: "result-to-framework",
          direction: "signal-host",
        }),
        expect.objectContaining({
          identity: {
            module: "src/workflow/workflow-engine.ts",
            exportName: "runWorkflowTimerTick",
          },
          category: "defect-supervisor",
          direction: "observe-panic",
        }),
      ]),
    );
    for (const exportName of [
      "captureWorkflowTerminalReceiptAdoption",
      "captureWorkflowIdleCancellationPublication",
    ]) {
      expect(
        core.exceptionAdapters
          .filter(
            (adapter) =>
              adapter.identity.module === "src/workflow/workflow-engine.ts" &&
              adapter.identity.exportName === exportName,
          )
          .map((adapter) => adapter.category),
      ).toEqual(["defect-supervisor", "external-to-result"]);
    }
    expect(() => assertArchitectureManifestIntegrity(architectureManifest)).not.toThrow();
  });

  test("checks family exhaustiveness, overlap, codec coverage, zero scopes, and parameter indexes", () => {
    const registry = fixtureCodecRegistry("completeFixtureEventCodecs");
    const validWorkspace = {
      ...BASE_WORKSPACE,
      zeroBaselineScopes: [{ module: "stage4-events.ts", symbol: "FixtureDeliveryApi.good" }],
      eventCodecRegistries: [registry],
      eventDeliveryApis: [
        fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
      eventFamilyMigrations: [
        {
          family: "alpha",
          status: "migrated" as const,
          codecRegistry: registry.identity,
          members: ["fixture.alpha"],
          zeroBaselineScopes: [
            {
              workspace: "fixture",
              module: "stage4-events.ts",
              symbol: "FixtureDeliveryApi.good",
            },
          ],
        },
        {
          family: "remaining",
          status: "advisory" as const,
          codecRegistry: registry.identity,
          members: ["fixture.beta", "fixture.gamma"],
          zeroBaselineScopes: [],
        },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [validWorkspace] }),
    ).not.toThrow();

    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...validWorkspace,
            eventFamilyMigrations: [
              ...validWorkspace.eventFamilyMigrations,
              {
                family: "overlap",
                status: "advisory",
                codecRegistry: registry.identity,
                members: ["fixture.alpha"],
                zeroBaselineScopes: [],
              },
            ],
          },
        ],
      }),
    ).toThrow("must not overlap");

    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...validWorkspace,
            eventFamilyMigrations: validWorkspace.eventFamilyMigrations.slice(0, 1),
          },
        ],
      }),
    ).toThrow("not exhaustive");

    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...validWorkspace,
            eventCodecRegistries: [{ ...registry, status: "advisory", codecMembers: [] }],
          },
        ],
      }),
    ).toThrow("lacks codec coverage");

    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...validWorkspace,
            rawEventMessageBoundaries: [
              { ...fixtureRawBoundary("RawFixtureBus.receiveGood"), handlerParameter: -1 },
            ],
          },
        ],
      }),
    ).toThrow("handlerParameter must be a nonnegative integer");
  });

  test("requires the exact canonical codec registry to be complete", () => {
    const complete = findingsFor("architecture/complete-event-codec-registry", "stage4-events.ts", {
      eventCodecRegistries: [fixtureCodecRegistry("completeFixtureEventCodecs")],
    });
    const incomplete = findingsFor(
      "architecture/complete-event-codec-registry",
      "stage4-events.ts",
      { eventCodecRegistries: [fixtureCodecRegistry("incompleteFixtureEventCodecs")] },
    );

    expect(complete).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.message).toContain("fixture.gamma");
  });

  test("requires raw receive handlers to expose Message<unknown> without specialization assertions", () => {
    const good = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveGood")],
    });
    const typed = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveTyped")],
    });
    const asserted = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveWithAssertion")],
    });
    const generic = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveGeneric")],
    });
    const commit = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.receiveWithCommit")],
    });

    expect(good).toEqual([]);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.message).toContain("Message<unknown>");
    expect(asserted).toHaveLength(1);
    expect(asserted[0]?.message).toContain("assertion");
    expect(generic.some((finding) => finding.message.includes("generic"))).toBe(true);
    expect(commit.some((finding) => finding.message.includes("context exposes commit"))).toBe(true);
  });

  test("rejects future legacy raw delivery aliases", () => {
    const findings = findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
      rawEventMessageBoundaries: [fixtureRawBoundary("LegacyRawFixtureBus.receiveGood")],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("subscribeDelivery");
  });

  test("requires Result-returning handlers and removes handler-owned commit", () => {
    const good = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [
        fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
    });
    const bad = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [fixtureDeliveryApi("FixtureDeliveryApi.bad", "exhaustiveDeliveryPolicy")],
    });

    expect(good).toEqual([]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain("handler context exposes commit");
    expect(bad[0]?.message).toContain("Promise<Result<void, E>>");
  });

  test("rejects future legacy delivery API aliases", () => {
    const findings = findingsFor("architecture/event-handler-result", "stage4-events.ts", {
      eventDeliveryApis: [
        fixtureDeliveryApi("LegacyFixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("subscribeTopicResult");
  });

  test("fails closed for unregistered production Result consumers", () => {
    const registered = {
      identity: { module: "stage4-events.ts", exportName: "registeredFixtureConsumer" },
      apiPackage: "architecture-fixture",
      operations: ["subscribeTopic"] as const,
    };
    const unregistered = {
      identity: { module: "stage4-events.ts", exportName: "unregisteredFixtureConsumer" },
      apiPackage: "architecture-fixture",
      operations: ["fetchTopic"] as const,
    };
    expect(() =>
      findingsFor("architecture/event-handler-result", "stage4-events.ts", {
        eventDeliveryConsumers: [registered, unregistered],
      }),
    ).not.toThrow();
    expect(() =>
      findingsFor("architecture/event-handler-result", "stage4-events.ts", {
        eventDeliveryConsumers: [registered],
      }),
    ).toThrow("Unregistered event delivery consumer");
  });

  test("scans workspaces with no local registrations for consumers of manifest APIs", () => {
    const apiWorkspace = {
      ...BASE_WORKSPACE,
      name: "fixture-event-api",
      packageName: "fixture-event-api",
      root: "scripts/architecture/fixtures/stage4-event-api",
      tsconfig: "scripts/architecture/fixtures/stage4-event-api/tsconfig.json",
      ruleZones: {
        "architecture/event-handler-result": [{ include: "api.ts" }],
        "architecture/event-delivery-policy-exhaustiveness": [{ include: "api.ts" }],
      },
      eventDeliveryApis: [
        {
          status: "advisory",
          identity: { module: "api.ts", exportName: "FixtureEventBus.subscribeTopic" },
          handlerParameter: 0,
          handlerMessageParameter: 0,
          handlerContextParameter: 1,
          deliveryPolicy: { module: "api.ts", exportName: "fixtureDeliveryPolicy" },
          deliveryErrorParameter: 0,
        },
      ],
    } as const satisfies WorkspaceArchitecture;
    const consumerWorkspace = {
      ...BASE_WORKSPACE,
      name: "fixture-event-consumer",
      packageName: "fixture-event-consumer",
      root: "scripts/architecture/fixtures/stage4-event-consumer",
      tsconfig: "scripts/architecture/fixtures/stage4-event-consumer/tsconfig.json",
    } as const satisfies WorkspaceArchitecture;

    expect(() =>
      analyzeArchitecture(REPOSITORY_ROOT, {
        version: 1,
        workspaces: [apiWorkspace, consumerWorkspace],
      }),
    ).toThrow(
      "Unregistered event delivery consumer in fixture-event-consumer: consumer.ts#unregisteredCrossWorkspaceConsumer calls fixture-event-api#subscribeTopic.",
    );
  });

  test("requires an exhaustive registered delivery policy", () => {
    const good = findingsFor(
      "architecture/event-delivery-policy-exhaustiveness",
      "stage4-events.ts",
      {
        eventDeliveryApis: [
          fixtureDeliveryApi("FixtureDeliveryApi.good", "exhaustiveDeliveryPolicy"),
        ],
      },
    );
    const bad = findingsFor(
      "architecture/event-delivery-policy-exhaustiveness",
      "stage4-events.ts",
      {
        eventDeliveryApis: [
          fixtureDeliveryApi("FixtureDeliveryApi.good", "incompleteDeliveryPolicy"),
        ],
      },
    );

    expect(good).toEqual([]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain("DeadLetterFailed");
  });

  test("fails closed when an enforced event registration drifts", () => {
    expect(() =>
      findingsFor("architecture/raw-event-message-boundary", "stage4-events.ts", {
        rawEventMessageBoundaries: [fixtureRawBoundary("RawFixtureBus.missing")],
      }),
    ).toThrow("must resolve to exactly one declaration; found 0");
  });
});

describe("Stage 5 presentation architecture rules", () => {
  test("enforces the integrated Stage 5 projection and render modules", () => {
    const tui = architectureManifest.workspaces.find(
      (workspace) => workspace.name === "apps/mini-lilac-tui",
    );
    if (!tui) throw new Error("mini-lilac-tui workspace missing");

    expect(tui.toolCodecRegistries).toEqual([
      {
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
      },
    ]);
    expect(tui.resultDecoders).toEqual([
      expect.objectContaining({
        status: "enforced",
        identity: {
          module: "src/tool-observation-projection.ts",
          exportName: "decodeKnownToolObservation",
        },
      }),
    ]);
    expect(tui.unknownFreeModules).toEqual([
      { status: "enforced", module: "src/render.ts" },
      { status: "enforced", module: "src/transcript-buffer.ts" },
    ]);
    expect(tui.zeroBaselineScopes).toEqual(
      expect.arrayContaining([
        { module: "src/render.ts" },
        { module: "src/ui-message-chunk-projection.ts" },
        { module: "src/tool-observation-projection.ts" },
        { module: "src/transcript-buffer.ts" },
      ]),
    );
    expect(tui.operationalResultApis).toContainEqual({
      module: "src/tool-observation-projection.ts",
      exportName: "decodeKnownToolObservation",
    });
    expect(() => assertArchitectureManifestIntegrity(architectureManifest)).not.toThrow();
  });

  test("owns every landed projection parser and passes enforced Stage 5 contracts", () => {
    const tui = architectureManifest.workspaces.find(
      (workspace) => workspace.name === "apps/mini-lilac-tui",
    );
    if (!tui) throw new Error("mini-lilac-tui workspace missing");
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, tui);
    const findings = analyzeWorkspace(
      tui,
      workspaceProgram.root,
      workspaceProgram.program,
      architectureManifest.workspaces.map((workspace) => ({
        packageName: workspace.packageName,
        root: path.join(REPOSITORY_ROOT, workspace.root),
      })),
    );
    const stage5Modules = new Set([
      "src/render.ts",
      "src/ui-message-chunk-projection.ts",
      "src/tool-observation-projection.ts",
      "src/transcript-buffer.ts",
    ]);
    const stage5Findings = findings.filter(
      (finding) => finding.location !== undefined && stage5Modules.has(finding.location.file),
    );

    expect(stage5Findings).toEqual([]);
  }, 30_000);

  test("requires an explicit exhaustive tool codec registry without spread, broad, missing, or extra keys", () => {
    const complete = findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
      toolCodecRegistries: [fixtureToolCodecRegistry("completeToolCodecs")],
    });
    expect(complete).toEqual([]);
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            aliases: [{ module: "stage5-tools.ts", exportName: "completeToolCodecsAlias" }],
          },
        ],
      }),
    ).toEqual([]);
    const invalidAlias = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            aliases: [{ module: "stage5-tools.ts", exportName: "invalidToolCodecsAlias" }],
          },
        ],
      },
    );
    expect(invalidAlias).toHaveLength(1);
    expect(invalidAlias[0]?.message).toContain("aliases do not reference");

    for (const exportName of [
      "spreadToolCodecs",
      "broadToolCodecs",
      "broadTypedToolCodecs",
      "incompleteToolCodecs",
      "extraToolCodecs",
    ]) {
      const findings = findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry(exportName)],
      });
      expect(findings).toHaveLength(1);
    }
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("incompleteToolCodecs")],
      })[0]?.message,
    ).toContain("codecs missing");
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("extraToolCodecs")],
      })[0]?.message,
    ).toContain("future_tool");
    expect(
      findingsFor("architecture/complete-tool-codec-registry", "stage5-tools.ts", {
        toolCodecRegistries: [fixtureToolCodecRegistry("broadTypedToolCodecs")],
      })[0]?.message,
    ).toContain("broad index signature");
    const duplicateCatalog = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            canonicalTools: {
              module: "stage5-tools.ts",
              exportName: "duplicateCanonicalTuiToolNames",
            },
          },
        ],
      },
    );
    expect(duplicateCatalog).toHaveLength(1);
    expect(duplicateCatalog[0]?.message).toContain("catalog contains duplicates");
    const broadCatalog = findingsFor(
      "architecture/complete-tool-codec-registry",
      "stage5-tools.ts",
      {
        toolCodecRegistries: [
          {
            ...fixtureToolCodecRegistry("completeToolCodecs"),
            canonicalTools: {
              module: "stage5-tools.ts",
              exportName: "broadCanonicalTuiToolNames",
            },
          },
        ],
      },
    );
    expect(broadCatalog).toHaveLength(1);
    expect(broadCatalog[0]?.message).toContain("not a literal tuple");
  });

  test("resolves a shared cross-workspace tool catalog and reports protocol drift", () => {
    const registration = {
      ...fixtureToolCodecRegistry("completeToolCodecs"),
      canonicalTools: {
        package: "fixture-shared-protocol",
        module: "tool-catalog.ts",
        exportName: "SHARED_TOOL_NAMES",
      },
    } satisfies ToolCodecRegistryRegistration;
    const workspace = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/complete-tool-codec-registry": [{ include: "stage5-tools.ts" }],
      },
      toolCodecRegistries: [registration],
    } satisfies WorkspaceArchitecture;
    const packageRoots = [
      { packageName: workspace.packageName, root: FIXTURE_ROOT },
      {
        packageName: "fixture-shared-protocol",
        root: path.join(FIXTURE_ROOT, "shared-protocol"),
      },
    ];

    expect(analyzeWorkspace(workspace, FIXTURE_ROOT, fixtureProgram, packageRoots)).toEqual([]);
    const drifted = {
      ...workspace,
      toolCodecRegistries: [
        {
          ...registration,
          canonicalTools: {
            ...registration.canonicalTools,
            exportName: "DRIFTED_SHARED_TOOL_NAMES",
          },
        },
      ],
    } satisfies WorkspaceArchitecture;
    const findings = analyzeWorkspace(drifted, FIXTURE_ROOT, fixtureProgram, packageRoots);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("future_tool");
  });

  test("rejects duplicate values, unresolved packages, and non-exact tool registry declarations in manifest integrity", () => {
    const registry = fixtureToolCodecRegistry("completeToolCodecs");
    const valid = {
      ...BASE_WORKSPACE,
      ruleZones: {
        "architecture/complete-tool-codec-registry": [{ include: "stage5-tools.ts" }],
      },
      toolCodecRegistries: [registry],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [valid] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...valid, toolCodecRegistries: [registry, registry] }],
      }),
    ).toThrow("Duplicate tool codec registry registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            toolCodecRegistries: [{ ...registry, aliases: [registry.identity] }],
          },
        ],
      }),
    ).toThrow("Duplicate tool codec registry value registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            toolCodecRegistries: [
              {
                ...registry,
                canonicalTools: {
                  package: "@fixture/missing-protocol",
                  module: "tool-catalog.ts",
                  exportName: "TOOL_NAMES",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("is not an active workspace package");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            toolCodecRegistries: [
              {
                ...registry,
                identity: { module: "stage5-*.ts", exportName: "completeToolCodecs" },
              },
            ],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
  });

  test("requires exact non-generic Result decoders with unknown boundary input and decoded outputs", () => {
    expect(
      findingsFor("architecture/result-decoder-contract", "stage5-tools.ts", {
        resultDecoders: [fixtureResultDecoder("decodeKnownToolObservation")],
      }),
    ).toEqual([]);
    for (const exportName of [
      "genericToolDecoder",
      "nonResultToolDecoder",
      "unknownSuccessToolDecoder",
      "unknownErrorToolDecoder",
      "nestedUnknownErrorToolDecoder",
      "nestedAnyErrorToolDecoder",
      "nestedNeverErrorToolDecoder",
      "typedInputToolDecoder",
    ]) {
      const findings = findingsFor("architecture/result-decoder-contract", "stage5-tools.ts", {
        resultDecoders: [fixtureResultDecoder(exportName)],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("invalid");
    }
  });

  test("requires Result decoder registrations to be exact and unique", () => {
    const decoder = fixtureResultDecoder("decodeKnownToolObservation");
    const valid = {
      ...BASE_WORKSPACE,
      ruleZones: { "architecture/result-decoder-contract": [{ include: "stage5-tools.ts" }] },
      resultDecoders: [decoder],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [valid] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...valid, resultDecoders: [decoder, decoder] }],
      }),
    ).toThrow("Duplicate Result decoder registration");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...valid,
            resultDecoders: [
              {
                ...decoder,
                identity: { module: "stage5-tools.ts", exportName: "decode*" },
              },
            ],
          },
        ],
      }),
    ).toThrow("must name an exact symbol");
  });

  test("only enforced Result decoder registrations own Zod parser calls", () => {
    const decoder = {
      ...fixtureResultDecoder("registeredDecode"),
      identity: { module: "boundary.ts", exportName: "registeredDecode" },
    };
    const enforced = findingsFor("architecture/no-unregistered-decoder", "boundary.ts", {
      resultDecoders: [decoder],
    });
    expect(enforced).toHaveLength(1);
    const advisory = findingsFor("architecture/no-unregistered-decoder", "boundary.ts", {
      resultDecoders: [{ ...decoder, status: "advisory" }],
    });
    expect(advisory).toHaveLength(2);
  });

  test("recursively rejects unknown in parameters, returns, aliases, properties, generics, maps, unions, and locals", () => {
    const findings = findingsFor("architecture/unknown-free-module", "stage5-render-bad.ts", {
      unknownFreeModules: [{ status: "enforced", module: "stage5-render-bad.ts" }],
    });
    const messages = findings.map((finding) => finding.message);
    const identities = findings.map((finding) => finding.identity);
    expect(
      messages.some((message) => message.includes("type alias DirectUnknownAlias")),
    ).toBeTrue();
    expect(
      messages.some((message) => message.includes("type alias NestedUnknownAlias")),
    ).toBeTrue();
    expect(messages.some((message) => message.includes("property payload"))).toBeTrue();
    expect(messages.some((message) => message.includes("parameter value"))).toBeTrue();
    expect(messages.some((message) => message.includes("return type"))).toBeTrue();
    expect(messages.some((message) => message.includes("local local"))).toBeTrue();
    expect(messages.some((message) => message.includes("parameter contract"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedMethodOnly"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedCallOnly"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedNestedMethod"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedOverBudget"))).toBeTrue();
    expect(identities.some((identity) => identity.includes("importedRecursive"))).toBeFalse();

    expect(
      findingsFor("architecture/unknown-free-module", "stage5-render-good.ts", {
        unknownFreeModules: [{ status: "enforced", module: "stage5-render-good.ts" }],
      }),
    ).toEqual([]);
  });

  test("forbids every decoder registration inside an unknown-free render module", () => {
    const unknownFreeModules = [{ status: "enforced" as const, module: "stage5-render-good.ts" }];
    const ruleZones = {
      "architecture/unknown-free-module": [{ include: "stage5-render-good.ts" }],
      "architecture/result-decoder-contract": [{ include: "stage5-render-good.ts" }],
    };
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones,
            unknownFreeModules,
            boundaryDecoders: [
              {
                identity: { module: "stage5-render-good.ts", exportName: "renderToolProjection" },
                category: "projection",
              },
            ],
          },
        ],
      }),
    ).toThrow("cannot own boundary decoder");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones,
            unknownFreeModules,
            resultDecoders: [
              {
                ...fixtureResultDecoder("renderToolProjection"),
                identity: {
                  module: "stage5-render-good.ts",
                  exportName: "renderToolProjection",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("cannot own Result decoder");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...BASE_WORKSPACE,
            ruleZones: {
              ...ruleZones,
              "architecture/complete-tool-codec-registry": [{ include: "stage5-render-good.ts" }],
            },
            unknownFreeModules,
            toolCodecRegistries: [
              {
                ...fixtureToolCodecRegistry("renderToolProjection"),
                identity: {
                  module: "stage5-render-good.ts",
                  exportName: "renderToolProjection",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("cannot own tool codec registry");
  });

  test("keeps ToolProjection switches closed and exhaustive", () => {
    expect(
      findingsFor("architecture/closed-union-exhaustiveness", "stage5-render-good.ts"),
    ).toEqual([]);
    const findings = findingsFor(
      "architecture/closed-union-exhaustiveness",
      "stage5-render-bad.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"malformed-known-tool"');
  });
});

describe("Stage 6 persistence and SQLite architecture", () => {
  const realRoot = path.join(import.meta.dir, "fixtures/real-libraries");
  const realWorkspaceBase = {
    ...BASE_WORKSPACE,
    name: "real-stage6",
    packageName: "architecture-real-libraries",
    root: "scripts/architecture/fixtures/real-libraries",
    tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
  } as const satisfies WorkspaceArchitecture;

  function persistedCodec(
    exportName: string,
    fixtureExportName: string,
    provenance: PersistedCodecRegistration["provenance"] = [
      "current",
      "migrated",
      "missing-defaulted",
    ],
  ): PersistedCodecRegistration {
    return {
      status: "enforced",
      identity: { module: "stage6-persistence.ts", exportName },
      inputParameter: 0,
      fixtureCatalog: { module: "stage6-persistence.ts", exportName: fixtureExportName },
      provenance,
    };
  }

  const transactionAdapter: SqliteTransactionAdapterRegistration = {
    status: "enforced",
    identity: { module: "stage6-transactions.ts", exportName: "runFixtureSqliteTransaction" },
    databaseParameter: 0,
    operationParameter: 1,
    rollbackSentinel: { module: "stage6-transactions.ts", exportName: "FixtureRollback" },
    panicClassifier: { package: "better-result", exportName: "Panic.is" },
    driverErrorClassifier: {
      module: "stage6-transactions.ts",
      exportName: "classifyFixtureSqliteDriverError",
    },
  };

  test("validates real persisted codec contracts, provenance, fixtures, and consumer linkage", () => {
    const codecs = [
      persistedCodec("decodeFixtureStringArray", "fixtureStringArrayCases"),
      persistedCodec("decodeFixtureImportance", "fixtureImportanceCases"),
      persistedCodec("decodeFixtureAboutness", "fixtureAboutnessCases"),
      persistedCodec("decodeFixtureBytes", "fixtureBytesCases"),
      persistedCodec("decodeRequiredFixture", "requiredFixtureCases", ["current", "migrated"]),
    ];
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: codecs,
      persistedStoreConsumers: [
        {
          status: "enforced",
          identity: {
            module: "stage6-persistence.ts",
            exportName: "consumeFixturePersistence",
          },
          codecs: [codecs[0]!.identity],
        },
      ],
      operationalResultApis: [
        ...codecs.map(({ identity }) => identity),
        { module: "stage6-persistence.ts", exportName: "consumeFixturePersistence" },
      ],
      zeroBaselineScopes: [
        { module: "stage6-persistence.ts", symbol: "consumeFixturePersistence" },
      ],
    } satisfies WorkspaceArchitecture;
    assertArchitectureManifestIntegrity({ version: 1, workspaces: [workspace] });
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    expect(analyzeWorkspace(workspace, realRoot, program)).toEqual([]);
  });

  test("rejects drifted provenance and incomplete or mislabeled fixture catalogs", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: [
        persistedCodec("decodeFixtureWithWrongProvenance", "incompleteFixtureCases"),
      ],
      operationalResultApis: [
        { module: "stage6-persistence.ts", exportName: "decodeFixtureWithWrongProvenance" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings.map(({ rule }) => rule).sort()).toEqual([
      "architecture/persisted-codec-contract",
      "architecture/persisted-codec-fixture-catalog",
    ]);
    expect(
      findings.some(({ message }) => message.includes("provenance must be exactly")),
    ).toBeTrue();
    expect(findings.some(({ message }) => message.includes("missing-defaulted"))).toBeTrue();
  });

  test("fails closed for unregistered persisted consumers and fixture catalogs", () => {
    const codec = persistedCodec("decodeFixtureStringArray", "fixtureStringArrayCases");
    const unregisteredConsumerWorkspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-contract": [{ include: "stage6-persistence.ts" }],
        "architecture/persisted-codec-fixture-catalog": [{ include: "stage6-persistence.ts" }],
      },
      persistedCodecs: [codec],
      operationalResultApis: [codec.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, unregisteredConsumerWorkspace).program;
    expect(() => analyzeWorkspace(unregisteredConsumerWorkspace, realRoot, program)).toThrow(
      "Unregistered persisted store consumer",
    );

    const unregisteredCatalogWorkspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/persisted-codec-fixture-catalog": [
          { include: "stage6-unregistered-catalog.ts" },
        ],
      },
    } satisfies WorkspaceArchitecture;
    expect(() => analyzeWorkspace(unregisteredCatalogWorkspace, realRoot, program)).toThrow(
      "Unregistered persisted codec fixture catalog",
    );
  });

  test("registers the single workflow row codec catalog without treating family fixtures as a second contract", () => {
    const core = architectureManifest.workspaces.find(({ root }) => root === "apps/core");
    if (!core) throw new Error("Core architecture workspace missing");
    const workflowModule = "src/workflow/workflow-persistence-codec.ts";
    const workflowCodecs = core.persistedCodecs.filter(
      ({ identity }) => identity.module === workflowModule,
    );
    expect(workflowCodecs).toEqual([
      expect.objectContaining({
        status: "enforced",
        identity: {
          module: workflowModule,
          exportName: "decodeWorkflowPersistenceRow",
        },
        fixtureCatalog: {
          module: workflowModule,
          exportName: "workflowPersistenceRowCodecCases",
        },
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
      }),
    ]);

    const sourceText = readFileSync(
      path.join(REPOSITORY_ROOT, "apps/core", workflowModule),
      "utf8",
    );
    const source = ts.createSourceFile(workflowModule, sourceText, ts.ScriptTarget.Latest, true);
    const exportedVariables = source.statements.flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) return [];
      const exported = statement.modifiers?.some(
        ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) return [];
      return statement.declarationList.declarations.flatMap(({ name }) =>
        ts.isIdentifier(name) ? [name.text] : [],
      );
    });
    expect(exportedVariables.filter((name) => name.endsWith("CodecCases"))).toEqual([
      "workflowPersistenceRowCodecCases",
    ]);
    expect(exportedVariables).toContain("workflowPersistenceRowFamilyFixtures");
  });

  test("validates the real bun:sqlite adapter and detects Err returned by a raw callback", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
        "architecture/no-result-err-in-sqlite-callback": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      operationalResultApis: [transactionAdapter.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(
      findings.filter(
        ({ rule, identity }) =>
          rule === "architecture/no-result-err-in-sqlite-callback" &&
          identity.includes("rawDriverCallbackReturningErr"),
      ),
    ).toHaveLength(1);
    expect(
      findings.filter(({ rule }) => rule === "architecture/sqlite-transaction-adapter-contract"),
    ).toEqual([]);
  });

  test("rejects non-private sentinels and inexact Panic or driver classifiers", () => {
    const inexactAdapter = {
      ...transactionAdapter,
      rollbackSentinel: {
        module: "stage6-transactions.ts",
        exportName: "ExportedFixtureRollback",
      },
      panicClassifier: { package: "better-result", exportName: "Panic" },
      driverErrorClassifier: {
        module: "stage6-transactions.ts",
        exportName: "fixtureRowCount",
      },
    } satisfies SqliteTransactionAdapterRegistration;
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [inexactAdapter],
      operationalResultApis: [inexactAdapter.identity],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("rollback sentinel is exported instead of private");
    expect(findings[0]?.message).toContain("exact Panic classifier");
    expect(findings[0]?.message).toContain("exact SQLite driver classifier");
  });

  test("manifest integrity requires exact Panic identity, operational linkage, and descendant zero debt", () => {
    const base = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-adapter-contract": [{ include: "stage6-transactions.ts" }],
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          status: "enforced",
          identity: {
            module: "stage6-transactions.ts",
            exportName: "goodFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "goodFixtureTransactionConsumer" },
      ],
      zeroBaselineScopes: [
        { module: "stage6-transactions.ts", symbol: "goodFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() =>
      assertArchitectureManifestIntegrity({ version: 1, workspaces: [base] }),
    ).not.toThrow();
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [
          {
            ...base,
            sqliteTransactionAdapters: [
              {
                ...transactionAdapter,
                panicClassifier: { package: "better-result", exportName: "Panic" },
              },
            ],
          },
        ],
      }),
    ).toThrow("exact better-result#Panic.is");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...base, operationalResultApis: [transactionAdapter.identity] }],
      }),
    ).toThrow("operational Result API");
    expect(() =>
      assertArchitectureManifestIntegrity({
        version: 1,
        workspaces: [{ ...base, zeroBaselineScopes: [] }],
      }),
    ).toThrow("descendant-aware zero-baseline scope");
  });

  test("requires transaction consumers to call the exact registered adapter", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          status: "enforced",
          identity: {
            module: "stage6-transactions.ts",
            exportName: "goodFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
        {
          status: "enforced",
          identity: {
            module: "stage6-transactions.ts",
            exportName: "badFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "goodFixtureTransactionConsumer" },
        { module: "stage6-transactions.ts", exportName: "badFixtureTransactionConsumer" },
      ],
      zeroBaselineScopes: [
        { module: "stage6-transactions.ts", symbol: "goodFixtureTransactionConsumer" },
        { module: "stage6-transactions.ts", symbol: "badFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    const findings = analyzeWorkspace(workspace, realRoot, program);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("architecture/sqlite-transaction-consumer");
    expect(findings[0]?.identity).toContain("badFixtureTransactionConsumer");
  });

  test("fails closed for an unregistered SQLite transaction consumer", () => {
    const workspace = {
      ...realWorkspaceBase,
      ruleZones: {
        "architecture/sqlite-transaction-consumer": [{ include: "stage6-transactions.ts" }],
      },
      sqliteTransactionAdapters: [transactionAdapter],
      sqliteTransactionConsumers: [
        {
          status: "enforced",
          identity: {
            module: "stage6-transactions.ts",
            exportName: "badFixtureTransactionConsumer",
          },
          adapter: transactionAdapter.identity,
        },
      ],
      operationalResultApis: [
        transactionAdapter.identity,
        { module: "stage6-transactions.ts", exportName: "badFixtureTransactionConsumer" },
      ],
      zeroBaselineScopes: [
        { module: "stage6-transactions.ts", symbol: "badFixtureTransactionConsumer" },
      ],
    } satisfies WorkspaceArchitecture;
    const program = createWorkspaceProgram(REPOSITORY_ROOT, workspace).program;
    expect(() => analyzeWorkspace(workspace, realRoot, program)).toThrow(
      "Unregistered SQLite transaction consumer",
    );
  });

  test("executes real better-result codecs and bun:sqlite commit, rollback, driver, and Panic fixtures", async () => {
    const process = Bun.spawn(
      ["bun", "scripts/architecture/fixtures/real-libraries/stage6-runtime.ts"],
      { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("activates only the landed production Stage 6 scopes", () => {
    const core = architectureManifest.workspaces.find(({ name }) => name === "apps/core");
    const mini = architectureManifest.workspaces.find(
      ({ name }) => name === "packages/mini-lilac-runtime",
    );
    const utils = architectureManifest.workspaces.find(({ name }) => name === "packages/utils");
    if (!core || !mini || !utils) throw new Error("Stage 6 production workspaces missing");
    expect(
      core.persistedCodecs.filter(
        ({ identity }) =>
          identity.module === "src/conversation/thread-summary-persistence-codec.ts",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "enforced",
        identity: {
          module: "src/conversation/thread-summary-persistence-codec.ts",
          exportName: "decodeConversationThreadSummaryRow",
        },
        fixtureCatalog: {
          module: "src/conversation/thread-summary-persistence-codec.ts",
          exportName: "conversationThreadSummaryRowCodecCases",
        },
      }),
    ]);
    expect(
      architectureManifest.workspaces.reduce(
        (count, workspace) => count + workspace.persistedCodecs.length,
        0,
      ),
    ).toBe(21);
    expect(core.persistedCodecs.every(({ status }) => status === "enforced")).toBeTrue();
    expect(mini.persistedCodecs.every(({ status }) => status === "enforced")).toBeTrue();
    expect(mini.persistedStoreConsumers.every(({ status }) => status === "enforced")).toBeTrue();
    expect(core.persistedStoreConsumers.every(({ status }) => status === "enforced")).toBeTrue();
    expect(
      core.sqliteTransactionConsumers.find(
        ({ identity }) => identity.exportName === "ConversationThreadStore.upsertSummary",
      )?.status,
    ).toBe("enforced");
    expect(
      core.sqliteTransactionConsumers
        .filter(({ identity }) => identity.module === "src/transcript/transcript-store.ts")
        .every(({ status }) => status === "enforced"),
    ).toBeTrue();
    expect(
      core.sqliteTransactionConsumers
        .filter(({ identity }) => identity.module !== "src/transcript/transcript-store.ts")
        .every(({ status }) => status === "enforced"),
    ).toBeTrue();
    expect(utils.sqliteTransactionAdapters).toContainEqual(
      expect.objectContaining({
        status: "enforced",
        identity: { module: "persistence.ts", exportName: "runBunSqliteTransaction" },
      }),
    );
    for (const registration of [
      ...core.persistedCodecs,
      ...core.persistedStoreConsumers,
      ...core.sqliteTransactionConsumers,
    ]) {
      expect(core.operationalResultApis).toContainEqual(registration.identity);
    }
    expect(utils.operationalResultApis).toContainEqual({
      module: "persistence.ts",
      exportName: "runBunSqliteTransaction",
    });
  });

  test("the shared SQLite adapter remains contract-ready after production enforcement", () => {
    const utils = architectureManifest.workspaces.find(({ name }) => name === "packages/utils");
    const registration = utils?.sqliteTransactionAdapters[0];
    if (!utils || !registration) throw new Error("shared SQLite adapter registration missing");
    const workspace = {
      ...utils,
      ruleZones: {
        ...utils.ruleZones,
        "architecture/sqlite-transaction-adapter-contract": [{ include: "persistence.ts" }],
        "architecture/no-result-err-in-sqlite-callback": [{ include: "persistence.ts" }],
      },
      sqliteTransactionAdapters: [{ ...registration, status: "enforced" }],
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);
    expect(
      findings.filter(({ rule }) =>
        [
          "architecture/sqlite-transaction-adapter-contract",
          "architecture/no-result-err-in-sqlite-callback",
        ].includes(rule),
      ),
    ).toEqual([]);
  });
});

describe("real declaration integration", () => {
  test("recognizes real installed zod and better-result 3.0 declarations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: Object.fromEntries(
        [
          "architecture/no-unregistered-decoder",
          "architecture/no-production-unwrap",
          "architecture/no-unmapped-result-capture",
        ].map((rule) => [rule, [{ include: "fixture.ts" }]]),
      ),
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unregistered-decoder"),
    ).toHaveLength(1);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-production-unwrap"),
    ).toHaveLength(3);
    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unmapped-result-capture"),
    ).toHaveLength(1);
  });

  test("recursively rejects unknown error payloads through real better-result declarations", () => {
    const resultDecoder = (exportName: string): ResultDecoderRegistration => ({
      status: "enforced",
      identity: { module: "fixture.ts", exportName },
      category: "projection",
      inputParameter: 0,
    });
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-result-decoder",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: {
        "architecture/result-decoder-contract": [{ include: "fixture.ts" }],
      },
      resultDecoders: [
        resultDecoder("decodeRealResult"),
        resultDecoder("decodeRealResultWithUnknownCause"),
      ],
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.identity).toContain("decodeRealResultWithUnknownCause");
    expect(findings[0]?.message).toContain("Result error type is not specific");
  });

  test("enforces Stage 1 contracts and TaggedError redaction against real better-result declarations", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "real-libraries-stage1",
      packageName: "architecture-real-libraries",
      root: "scripts/architecture/fixtures/real-libraries",
      tsconfig: "scripts/architecture/fixtures/real-libraries/tsconfig.json",
      ruleZones: Object.fromEntries(
        [
          "architecture/no-unhandled-exception-contract",
          "architecture/no-unredacted-tagged-error-log",
          "architecture/fallible-api-result",
          "architecture/no-result-wire-leak",
        ].map((rule) => [rule, [{ include: "stage1.ts" }]]),
      ),
      structuredLoggers: [
        {
          sink: { kind: "local", module: "stage1.ts", exportName: "structuredLog" },
          reason: "Fixture logger accepts arbitrary structured fields.",
        },
        {
          sink: {
            kind: "external",
            package: "@stanley2058/simple-module-logger",
            exportName: "error",
          },
          reason: "Real logger accepts arbitrary structured fields.",
        },
      ],
      taggedErrorFormatters: [
        {
          kind: "external",
          package: "@stanley2058/lilac-utils",
          exportName: "formatTaggedErrorForLog",
        },
      ],
      operationalResultApis: [
        { module: "stage1.ts", exportName: "rejectingFallibleApi" },
        { module: "stage1.ts", exportName: "resultFallibleApi" },
        { module: "stage1.ts", exportName: "directResultFallibleApi" },
        { module: "stage1.ts", exportName: "resultFallibleStream" },
        { module: "stage1.ts", exportName: "inferredResultFallibleStream" },
        { module: "stage1.ts", exportName: "wrongResultFallibleStream" },
      ],
    } satisfies WorkspaceArchitecture;
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, workspace);
    const findings = analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program, [
      { packageName: workspace.packageName, root: workspaceProgram.root },
      {
        packageName: "@stanley2058/lilac-utils",
        root: path.join(REPOSITORY_ROOT, "packages/utils"),
      },
    ]);

    expect(
      findings.filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract"),
    ).toHaveLength(7);
    const unhandledMessages = findings
      .filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract")
      .map((finding) => finding.message);
    const unhandledIdentities = findings
      .filter((finding) => finding.rule === "architecture/no-unhandled-exception-contract")
      .map((finding) => finding.identity);
    expect(new Set(unhandledIdentities).size).toBe(7);
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledService.load")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledCallableService.<call>")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("UnhandledHandler.<call>")),
    ).toBeTrue();
    expect(
      unhandledMessages.some((message) => message.includes("laterExportedContract")),
    ).toBeTrue();
    const redactionFindings = findings.filter(
      (finding) => finding.rule === "architecture/no-unredacted-tagged-error-log",
    );
    expect(redactionFindings).toHaveLength(13);
    expect(
      redactionFindings.filter((finding) =>
        finding.identity.includes("destructureTaggedErrorMessage"),
      ),
    ).toHaveLength(2);
    expect(
      redactionFindings.filter((finding) => finding.identity.includes("assignTaggedErrorMessage")),
    ).toHaveLength(2);
    expect(
      redactionFindings.some((finding) => finding.message.includes("JSON.stringify")),
    ).toBeTrue();
    expect(redactionFindings.some((finding) => finding.message.includes("toJSON"))).toBeTrue();
    expect(
      redactionFindings.some((finding) => finding.message.includes("structured logger")),
    ).toBeTrue();
    expect(
      redactionFindings.every((finding) => finding.suggestion.includes("redacting")),
    ).toBeTrue();
    const fallibleFindings = findings.filter(
      (finding) => finding.rule === "architecture/fallible-api-result",
    );
    expect(fallibleFindings).toHaveLength(2);
    expect(fallibleFindings[0]?.message).toContain("rejectingFallibleApi");
    expect(
      fallibleFindings.some((finding) => finding.message.includes("wrongResultFallibleStream")),
    ).toBeTrue();
    expect(
      fallibleFindings.every((finding) => finding.suggestion.includes("Promise<Result<T, E>>")),
    ).toBeTrue();
    const resultLeaks = findings.filter(
      (finding) => finding.rule === "architecture/no-result-wire-leak",
    );
    expect(resultLeaks).toHaveLength(2);
    expect(resultLeaks.every((finding) => finding.message.includes("JSON.stringify"))).toBeTrue();
  });

  test("retains converted Core Stage 1 pilot symbols alongside later stages", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    if (!core) throw new Error("core workspace missing");
    expect(core.operationalResultApis.filter((api) => api.module.startsWith("src/mcp/"))).toEqual([
      { module: "src/mcp/config-file.ts", exportName: "readMcpConfigFile" },
      { module: "src/mcp/config-file.ts", exportName: "writeMcpConfigFileAtomic" },
      { module: "src/mcp/config-file.ts", exportName: "mutateMcpConfigFile" },
      { module: "src/mcp/value-source.ts", exportName: "resolveJsonPointer" },
      { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSource" },
      { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSourceMap" },
      { module: "src/mcp/value-source.ts", exportName: "validateHttpHeaders" },
    ]);
    expect(core.ruleZones["architecture/fallible-api-result"]?.slice(0, 2)).toEqual([
      { include: "src/mcp/value-source.ts" },
      { include: "src/mcp/config-file.ts" },
    ]);
    expect(
      core.exceptionAdapters
        .filter((adapter) =>
          ["McpOAuthProvider.clientInformationForSdkAttempt", "resultToMcpToolValue"].includes(
            adapter.identity.exportName,
          ),
        )
        .map((adapter) => ({
          identity: adapter.identity,
          category: adapter.category,
          externalApi: adapter.externalApi,
          direction: adapter.direction,
        })),
    ).toEqual([
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
      },
    ]);
    expect(
      core.exceptionAdapters.some(
        (adapter) => adapter.identity.exportName === "McpRegistry.reconcileServer",
      ),
    ).toBeFalse();
    expect(
      core.exceptionAdapters.some(
        (adapter) => adapter.identity.exportName === "McpRegistry.initializeCandidate",
      ),
    ).toBeFalse();
    expect(
      core.exceptionAdapters.find(
        (adapter) => adapter.identity.exportName === "opaqueErrorMessage",
      ),
    ).toMatchObject({
      identity: { module: "src/mcp/error-format.ts", exportName: "opaqueErrorMessage" },
      category: "compatibility",
      externalApi: { package: "global", exportName: "Error.message" },
      direction: "capture-external",
    });
    const nonPilot = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/tool-bridge",
    );
    if (!nonPilot) throw new Error("non-pilot workspace missing");
    expect(nonPilot.ruleZones["architecture/no-unhandled-exception-contract"]).toEqual([]);
    expect(nonPilot.ruleZones["architecture/no-unredacted-tagged-error-log"]).toEqual([]);
    expect(nonPilot.ruleZones["architecture/fallible-api-result"]).toEqual([]);
  });

  test("resolves Bun-realpathed cross-workspace declarations to package identities", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    if (!core) throw new Error("core workspace missing");
    const workspaceProgram = createWorkspaceProgram(REPOSITORY_ROOT, core);
    const sourceFile = workspaceProgram.program.getSourceFile(
      path.join(workspaceProgram.root, "src/mcp/value-source.ts"),
    );
    if (!sourceFile) throw new Error("core integration source missing");
    let declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined;
    const checker = workspaceProgram.program.getTypeChecker();
    const visit = (node: ts.Node): void => {
      if (
        !declaration &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "isRecord"
      ) {
        declaration = checker.getResolvedSignature(node)?.declaration;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const packageRoots = architectureManifest.workspaces.map((workspace) => ({
      packageName: workspace.packageName,
      root: path.join(REPOSITORY_ROOT, workspace.root),
    }));
    expect(declarationPackageName(declaration, packageRoots)).toBe("@stanley2058/lilac-utils");
  }, 30_000);

  test("fails closed when a production module cannot be resolved", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "diagnostics",
      packageName: "architecture-diagnostics",
      root: "scripts/architecture/fixtures/diagnostics",
      tsconfig: "scripts/architecture/fixtures/diagnostics/tsconfig.json",
      compatibilityOutputs: [
        {
          sink: {
            kind: "external",
            package: "architecture-fixture-missing-module",
            exportName: "missing",
          },
          category: "worker",
          reason: "Exercises targeted resolution validation for a registered sink.",
        },
      ],
    } satisfies WorkspaceArchitecture;
    expect(() => createWorkspaceProgram(REPOSITORY_ROOT, workspace)).toThrow(
      "TS6 cannot safely analyze diagnostics",
    );
  });

  test("does not request unrelated semantic diagnostics", () => {
    const workspace = {
      ...BASE_WORKSPACE,
      name: "semantic-diagnostics",
      packageName: "architecture-semantic-diagnostics",
      root: "scripts/architecture/fixtures/diagnostics",
      tsconfig: "scripts/architecture/fixtures/diagnostics/semantic-tsconfig.json",
    } satisfies WorkspaceArchitecture;
    expect(() => createWorkspaceProgram(REPOSITORY_ROOT, workspace)).not.toThrow();
  });
});

describe("ratchet infrastructure", () => {
  test("requires the manifest to exactly match discovered Bun workspaces", () => {
    expect(
      compareWorkspaceInventory(
        ["apps/core", "packages/utils", "packages/new-workspace"],
        ["apps/core", "apps/removed-workspace", "packages/utils", "packages/utils"],
      ),
    ).toEqual({
      duplicateManifestRoots: ["packages/utils"],
      missingManifestRoots: ["apps/removed-workspace"],
      unmanifestedRoots: ["packages/new-workspace"],
    });
    expect(
      compareWorkspaceInventory(["apps/core", "packages/utils"], ["packages/utils", "apps/core"]),
    ).toEqual({
      duplicateManifestRoots: [],
      missingManifestRoots: [],
      unmanifestedRoots: [],
    });
    expect(() =>
      assertWorkspaceInventoryMatches(
        ["apps/core", "packages/new-workspace"],
        ["apps/core", "apps/removed-workspace"],
      ),
    ).toThrow(
      "Unmanifested Bun workspaces: packages/new-workspace. Add them to scripts/architecture/manifest.ts before scanning.",
    );
  });

  test("fingerprints tolerate line movement and unrelated surrounding edits", () => {
    const sourceA = ts.createSourceFile(
      "a.ts",
      "const value = input as { id: string };",
      ts.ScriptTarget.Latest,
      true,
    );
    const sourceB = ts.createSourceFile(
      "a.ts",
      "const unrelated = 1;\n\n\nconst value = input as { id: string };",
      ts.ScriptTarget.Latest,
      true,
    );
    const assertion = (source: ts.SourceFile): ts.AsExpression => {
      let found: ts.AsExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isAsExpression(node)) found = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!found) throw new Error("fixture assertion missing");
      return found;
    };
    const input = {
      workspace: "fixture",
      rule: "architecture/no-unknown-assertion" as const,
      module: "a.ts",
      symbolPath: "decode",
    };
    expect(createFingerprint({ ...input, node: assertion(sourceA) })).toBe(
      createFingerprint({ ...input, node: assertion(sourceB) }),
    );
  });

  test("fingerprints separate same-named symbols across modules and classes", () => {
    const source = ts.createSourceFile(
      "same.ts",
      "class Left { decode() { return input as { id: string }; } } class Right { decode() { return input as { id: string }; } }",
      ts.ScriptTarget.Latest,
      true,
    );
    const assertions: ts.AsExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) assertions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const left = assertions[0];
    const right = assertions[1];
    if (!left || !right) throw new Error("class assertion fixtures missing");
    const common = {
      workspace: "fixture",
      rule: "architecture/no-unknown-assertion" as const,
      module: "same.ts",
    };
    expect(createFingerprint({ ...common, symbolPath: "Left.decode", node: left })).not.toBe(
      createFingerprint({ ...common, symbolPath: "Right.decode", node: right }),
    );
    expect(
      createFingerprint({ ...common, module: "other.ts", symbolPath: "Left.decode", node: left }),
    ).not.toBe(createFingerprint({ ...common, symbolPath: "Left.decode", node: left }));
  });

  test("separates package/rule baselines and reports stale entries as warnings", () => {
    const finding = findingsFor("architecture/no-unknown-assertion", "domain.ts")[0];
    if (!finding) throw new Error("fixture finding missing");
    const boundary = baselineFromFindings(
      [finding],
      "boundary-validation",
      "reviewed existing finding",
    );
    const matched = applyBaselines([finding], boundary, {});
    expect(matched.diagnostics).toHaveLength(0);
    const stale = applyBaselines([], boundary, {});
    expect(stale.diagnostics).toHaveLength(1);
    expect(stale.diagnostics[0]?.severity).toBe("warning");
    expect(formatBaselineModule("boundaryValidationBaseline", boundary)).toContain(
      '"architecture/no-unknown-assertion"',
    );
    const migrated = applyBaselines([finding], boundary, {}, new Set(["fixture"]));
    expect(migrated.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBeTrue();
    expect(
      migrated.diagnostics.some((diagnostic) => diagnostic.message.includes("Migrated package")),
    ).toBeTrue();
    const migratedModule = applyBaselines(
      [finding],
      boundary,
      {},
      new Set(),
      new Map([["fixture", [{ module: "domain.ts" }]]]),
    );
    expect(
      migratedModule.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    ).toBeTrue();
    expect(
      migratedModule.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("Zero-baseline scope"),
      ),
    ).toBeTrue();

    const baselineEntry = boundary.fixture?.[finding.rule]?.[0];
    if (!baselineEntry) throw new Error("fixture baseline entry missing");
    const scopedBaseline = {
      fixture: {
        [finding.rule]: [
          { ...baselineEntry, identity: "domain.ts#run.child" },
          { ...baselineEntry, identity: "domain.ts#runner" },
        ],
      },
    } satisfies ArchitectureBaseline;
    const scoped = applyBaselines(
      [],
      scopedBaseline,
      {},
      new Set(),
      new Map([["fixture", [{ module: "domain.ts", symbol: "run" }]]]),
    );
    expect(scoped.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      "error",
      "warning",
    ]);
  });

  test("creates exactly one Program per active workspace", () => {
    const manifest = {
      version: 1,
      workspaces: [
        { ...BASE_WORKSPACE, name: "fixture-a" },
        { ...BASE_WORKSPACE, name: "fixture-b" },
      ],
    } satisfies ArchitectureManifest;
    let programs = 0;
    analyzeArchitecture(REPOSITORY_ROOT, manifest, (_root, _workspace) => {
      programs += 1;
      return { root: FIXTURE_ROOT, program: fixtureProgram };
    });
    expect(programs).toBe(2);
  });
});
