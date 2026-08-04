import type {
  ArchitectureBaseline,
  ArchitectureDiagnostic,
  ArchitectureRule,
  BaselineEntry,
  RuleGroup,
} from "./model.ts";
import { ARCHITECTURE_RULES, RULE_GROUPS } from "./model.ts";
import type { ZeroBaselineScope } from "./manifest.ts";
import { zeroBaselineScopeOwns } from "./manifest.ts";

export interface BaselineEvaluation {
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly matched: number;
}

export function applyBaselines(
  findings: readonly ArchitectureDiagnostic[],
  boundaryValidation: ArchitectureBaseline,
  failureFlow: ArchitectureBaseline,
  migratedWorkspaces: ReadonlySet<string> = new Set(),
  zeroBaselineScopes: ReadonlyMap<string, readonly ZeroBaselineScope[]> = new Map(),
): BaselineEvaluation {
  const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
  const baselineKeys = new Set<string>();
  const stale: ArchitectureDiagnostic[] = [];
  const baselineKey = (workspace: string, fingerprint: string): string =>
    `${workspace}\0${fingerprint}`;

  for (const [group, baseline] of [
    ["boundary-validation", boundaryValidation],
    ["failure-flow", failureFlow],
  ] as const satisfies readonly (readonly [RuleGroup, ArchitectureBaseline])[]) {
    for (const [workspace, rules] of Object.entries(baseline)) {
      for (const rule of ARCHITECTURE_RULES) {
        if (RULE_GROUPS[rule] !== group) continue;
        for (const entry of rules[rule] ?? []) {
          const fingerprintFinding = byFingerprint.get(entry.fingerprint);
          if (fingerprintFinding && fingerprintFinding.workspace !== workspace) {
            stale.push({
              rule,
              severity: "error",
              workspace,
              message: `Baseline partition ${workspace} cannot suppress a finding owned by ${fingerprintFinding.workspace}.`,
              suggestion:
                "Move the entry to its exact workspace partition or remove it; baseline ownership is workspace-bound.",
              identity: entry.identity,
              fingerprint: `partition-mismatch:${workspace}:${entry.fingerprint}`,
              location: entry.location,
            });
            continue;
          }
          const symbol = entry.identity.slice(
            entry.identity.indexOf("#") + 1,
            entry.identity.indexOf("[") < 0 ? undefined : entry.identity.indexOf("["),
          );
          if (
            zeroBaselineScopes
              .get(workspace)
              ?.some((scope) => zeroBaselineScopeOwns(scope, entry.location.file, symbol))
          ) {
            stale.push({
              rule,
              severity: "error",
              workspace,
              message: `Zero-baseline scope retains a ${group} baseline entry: ${entry.reason}`,
              suggestion:
                "Fix the production violation and remove the baseline entry; declared module and symbol scopes must keep hard-rule baselines at zero.",
              identity: entry.identity,
              fingerprint: `zero-scope-baseline:${entry.fingerprint}`,
              location: entry.location,
            });
            continue;
          }
          if (migratedWorkspaces.has(workspace)) {
            stale.push({
              rule,
              severity: "error",
              workspace,
              message: `Migrated package retains a ${group} baseline entry: ${entry.reason}`,
              suggestion:
                "Remove the violation and baseline entry; migrated packages must keep hard-rule baselines at zero.",
              identity: entry.identity,
              fingerprint: `migrated-baseline:${entry.fingerprint}`,
              location: entry.location,
            });
            continue;
          }
          baselineKeys.add(baselineKey(workspace, entry.fingerprint));
          if (fingerprintFinding) continue;
          stale.push({
            rule,
            severity: "warning",
            workspace,
            message: `Stale ${group} baseline entry: ${entry.reason}`,
            suggestion: "Remove the stale entry after confirming the violation was fixed or moved.",
            identity: entry.identity,
            fingerprint: `stale:${entry.fingerprint}`,
            location: entry.location,
          });
        }
      }
    }
  }

  return {
    diagnostics: [
      ...findings.filter(
        (finding) => !baselineKeys.has(baselineKey(finding.workspace, finding.fingerprint)),
      ),
      ...stale,
    ],
    matched: findings.filter((finding) =>
      baselineKeys.has(baselineKey(finding.workspace, finding.fingerprint)),
    ).length,
  };
}

