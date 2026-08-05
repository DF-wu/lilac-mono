import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { architectureManifest, type ArchitectureManifest } from "../architecture/manifest.ts";
import { validateWorkspaceInventory } from "../architecture/workspace-inventory.ts";
import {
  findExceptionFlowViolations,
  findDirectSqliteTransactionViolations,
  findInlineAsyncResultCallbackViolations,
  findPresentationDecoderImportViolations,
  findStoreInlineDecodingViolations,
} from "./production-syntax.mts";
import type { ActiveSyntaxRule } from "./syntax-policy.mts";
import type { SyntacticFinding } from "./syntax-rule-utils.mts";

export interface SyntaxFinding {
  readonly workspace: string;
  readonly module: string;
  readonly symbol: string;
  readonly kind: string;
  readonly digest: string;
  readonly rule: ActiveSyntaxRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const ACTIVE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

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
): SyntaxFinding[] {
  return findings.map((finding) => ({ ...finding, rule }));
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
        ),
        ...toSyntaxFindings(
          "lilac/no-inline-async-result-callback",
          findInlineAsyncResultCallbackViolations(source, path),
        ),
        ...toSyntaxFindings(
          "lilac/no-presentation-decoder-import",
          findPresentationDecoderImportViolations(source, path, undefined, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-store-inline-decoding",
          findStoreInlineDecodingViolations(source, path, undefined, manifest),
        ),
        ...toSyntaxFindings(
          "lilac/no-direct-sqlite-transaction",
          findDirectSqliteTransactionViolations(source, path, undefined, manifest),
        ),
      );
    }
  }
  return findings;
}

export function formatSyntaxDiagnostic(finding: SyntaxFinding): string {
  const location = `${finding.workspace}/${finding.module}:${finding.line}:${finding.column}`;
  return `${location} error ${finding.rule} [${finding.symbol}/${finding.kind}] ${finding.message} [digest=${finding.digest}]`;
}

async function main(): Promise<void> {
  const repositoryRoot = join(import.meta.dir, "../..");
  await validateWorkspaceInventory(repositoryRoot);
  const findings = await scanSyntaxFindings();
  for (const finding of findings) console.error(formatSyntaxDiagnostic(finding));
  console.log(`syntax gate: ${findings.length} errors`);
  if (findings.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
