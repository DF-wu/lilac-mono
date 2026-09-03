import { describe, expect, it } from "bun:test";
import {
  buildCoreLineageManifestV2,
  type CoreLineageSegmentInputV2,
  type CorePrimaryLineageV2,
} from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import {
  LineageToolAuthority,
  historicalToolSnapshotRequestIds,
  resolveCorePrimaryLoadedCatalogIds,
} from "../../../src/surface/bridge/bus-agent-runner/lineage-tool-authority";
import type { TranscriptSnapshot, TranscriptStore } from "../../../src/transcript/transcript-store";

function manifest(
  segments: readonly CoreLineageSegmentInputV2[],
  currentSegmentIndex: number,
): CorePrimaryLineageV2 {
  const built = buildCoreLineageManifestV2(segments, { currentSegmentIndex });
  if (built.status === "error") throw built.error;
  return built.value;
}

function requestSegment(requestId: string): CoreLineageSegmentInputV2 {
  return {
    atoms: [
      {
        kind: "request",
        requestId,
        transcriptDigest: "11".repeat(32),
        providerFamily: "ai-sdk",
        containsCrossFamilyTurns: false,
      },
    ],
    requestSource: {
      aliases: [
        {
          requestClient: "discord",
          surfaceId: "discord:channel",
          sessionId: "channel",
          messageId: `message-${requestId}`,
        },
      ],
    },
    canonicalMessages: [{ role: "assistant", content: requestId }],
  };
}

function checkpointSegment(requestId: string): CoreLineageSegmentInputV2 {
  return {
    atoms: [
      {
        kind: "checkpoint",
        requestId,
        transcriptDigest: "22".repeat(32),
      },
    ],
    canonicalMessages: [{ role: "assistant", content: requestId }],
  };
}

function currentSegment(messageId: string): CoreLineageSegmentInputV2 {
  return {
    atoms: [
      {
        kind: "surface",
        requestClient: "discord",
        surfaceId: "discord:channel",
        sessionId: "channel",
        messageId,
      },
    ],
    canonicalMessages: [{ role: "user", content: messageId }],
  };
}

function transcript(requestId: string, loadedCatalogIds?: readonly string[]): TranscriptSnapshot {
  return {
    requestId,
    sessionId: "channel",
    requestClient: "discord",
    createdTs: 1,
    updatedTs: 1,
    messages: [{ role: "assistant", content: requestId }],
    providerState: null,
    ...(loadedCatalogIds ? { loadedCatalogIds: [...loadedCatalogIds] } : {}),
  };
}

function store(snapshots: ReadonlyMap<string, TranscriptSnapshot>): TranscriptStore {
  return {
    saveRequestTranscript: () => Result.ok(undefined),
    linkSurfaceMessagesToRequest: () => undefined,
    getTranscriptBySurfaceMessage: () => Result.ok(null),
    getRequestTranscript: ({ requestId }) => Result.ok(snapshots.get(requestId) ?? null),
    close: () => undefined,
  };
}

describe("prefix-lineage tool authority", () => {
  it("keeps selections monotonic and emits a canonical snapshot", () => {
    const authority = new LineageToolAuthority(["mcp_zeta", "mcp_alpha"]);
    authority.select(["mcp_alpha", "mcp_beta"]);

    expect(authority.snapshot()).toEqual(["mcp_alpha", "mcp_beta", "mcp_zeta"]);
  });

  it("inherits the newest reachable request snapshot on continuation and a fork after it", () => {
    const lineage = manifest([requestSegment("request1"), currentSegment("current")], 1);
    const snapshots = new Map([
      ["request1", transcript("request1", ["mcp_excalidraw_draw", "mcp_excalidraw_read"])],
      ["sibling", transcript("sibling", ["mcp_unreachable"])],
    ]);

    expect(historicalToolSnapshotRequestIds(lineage)).toEqual(["request1"]);
    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage,
        transcriptStore: store(snapshots),
      }),
    ).toEqual(["mcp_excalidraw_draw", "mcp_excalidraw_read"]);
  });

  it("does not inherit a selection made after the fork point", () => {
    const forkBeforeLoad = manifest([currentSegment("forked-user")], 0);
    const snapshots = new Map([
      ["later-request", transcript("later-request", ["mcp_must_not_leak"])],
    ]);

    expect(historicalToolSnapshotRequestIds(forkBeforeLoad)).toEqual([]);
    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage: forkBeforeLoad,
        transcriptStore: store(snapshots),
      }),
    ).toEqual([]);
  });

  it("starts empty for a fresh lineage and a new thread", () => {
    const fresh: CorePrimaryLineageV2 = {
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "new-thread",
    };

    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage: fresh,
        transcriptStore: store(new Map()),
      }),
    ).toEqual([]);
    expect(resolveCorePrimaryLoadedCatalogIds({ transcriptStore: store(new Map()) })).toEqual([]);
  });

  it("inherits a compaction checkpoint snapshot after the original tool result is gone", () => {
    const lineage = manifest([checkpointSegment("checkpoint1"), currentSegment("after")], 1);
    const snapshots = new Map([
      ["checkpoint1", transcript("checkpoint1", ["mcp_loaded_before_compaction"])],
    ]);

    expect(historicalToolSnapshotRequestIds(lineage)).toEqual(["checkpoint1"]);
    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage,
        transcriptStore: store(snapshots),
      }),
    ).toEqual(["mcp_loaded_before_compaction"]);
  });

  it("walks back to the newest ancestor that has a tool snapshot", () => {
    const lineage = manifest(
      [requestSegment("older"), requestSegment("legacy"), currentSegment("current")],
      2,
    );
    const snapshots = new Map([
      ["older", transcript("older", ["mcp_known"])],
      ["legacy", transcript("legacy")],
    ]);

    expect(historicalToolSnapshotRequestIds(lineage)).toEqual(["legacy", "older"]);
    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage,
        transcriptStore: store(snapshots),
      }),
    ).toEqual(["mcp_known"]);
  });

  it("treats an explicit empty snapshot as authoritative", () => {
    const lineage = manifest(
      [requestSegment("older"), requestSegment("empty"), currentSegment("current")],
      2,
    );
    const snapshots = new Map([
      ["older", transcript("older", ["mcp_old"])],
      ["empty", transcript("empty", [])],
    ]);

    expect(
      resolveCorePrimaryLoadedCatalogIds({
        lineage,
        transcriptStore: store(snapshots),
      }),
    ).toEqual([]);
  });
});