export function baselineFromFindings(
  findings: readonly ArchitectureDiagnostic[],
  group: RuleGroup,
  reason: string | ((finding: ArchitectureDiagnostic) => string),
): ArchitectureBaseline {
  const baseline: Record<string, Partial<Record<ArchitectureRule, BaselineEntry[]>>> = {};
  const added = new Set<string>();
  for (const finding of findings) {
    if (RULE_GROUPS[finding.rule] !== group) continue;
    if (added.has(finding.fingerprint)) continue;
    added.add(finding.fingerprint);
    if (!finding.location) continue;
    const workspace = (baseline[finding.workspace] ??= {});
    const entries = (workspace[finding.rule] ??= []);
    entries.push({
      fingerprint: finding.fingerprint,
      identity: finding.identity,
      location: finding.location,
      reason: typeof reason === "string" ? reason : reason(finding),
    });
  }
  return baseline;
}

export function stage0BaselineReason(finding: ArchitectureDiagnostic): string {
  switch (finding.rule) {
    case "architecture/no-unregistered-decoder":
      return "Existing boundary validation call awaiting explicit decoder ownership registration.";
    case "architecture/no-domain-unknown":
      return "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.";
    case "architecture/no-unknown-assertion":
      return "Existing structured assertion from unknown awaiting complete runtime validation.";
    case "architecture/no-rich-unknown-predicate":
      return "Existing rich unknown predicate awaiting schema decoding or exact capability registration.";
    case "architecture/no-unknown-member-read":
      return "Existing unknown member read awaiting ownership by an exact boundary decoder.";
    case "architecture/no-unregistered-custom-decoder":
      return "Existing custom decoder awaiting exact boundary ownership registration.";
    case "architecture/closed-union-exhaustiveness":
      return "Existing closed-union control flow awaiting exhaustive handling without a silent default.";
    case "architecture/closed-union-map-exhaustiveness":
      return "Existing closed-union map awaiting a compiler-checked exhaustive shape.";
    case "architecture/open-protocol-normalization":
      return "Existing open protocol adapter awaiting a closed local union and explicit fallback variant.";
    case "architecture/raw-event-message-boundary":
      return "Existing raw event receiver awaiting an honest Message<unknown> contract.";
    case "architecture/complete-event-codec-registry":
      return "Existing canonical event awaiting complete receiver-side codec registration.";
    case "architecture/complete-tool-codec-registry":
      return "Existing known tool awaiting exact presentation codec registration.";
    case "architecture/result-decoder-contract":
      return "Existing decoder awaiting an exact typed Result contract.";
    case "architecture/unknown-free-module":
      return "Existing presentation module awaiting recursive removal of domain-bearing unknown.";
    case "architecture/persisted-codec-contract":
      return "Existing persistence decoder awaiting an explicit versioned Result and provenance contract.";
    case "architecture/persisted-codec-fixture-catalog":
      return "Existing persisted codec awaiting complete current, legacy, absent, unsupported, malformed, and corrupt fixtures.";
    case "architecture/event-handler-result":
      return "Existing event handler awaiting a typed Promise<Result<void, E>> delivery contract.";
    case "architecture/event-delivery-policy-exhaustiveness":
      return "Existing event delivery errors awaiting an exhaustive disposition policy.";
    case "architecture/no-production-unwrap":
      return "Existing unsafe Result extraction awaiting explicit success/error policy handling.";
    case "architecture/no-unmapped-result-capture":
      return "Existing generic Result capture awaiting mapping to a domain-owned error.";
    case "architecture/no-unhandled-exception-contract":
      return "Existing UnhandledException contract awaiting a specific domain-owned error mapping.";
    case "architecture/registered-panic-site":
      return "Existing Panic callsite awaiting reviewed hard-invariant registration.";
    case "architecture/no-result-wire-leak":
      return "Existing Result or TaggedError envelope awaiting compatibility-boundary mapping.";
    case "architecture/no-unredacted-tagged-error-log":
      return "Existing TaggedError serialization awaiting approved redaction.";
    case "architecture/fallible-api-result":
      return "Existing fallible API awaiting a typed Result return contract.";
    case "architecture/sqlite-transaction-adapter-contract":
      return "Existing SQLite transaction wrapper awaiting exact rollback, Panic, and driver-failure handling.";
    case "architecture/sqlite-transaction-consumer":
      return "Existing SQLite transaction consumer awaiting the registered Result adapter.";
    case "architecture/no-result-err-in-sqlite-callback":
      return "Existing raw SQLite callback may return Err without forcing driver rollback.";
  }
}

export function formatBaselineModule(exportName: string, baseline: ArchitectureBaseline): string {
  return [
    'import type { ArchitectureBaseline } from "./model.ts";',
    "",
    `export const ${exportName} = ${JSON.stringify(baseline, null, 2)} satisfies ArchitectureBaseline;`,
    "",
  ].join("\n");
}
