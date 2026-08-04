import type { SyntaxBaseline } from "../oxlint-plugins/check-syntax-ratchet.mts";
import { ACTIVE_SYNTAX_RULES } from "../oxlint-plugins/syntax-policy.mts";
import type { ArchitectureManifest, SymbolIdentity, WorkspaceArchitecture } from "./manifest.ts";
import {
  EXACT_REGISTRATION_ARCHITECTURE_RULES,
  FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES,
} from "./manifest.ts";
import type { ArchitectureBaseline, ArchitectureRule } from "./model.ts";

export interface Stage7PreflightBaselines {
  readonly semantic: readonly ArchitectureBaseline[];
  readonly syntax: SyntaxBaseline;
}

interface RequiredZone {
  readonly rule: ArchitectureRule;
  readonly identity: SymbolIdentity;
}

function identityKey(identity: SymbolIdentity): string {
  return `${identity.module}#${identity.exportName}`;
}

function requiredExactZones(workspace: WorkspaceArchitecture): readonly RequiredZone[] {
  return [
    ...workspace.openProtocolAdapters.map(({ identity }) => ({
      rule: "architecture/open-protocol-normalization" as const,
      identity,
    })),
    ...workspace.eventCodecRegistries
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => ({
        rule: "architecture/complete-event-codec-registry" as const,
        identity,
      })),
    ...workspace.toolCodecRegistries
      .filter(({ status }) => status === "enforced")
      .flatMap(({ identity, aliases }) =>
        [identity, ...aliases].map((registeredIdentity) => ({
          rule: "architecture/complete-tool-codec-registry" as const,
          identity: registeredIdentity,
        })),
      ),
    ...workspace.resultDecoders
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => ({
        rule: "architecture/result-decoder-contract" as const,
        identity,
      })),
    ...workspace.unknownFreeModules
      .filter(({ status }) => status === "enforced")
      .map(({ module }) => ({
        rule: "architecture/unknown-free-module" as const,
        identity: { module, exportName: "<module>" },
      })),
    ...workspace.persistedCodecs
      .filter(({ status }) => status === "enforced")
      .flatMap(({ identity }) => [
        { rule: "architecture/persisted-codec-contract" as const, identity },
        { rule: "architecture/persisted-codec-fixture-catalog" as const, identity },
      ]),
    ...workspace.persistedStoreConsumers
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => ({
        rule: "architecture/persisted-codec-contract" as const,
        identity,
      })),
    ...workspace.sqliteTransactionAdapters
      .filter(({ status }) => status === "enforced")
      .flatMap(({ identity }) => [
        { rule: "architecture/sqlite-transaction-adapter-contract" as const, identity },
        { rule: "architecture/no-result-err-in-sqlite-callback" as const, identity },
      ]),
    ...workspace.sqliteTransactionConsumers
      .filter(({ status }) => status === "enforced")
      .flatMap(({ identity }) => [
        { rule: "architecture/sqlite-transaction-consumer" as const, identity },
        { rule: "architecture/no-result-err-in-sqlite-callback" as const, identity },
      ]),
    ...workspace.rawEventMessageBoundaries
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => ({
        rule: "architecture/raw-event-message-boundary" as const,
        identity,
      })),
    ...workspace.eventDeliveryApis
      .filter(({ status }) => status === "enforced")
      .flatMap(({ identity, deliveryPolicy }) => [
        { rule: "architecture/event-handler-result" as const, identity },
        {
          rule: "architecture/event-delivery-policy-exhaustiveness" as const,
          identity: deliveryPolicy,
        },
      ]),
  ];
}

function requiredOperationalResultApis(
  workspace: WorkspaceArchitecture,
): readonly SymbolIdentity[] {
  return [
    ...workspace.resultDecoders
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
    ...workspace.persistedCodecs
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
    ...workspace.persistedStoreConsumers
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
    ...workspace.sqliteTransactionAdapters
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
    ...workspace.sqliteTransactionConsumers
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
    ...workspace.eventDeliveryApis
      .filter(({ status }) => status === "enforced")
      .map(({ identity }) => identity),
  ];
}

