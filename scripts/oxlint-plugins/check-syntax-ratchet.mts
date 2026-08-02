import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { architectureManifest, type ArchitectureManifest } from "../architecture/manifest.ts";
import { validateWorkspaceInventory } from "../architecture/workspace-inventory.ts";
import {
  findExceptionFlowViolations,
  findInlineAsyncResultCallbackViolations,
} from "./production-syntax.mts";
import { syntaxBaseline } from "./syntax-baseline.mts";
import type { SyntacticFinding } from "./syntax-rule-utils.mts";

export const ACTIVE_SYNTAX_RULES = [
  "lilac/no-exception-flow",
  "lilac/no-inline-async-result-callback",
] as const;
export type ActiveSyntaxRule = (typeof ACTIVE_SYNTAX_RULES)[number];

export interface SyntaxBaselineEntry {
  readonly workspace: string;
  readonly module: string;
  readonly symbol: string;
  readonly kind: string;
  readonly digest: string;
  readonly reason: string;
}

export type SyntaxBaseline = Readonly<
  Record<string, Partial<Readonly<Record<ActiveSyntaxRule, readonly SyntaxBaselineEntry[]>>>>
>;

export interface SyntaxFinding extends SyntaxBaselineEntry {
  readonly rule: ActiveSyntaxRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface SyntaxRatchetDiagnostic {
  readonly severity: "error" | "warning";
  readonly rule: ActiveSyntaxRule;
  readonly workspace: string;
  readonly message: string;
  readonly entry: SyntaxBaselineEntry;
  readonly line?: number;
  readonly column?: number;
}

export interface SyntaxRatchetEvaluation {
  readonly diagnostics: readonly SyntaxRatchetDiagnostic[];
  readonly matched: number;
}

const ACTIVE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

function entryKey(entry: SyntaxBaselineEntry): string {
  return [entry.workspace, entry.module, entry.symbol, entry.kind, entry.digest].join("\u0000");
}

function baselineEntries(
  baseline: SyntaxBaseline,
): readonly (readonly [string, ActiveSyntaxRule, SyntaxBaselineEntry])[] {
  const entries: [string, ActiveSyntaxRule, SyntaxBaselineEntry][] = [];
  for (const [workspace, rules] of Object.entries(baseline)) {
    for (const rule of ACTIVE_SYNTAX_RULES) {
      for (const entry of rules[rule] ?? []) entries.push([workspace, rule, entry]);
    }
  }
  return entries;
}

export function evaluateSyntaxRatchet(
  findings: readonly SyntaxFinding[],
  baseline: SyntaxBaseline,
  migratedWorkspaces: ReadonlySet<string>,
): SyntaxRatchetEvaluation {
  const available = new Map<string, SyntaxBaselineEntry[]>();
  const diagnostics: SyntaxRatchetDiagnostic[] = [];
  for (const [partitionWorkspace, rule, entry] of baselineEntries(baseline)) {
    if (!entry.reason.trim()) {
      diagnostics.push({
        severity: "error",
        rule,
        workspace: partitionWorkspace,
        entry,
        message: "Syntax baseline entries require a review reason",
      });
      continue;
    }
    if (entry.workspace !== partitionWorkspace) {
      diagnostics.push({
        severity: "error",
        rule,
        workspace: partitionWorkspace,
        entry,
        message: `Baseline workspace field '${entry.workspace}' does not match partition '${partitionWorkspace}'`,
      });
      continue;
    }
    if (migratedWorkspaces.has(partitionWorkspace)) {
      diagnostics.push({
        severity: "error",
        rule,
        workspace: partitionWorkspace,
        entry,
        message: "Migrated packages must keep active syntax-rule baselines at zero",
      });
      continue;
    }
    const key = `${rule}\u0000${entryKey(entry)}`;
    const matches = available.get(key) ?? [];
    matches.push(entry);
    available.set(key, matches);
  }

  let matched = 0;
  for (const finding of findings) {
    const key = `${finding.rule}\u0000${entryKey(finding)}`;
    const matches = available.get(key);
    if (matches?.length) {
      matches.pop();
      matched += 1;
      continue;
    }
    diagnostics.push({
      severity: "error",
      rule: finding.rule,
      workspace: finding.workspace,
      entry: finding,
      line: finding.line,
      column: finding.column,
      message: finding.message,
    });
  }

  for (const [key, entries] of available) {
    if (!entries.length) continue;
    const rule = ACTIVE_SYNTAX_RULES.find((candidate) => key.startsWith(`${candidate}\u0000`));
    if (!rule) continue;
    for (const entry of entries) {
      diagnostics.push({
        severity: "warning",
        rule,
        workspace: entry.workspace,
        entry,
        message: `Stale syntax baseline entry: ${entry.reason}`,
      });
    }
  }
  return { diagnostics, matched };
}

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return productionFiles(path);
      return entry.isFile() && ACTIVE_EXTENSION.test(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

function toSyntaxFindings<Kind extends string>(
  rule: ActiveSyntaxRule,
  findings: readonly SyntacticFinding<Kind>[],
  reason: string,
): SyntaxFinding[] {
  return findings.map((finding) => ({ ...finding, rule, reason }));
}

export async function scanSyntaxFindings(
  manifest: ArchitectureManifest = architectureManifest,
): Promise<SyntaxFinding[]> {
  const findings: SyntaxFinding[] = [];
  for (const workspace of manifest.workspaces) {
    const paths = (await productionFiles(workspace.root)).sort();
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      findings.push(
        ...toSyntaxFindings(
          "lilac/no-exception-flow",
          findExceptionFlowViolations(source, path, undefined, manifest),
          "Reviewed Stage 0 pre-existing exception-flow migration debt",
        ),
        ...toSyntaxFindings(
          "lilac/no-inline-async-result-callback",
          findInlineAsyncResultCallbackViolations(source, path),
          "Reviewed Stage 0 pre-existing inline async Result callback debt",
        ),
      );
    }
  }
  return findings;
}

export function baselineFromFindings(findings: readonly SyntaxFinding[]): SyntaxBaseline {
  const baseline: Record<string, Partial<Record<ActiveSyntaxRule, SyntaxBaselineEntry[]>>> = {};
  for (const finding of findings) {
    const workspace = (baseline[finding.workspace] ??= {});
    const entries = (workspace[finding.rule] ??= []);
    entries.push({
      workspace: finding.workspace,
      module: finding.module,
      symbol: finding.symbol,
      kind: finding.kind,
      digest: finding.digest,
      reason: finding.reason,
    });
  }
  for (const rules of Object.values(baseline)) {
    for (const rule of ACTIVE_SYNTAX_RULES) {
      rules[rule]?.sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
    }
  }
  return baseline;
}

export function formatSyntaxBaseline(baseline: SyntaxBaseline): string {
  return [
    'import type { SyntaxBaseline } from "./check-syntax-ratchet.mts";',
    "",
    `export const syntaxBaseline = ${JSON.stringify(baseline, null, 2)} satisfies SyntaxBaseline;`,
    "",
  ].join("\n");
}

function formatDiagnostic(diagnostic: SyntaxRatchetDiagnostic): string {
  const location =
    diagnostic.line === undefined
      ? `${diagnostic.entry.workspace}/${diagnostic.entry.module}`
      : `${diagnostic.entry.workspace}/${diagnostic.entry.module}:${diagnostic.line}:${diagnostic.column}`;
  return `${location} ${diagnostic.severity} ${diagnostic.rule} [${diagnostic.entry.symbol}/${diagnostic.entry.kind}] ${diagnostic.message}`;
}

async function main(): Promise<void> {
  const repositoryRoot = join(import.meta.dir, "../..");
  await validateWorkspaceInventory(repositoryRoot);
  const findings = await scanSyntaxFindings();
  const manifest: ArchitectureManifest = architectureManifest;
  const migrated = new Set(
    manifest.workspaces
      .filter((workspace) => workspace.status === "migrated")
      .map((workspace) => workspace.root),
  );
  const evaluation = evaluateSyntaxRatchet(findings, syntaxBaseline, migrated);
  for (const diagnostic of evaluation.diagnostics) {
    const output = diagnostic.severity === "error" ? console.error : console.warn;
    output(formatDiagnostic(diagnostic));
  }
  const errors = evaluation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  console.log(
    `syntax ratchet: ${findings.length} findings, ${evaluation.matched} baselined, ${errors.length} errors`,
  );
  if (errors.length) process.exitCode = 1;
}

if (import.meta.main) await main();
