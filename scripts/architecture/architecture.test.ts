import path from "node:path";

import { describe, expect, test } from "bun:test";
import ts from "typescript-codegen";

import { analyzeWorkspace, declarationPackageName } from "./analyzer.ts";
import { applyBaselines, baselineFromFindings, formatBaselineModule } from "./baseline.ts";
import { createFingerprint } from "./fingerprint.ts";
import type {
  ArchitectureManifest,
  OpenProtocolAdapter,
  WorkspaceArchitecture,
} from "./manifest.ts";
import { architectureManifest, assertArchitectureManifestIntegrity } from "./manifest.ts";
import type { ArchitectureDiagnostic, ArchitectureRule } from "./model.ts";
import { createWorkspaceProgram } from "./program.ts";
import { analyzeArchitecture } from "./runner.ts";
import { isProductionFileName } from "./source-policy.ts";
import {
  assertWorkspaceInventoryMatches,
  compareWorkspaceInventory,
} from "./workspace-inventory.ts";

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
    expect(remoteRunner?.boundaryDecoders).toEqual([
      {
        identity: { module: "src/cli.ts", exportName: "ordinaryFileStartOrUndefined" },
        category: "projection",
      },
      {
        identity: { module: "src/cli.ts", exportName: "parseEnvelope" },
        category: "wire",
      },
      {
        identity: { module: "src/cli.ts", exportName: "decodeDaemonResponseEnvelope" },
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

  test("registers only converted Core Stage 1 pilot symbols", () => {
    const core = architectureManifest.workspaces.find(
      (workspace) => workspace.root === "apps/core",
    );
    if (!core) throw new Error("core workspace missing");
    expect(core.operationalResultApis).toEqual([
      { module: "src/mcp/config-file.ts", exportName: "readMcpConfigFile" },
      { module: "src/mcp/config-file.ts", exportName: "writeMcpConfigFileAtomic" },
      { module: "src/mcp/config-file.ts", exportName: "mutateMcpConfigFile" },
      { module: "src/mcp/value-source.ts", exportName: "resolveJsonPointer" },
      { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSource" },
      { module: "src/mcp/value-source.ts", exportName: "resolveMcpValueSourceMap" },
      { module: "src/mcp/value-source.ts", exportName: "validateHttpHeaders" },
    ]);
    expect(core.ruleZones["architecture/fallible-api-result"]).toEqual([
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
