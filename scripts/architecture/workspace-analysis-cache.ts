import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript-codegen";

import type { ActivePersistenceInfrastructure, WorkspacePackageRoot } from "./analyzer.ts";
import type { ArchitectureManifest, WorkspaceArchitecture } from "./manifest.ts";
import { ARCHITECTURE_RULES, type ArchitectureDiagnostic } from "./model.ts";

const CACHE_SCHEMA = 1;
const IMPLEMENTATION_FILES = [
  "analyzer.ts",
  "fingerprint.ts",
  "manifest.ts",
  "model.ts",
  "precise-exception-identities.ts",
  "runner.ts",
  "source-policy.ts",
  "workspace-analysis-cache.ts",
] as const;

export interface WorkspaceAnalysisCacheInputs {
  readonly packageRoots: readonly WorkspacePackageRoot[];
  readonly activeEventDeliveryApiPackages: ReadonlySet<string>;
  readonly activePersistenceInfrastructure: ActivePersistenceInfrastructure;
  readonly approvedExceptionAdapters: ArchitectureManifest["approvedExceptionAdapters"];
}

interface CacheEntry {
  readonly schema: number;
  readonly key: string;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Set) return stableJson([...value].sort());
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${fields.map(([name, field]) => `${JSON.stringify(name)}:${stableJson(field)}`).join(",")}}`;
}

function updateHash(hash: ReturnType<typeof createHash>, label: string, value: string): void {
  hash.update(`${label.length}:${label}:${value.length}:`);
  hash.update(value);
}

function implementationFingerprint(hash: ReturnType<typeof createHash>): void {
  for (const file of IMPLEMENTATION_FILES) {
    const absolute = path.join(import.meta.dir, file);
    updateHash(hash, `implementation:${file}`, readFileSync(absolute, "utf8"));
  }
}

export function workspaceAnalysisCacheKey(
  repositoryRoot: string,
  workspace: WorkspaceArchitecture,
  program: ts.Program,
  inputs: WorkspaceAnalysisCacheInputs,
): string {
  const hash = createHash("sha256");
  updateHash(hash, "schema", String(CACHE_SCHEMA));
  updateHash(hash, "repository", realpathSync(repositoryRoot));
  updateHash(hash, "typescript", ts.version);
  updateHash(hash, "compiler-options", stableJson(program.getCompilerOptions()));
  updateHash(hash, "workspace", stableJson(workspace));
  updateHash(hash, "analysis-inputs", stableJson(inputs));
  implementationFingerprint(hash);

  const sources = [...program.getSourceFiles()].sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  for (const source of sources) {
    updateHash(hash, `source:${source.fileName}`, source.text);
  }
  return hash.digest("hex");
}

function isArchitectureDiagnostic(value: unknown): value is ArchitectureDiagnostic {
  if (!value || typeof value !== "object") return false;
  const diagnostic = value as Partial<ArchitectureDiagnostic>;
  return (
    ARCHITECTURE_RULES.includes(diagnostic.rule as (typeof ARCHITECTURE_RULES)[number]) &&
    (diagnostic.severity === "error" || diagnostic.severity === "warning") &&
    typeof diagnostic.workspace === "string" &&
    typeof diagnostic.message === "string" &&
    typeof diagnostic.suggestion === "string" &&
    typeof diagnostic.identity === "string" &&
    typeof diagnostic.fingerprint === "string"
  );
}

function parseCacheEntry(serialized: string, key: string): CacheEntry | undefined {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<CacheEntry>;
  return entry.schema === CACHE_SCHEMA &&
    entry.key === key &&
    Array.isArray(entry.diagnostics) &&
    entry.diagnostics.every(isArchitectureDiagnostic)
    ? (entry as CacheEntry)
    : undefined;
}

export class WorkspaceAnalysisCache {
  readonly #directory: string;

  constructor(repositoryRoot: string, cacheRoot = os.tmpdir()) {
    const repositoryKey = createHash("sha256")
      .update(realpathSync(repositoryRoot))
      .digest("hex")
      .slice(0, 16);
    this.#directory = path.join(cacheRoot, "lilac-architecture-cache-v1", repositoryKey);
  }

  read(key: string): readonly ArchitectureDiagnostic[] | undefined {
    try {
      return parseCacheEntry(readFileSync(this.#entryPath(key), "utf8"), key)?.diagnostics;
    } catch {
      return undefined;
    }
  }

  write(key: string, diagnostics: readonly ArchitectureDiagnostic[]): void {
    const target = this.#entryPath(key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        temporary,
        JSON.stringify({ schema: CACHE_SCHEMA, key, diagnostics } satisfies CacheEntry),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      renameSync(temporary, target);
    } catch {
      // A temporary-directory failure must not turn the architecture optimization into a gate failure.
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // The atomic rename consumed the temporary file, or another worker already cleaned it up.
      }
    }
  }

  #entryPath(key: string): string {
    return path.join(this.#directory, `${key}.json`);
  }
}
