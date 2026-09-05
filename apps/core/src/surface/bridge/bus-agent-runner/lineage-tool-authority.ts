import type { CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";

import type { TranscriptStore } from "../../../transcript/transcript-store";

/** Ordered, cumulative deferred-tool authority for one conversation prefix. */
export class LineageToolAuthority {
  readonly #catalogIds: Set<string>;

  constructor(inheritedCatalogIds: readonly string[] = []) {
    this.#catalogIds = new Set(inheritedCatalogIds);
  }

  select(catalogIds: readonly string[]): void {
    for (const catalogId of catalogIds) this.#catalogIds.add(catalogId);
  }

  snapshot(): string[] {
    return [...this.#catalogIds].sort((left, right) => left.localeCompare(right));
  }
}

/**
 * Return reachable request snapshots from newest to oldest. The current input
 * segment is excluded because its terminal transcript does not exist yet.
 */
export function historicalToolSnapshotRequestIds(
  lineage: CorePrimaryLineageV2 | undefined,
): string[] {
  if (!lineage || lineage.state === "fresh-only") return [];

  const requestIds: string[] = [];
  for (let segmentIndex = lineage.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = lineage.segments[segmentIndex];
    if (!segment || segment.canonicalEnd > lineage.currentCanonicalStart) continue;
    for (let atomIndex = segment.atoms.length - 1; atomIndex >= 0; atomIndex -= 1) {
      const atom = segment.atoms[atomIndex];
      if (atom?.kind === "request" || atom?.kind === "checkpoint") {
        requestIds.push(atom.requestId);
      }
    }
  }
  return requestIds;
}

export function resolveCorePrimaryLoadedCatalogIds(input: {
  lineage?: CorePrimaryLineageV2;
  transcriptStore?: TranscriptStore;
}): string[] {
  for (const requestId of historicalToolSnapshotRequestIds(input.lineage)) {
    const transcript = input.transcriptStore?.getRequestTranscript?.({ requestId });
    const loadedCatalogIds = transcript?.match({
      ok: (value) => value?.loadedCatalogIds,
      err: () => undefined,
    });
    if (loadedCatalogIds !== undefined) return [...loadedCatalogIds];
  }
  return [];
}