function baselineEntryCount(workspace: string, baselines: Stage7PreflightBaselines): number {
  const semantic = baselines.semantic.reduce(
    (count, baseline) =>
      count +
      Object.values(baseline[workspace] ?? {}).reduce(
        (ruleCount, entries) => ruleCount + (entries?.length ?? 0),
        0,
      ),
    0,
  );
  const syntax = ACTIVE_SYNTAX_RULES.reduce(
    (count, rule) => count + (baselines.syntax[workspace]?.[rule]?.length ?? 0),
    0,
  );
  return semantic + syntax;
}

function allBaselinePartitions(baselines: Stage7PreflightBaselines): ReadonlySet<string> {
  return new Set([
    ...baselines.semantic.flatMap((baseline) => Object.keys(baseline)),
    ...Object.keys(baselines.syntax),
  ]);
}

function totalBaselineEntryCount(baselines: Stage7PreflightBaselines): number {
  return [...allBaselinePartitions(baselines)].reduce(
    (count, workspace) => count + baselineEntryCount(workspace, baselines),
    0,
  );
}

function assertExactRegistrationZones(workspace: WorkspaceArchitecture): void {
  const required = new Map<ArchitectureRule, Set<string>>();
  for (const { rule, identity } of requiredExactZones(workspace)) {
    const modules = required.get(rule) ?? new Set<string>();
    modules.add(identity.module);
    required.set(rule, modules);
  }

  for (const rule of EXACT_REGISTRATION_ARCHITECTURE_RULES) {
    const zones = workspace.ruleZones[rule] ?? [];
    const actual = zones.map(({ include }) => include);
    const actualSet = new Set(actual);
    const expected = required.get(rule) ?? new Set<string>();
    const matches =
      actualSet.size === expected.size && [...expected].every((module) => actualSet.has(module));
    if (!matches) {
      throw new Error(
        `Migrated workspace ${workspace.name} exact ${rule} zones must equal registered modules; expected ${[...expected].sort().join(", ") || "none"}; received ${[...actualSet].sort().join(", ") || "none"}.`,
      );
    }
  }
}

export function assertStage7EnforcementPreflight(
  manifest: ArchitectureManifest,
  baselines: Stage7PreflightBaselines,
): void {
  const workspaceNames = new Set(manifest.workspaces.map(({ name }) => name));
  for (const partition of allBaselinePartitions(baselines)) {
    if (!workspaceNames.has(partition)) {
      throw new Error(`Architecture baseline contains unknown workspace partition ${partition}.`);
    }
  }
  if (
    manifest.workspaces.every(({ status }) => status === "migrated") &&
    totalBaselineEntryCount(baselines) !== 0
  ) {
    throw new Error(
      "All migrated workspaces require every semantic and syntax baseline to be empty.",
    );
  }

  for (const workspace of manifest.workspaces) {
    if (workspace.status !== "migrated") continue;

    for (const rule of FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES) {
      const zones = workspace.ruleZones[rule] ?? [];
      if (zones.length !== 1 || zones[0]?.include !== "**") {
        throw new Error(
          `Migrated workspace ${workspace.name} must enforce package-wide rule ${rule} with the single '**' zone.`,
        );
      }
    }

    assertExactRegistrationZones(workspace);

    const operationalResultApis = new Set(workspace.operationalResultApis.map(identityKey));
    for (const identity of requiredOperationalResultApis(workspace)) {
      if (!operationalResultApis.has(identityKey(identity))) {
        throw new Error(
          `Migrated workspace ${workspace.name} has unregistered operational Result API ${identityKey(identity)}.`,
        );
      }
    }

    const baselineEntries = baselineEntryCount(workspace.name, baselines);
    if (baselineEntries !== 0) {
      throw new Error(
        `Migrated workspace ${workspace.name} must have zero semantic and syntax baseline entries; found ${baselineEntries}.`,
      );
    }
  }
}
