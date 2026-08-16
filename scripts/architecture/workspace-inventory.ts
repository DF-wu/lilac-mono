import { readdir } from "node:fs/promises";
import path from "node:path";

import type { ArchitectureManifest } from "./manifest.ts";
import { architectureManifest } from "./manifest.ts";

const WORKSPACE_SCOPES = ["apps", "packages"] as const;

export interface WorkspaceInventoryComparison {
  readonly duplicateManifestRoots: readonly string[];
  readonly missingManifestRoots: readonly string[];
  readonly unmanifestedRoots: readonly string[];
}

export function compareWorkspaceInventory(
  discoveredRoots: readonly string[],
  manifestRoots: readonly string[],
): WorkspaceInventoryComparison {
  const discovered = new Set(discoveredRoots);
  const manifest = new Set(manifestRoots);
  const seen = new Set<string>();
  const duplicateManifestRoots = manifestRoots.filter((root) => {
    if (seen.has(root)) return true;
    seen.add(root);
    return false;
  });

  return {
    duplicateManifestRoots: [...new Set(duplicateManifestRoots)].sort(),
    missingManifestRoots: [...manifest].filter((root) => !discovered.has(root)).sort(),
    unmanifestedRoots: [...discovered].filter((root) => !manifest.has(root)).sort(),
  };
}

export async function discoverWorkspaceRoots(repositoryRoot: string): Promise<readonly string[]> {
  const roots = await Promise.all(
    WORKSPACE_SCOPES.map(async (scope) => {
      const entries = await readdir(path.join(repositoryRoot, scope), { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${scope}/${entry.name}`);
      const packageRoots = await Promise.all(
        candidates.map(async (root) =>
          (await Bun.file(path.join(repositoryRoot, root, "package.json")).exists())
            ? root
            : undefined,
        ),
      );
      return packageRoots.filter((root): root is string => root !== undefined);
    }),
  );
  return roots.flat().sort();
}

export function assertWorkspaceInventoryMatches(
  discoveredRoots: readonly string[],
  manifestRoots: readonly string[],
): void {
  const comparison = compareWorkspaceInventory(discoveredRoots, manifestRoots);
  const problems: string[] = [];
  if (comparison.unmanifestedRoots.length) {
    problems.push(
      `Unmanifested Bun workspaces: ${comparison.unmanifestedRoots.join(", ")}. Add them to scripts/architecture/manifest.ts before scanning.`,
    );
  }
  if (comparison.missingManifestRoots.length) {
    problems.push(
      `Manifest roots without an apps/* or packages/* package.json workspace: ${comparison.missingManifestRoots.join(", ")}. Remove or correct the stale manifest entries.`,
    );
  }
  if (comparison.duplicateManifestRoots.length) {
    problems.push(
      `Duplicate architecture manifest roots: ${comparison.duplicateManifestRoots.join(", ")}. Keep exactly one entry per workspace.`,
    );
  }
  if (problems.length) {
    throw new Error(`Architecture workspace inventory mismatch.\n${problems.join("\n")}`);
  }
}

export async function validateWorkspaceInventory(
  repositoryRoot: string,
  manifest: ArchitectureManifest = architectureManifest,
): Promise<void> {
  const discoveredRoots = await discoverWorkspaceRoots(repositoryRoot);
  assertWorkspaceInventoryMatches(
    discoveredRoots,
    manifest.workspaces.map((workspace) => workspace.root),
  );
}
