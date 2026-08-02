import path from "node:path";

import { describe, expect, test } from "bun:test";
import ts from "typescript-codegen";

import { analyzeWorkspace, declarationPackageName } from "./analyzer.ts";
import { applyBaselines, baselineFromFindings, formatBaselineModule } from "./baseline.ts";
import { createFingerprint } from "./fingerprint.ts";
import type { ArchitectureManifest, WorkspaceArchitecture } from "./manifest.ts";
import { architectureManifest } from "./manifest.ts";
import type { ArchitectureDiagnostic, ArchitectureRule } from "./model.ts";
import { createWorkspaceProgram } from "./program.ts";
import { analyzeArchitecture } from "./runner.ts";
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
  panicSites: [],
  compatibilityOutputs: [],
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
