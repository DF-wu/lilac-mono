import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
} from "@stanley2058/lilac-utils";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import SuperJSON from "superjson";

import {
  decodeOpaqueSuperJsonValue,
  decodeGracefulRestartSnapshot,
  GRACEFUL_RESTART_SNAPSHOT_VERSION,
  GracefulRestartDispositionConflict,
  GracefulRestartSqliteFailure,
  gracefulRestartSnapshotCodecCases,
  OpaqueSuperJsonValueUnsupported,
  SqliteGracefulRestartStore,
  type GracefulRestartSnapshotInput,
} from "../../src/runtime/graceful-restart-store";
import {
  activateSurfaceRecovery,
  applySurfaceRecovery,
  createPausedSurfaceRecoveryOwnership,
  rollbackSurfaceRecovery,
  type SurfaceRecoveryPlan,
} from "../../src/runtime/surface-runtime-lifecycle";

const tempDirs: string[] = [];

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function buildCoreLineageManifestV2(...args: Parameters<typeof buildCoreLineageManifestResultV2>) {
  return resultValue(buildCoreLineageManifestResultV2(...args));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-graceful-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "graceful-restart.db");
  return { dbPath, store: new SqliteGracefulRestartStore(dbPath) };
}

function writePersistedRow(dbPath: string, status: string, payloadJson: string): void {
  const database = new Database(dbPath, { strict: true });
  try {
    database.run(
      `
      INSERT INTO graceful_restart_state (singleton_id, status, updated_ts, payload_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        status=excluded.status,
        updated_ts=excluded.updated_ts,
        payload_json=excluded.payload_json
      `,
      [1, status, Date.now(), payloadJson],
    );
  } finally {
    database.close();
  }
}

function buildSnapshot(
  overrides?: Partial<Pick<GracefulRestartSnapshotInput, "createdAt" | "deadlineMs">>,
): GracefulRestartSnapshotInput {
  const queuedMessage = {
    role: "user",
    content: "check this file",
  } satisfies StoredMessageV1;
  const lineage = buildCoreLineageManifestV2([
    {
      atoms: [
        {
          kind: "synthetic",
          source: "restart-test",
          messageDigest: "11".repeat(32),
        },
      ],
      canonicalMessages: [queuedMessage],
    },
  ]);
  return {
    version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
    createdAt: overrides?.createdAt ?? Date.now(),
    deadlineMs: overrides?.deadlineMs ?? 3_000,
    queueAttemptProof: "complete",
    agent: [
      {
        queueEntryId: "active-entry",
        kind: "active",
        requestId: "discord:chan:msg_active",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [],
        currentTurnUserId: "active-current-user",
        raw: { sessionMode: "active" },
        recovery: {
          checkpointMessages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "starting" }],
            },
          ],
          partialText: "starting",
        },
        identity: {
          state: "durable",
          projection: {
            requestId: "discord:chan:msg_active",
            requestClient: "discord",
            sessionId: "chan",
            source: "external",
            platform: "discord",
            sessionRef: { platform: "discord", channelId: "chan" },
            messageRef: { platform: "discord", channelId: "chan", messageId: "msg_active" },
            authenticatedOrigin: {
              platform: "discord",
              userId: "active-user",
              sessionRef: { platform: "discord", channelId: "chan" },
              messageRef: {
                platform: "discord",
                channelId: "chan",
                messageId: "msg_active",
              },
            },
            authenticationMetadataKind: "origin",
            verifiedIngress: true,
          },
          assertedSafetyMode: "trusted",
          parkedEventIds: [],
        },
      },
      {
        queueEntryId: "queued-entry",
        kind: "queued",
        requestId: "discord:chan:msg_queued",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [queuedMessage],
        corePrimaryLineage: lineage,
        currentTurnUserId: "queued-current-user",
        raw: { triggerType: "mention" },
        identity: {
          state: "durable",
          projection: {
            requestId: "discord:chan:msg_queued",
            requestClient: "discord",
            sessionId: "chan",
            source: "external",
            platform: "discord",
            sessionRef: { platform: "discord", channelId: "chan" },
            messageRef: { platform: "discord", channelId: "chan", messageId: "msg_queued" },
            authenticationMetadataKind: "absent",
            verifiedIngress: false,
          },
          assertedSafetyMode: "restricted",
          parkedEventIds: [],
        },
      },
    ],
    queueAttempts: [],
    relays: [
      {
        requestId: "discord:chan:msg_active",
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        routerSessionMode: "active",
        replyTo: {
          platform: "discord",
          channelId: "chan",
          messageId: "msg_active",
        },
        createdOutputRefs: [
          {
            platform: "discord",
            channelId: "chan",
            messageId: "out_1",
          },
        ],
        visibleText: "partial",
        toolStatus: [
          {
            toolCallId: "tool_1",
            status: "start",
            display: "bash ls",
          },
        ],
        outCursor: "123-0",
      },
    ],
  };
}

const SHIPPED_POPULATED_V1_FIXTURE = Object.freeze({
  version: 1,
  createdAt: 1_000,
  deadlineMs: 3_000,
  agent: Object.freeze([
    {
      kind: "queued" as const,
      requestId: "discord:legacy-channel:legacy-message",
      sessionId: "legacy-channel",
      requestClient: "discord" as const,
      queue: "prompt" as const,
      messages: Object.freeze([{ role: "user" as const, content: "legacy queued request" }]),
    },
  ]),
  relays: Object.freeze([
    {
      requestId: "discord:legacy-channel:legacy-message",
      sessionId: "legacy-channel",
      platform: "discord" as const,
      createdOutputRefs: Object.freeze([]),
      visibleText: "legacy partial response",
      toolStatus: Object.freeze([]),
    },
  ]),
});

const SHIPPED_POPULATED_V2_FIXTURE = Object.freeze({
  version: 2,
  createdAt: 2_000,
  deadlineMs: 3_000,
  agent: Object.freeze([
    {
      kind: "queued" as const,
      requestId: "discord:legacy-channel:legacy-message-v2",
      sessionId: "legacy-channel",
      requestClient: "discord" as const,
      queue: "prompt" as const,
      messages: Object.freeze([{ role: "user" as const, content: "legacy queued request v2" }]),
    },
  ]),
  relays: Object.freeze([
    {
      requestId: "discord:legacy-channel:legacy-message-v2",
      sessionId: "legacy-channel",
      platform: "discord" as const,
      createdOutputRefs: Object.freeze([]),
      visibleText: "legacy partial response v2",
      toolStatus: Object.freeze([]),
    },
  ]),
});

const SHIPPED_POPULATED_V3_FIXTURE = Object.freeze({
  version: 3,
  createdAt: 3_000,
  deadlineMs: 3_000,
  queueAttemptProof: "complete" as const,
  agent: Object.freeze([
    {
      queueEntryId: "v3-active-entry",
      kind: "active" as const,
      requestId: "discord:v3-channel:v3-message",
      sessionId: "v3-channel",
      requestClient: "discord" as const,
      queue: "prompt" as const,
      messages: Object.freeze([]),
      identity: {
        state: "durable" as const,
        projection: {
          requestId: "discord:v3-channel:v3-message",
          requestClient: "discord" as const,
          sessionId: "v3-channel",
          source: "external" as const,
          platform: "discord" as const,
          sessionRef: { platform: "discord" as const, channelId: "v3-channel" },
          messageRef: {
            platform: "discord" as const,
            channelId: "v3-channel",
            messageId: "v3-message",
          },
          authenticatedOrigin: {
            platform: "discord" as const,
            userId: "v3-initiator",
            sessionRef: { platform: "discord" as const, channelId: "v3-channel" },
            messageRef: {
              platform: "discord" as const,
              channelId: "v3-channel",
              messageId: "v3-message",
            },
          },
          authenticationMetadataKind: "origin" as const,
          verifiedIngress: true,
        },
        assertedSafetyMode: "trusted" as const,
        parkedEventIds: Object.freeze([]),
      },
    },
  ]),
  queueAttempts: Object.freeze([]),
  relays: Object.freeze([
    {
      requestId: "discord:v3-channel:v3-message",
      sessionId: "v3-channel",
      requestClient: "discord" as const,
      platform: "discord" as const,
      createdOutputRefs: Object.freeze([]),
      visibleText: "v3 partial response",
      toolStatus: Object.freeze([]),
    },
  ]),
});

function richOpaqueValue() {
  const date = new Date("2026-08-03T12:34:56.789Z");
  const url = new URL("https://example.com/path?opaque=yes#fragment");
  const expression = /restart\s+compatibility/giu;
  const nestedSet = new Set([date, url, 12345678901234567890n]);
  const nestedMap = new Map<unknown, unknown>([
    ["set", nestedSet],
    [url, new Map([[date, expression]])],
  ]);
  return {
    map: nestedMap,
    set: nestedSet,
    date,
    url,
    bigint: 12345678901234567890n,
    regexp: expression,
    specialNumbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
    nested: [{ map: new Map([["undefined", undefined]]) }, new Set([1n, 2n])],
  };
}

describe("graceful restart persisted codec", () => {
  it("roundtrips every supported rich opaque SuperJSON value exactly", () => {
    const opaque = richOpaqueValue();
    const decoded = decodeOpaqueSuperJsonValue(opaque);
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(isDeepStrictEqual(decoded.value, opaque)).toBeTrue();
      expect(isDeepStrictEqual(SuperJSON.parse(SuperJSON.stringify(opaque)), opaque)).toBeTrue();
    }
  });

  it("rejects unsupported and hostile opaque values without leaking content", () => {
    const secret = "SECRET_SENTINEL_DO_NOT_LOG";
    const throwing = Object.defineProperty({}, "hostile", {
      enumerable: true,
      get(): never {
        throw new Error(secret);
      },
    });
    class UnsupportedPrototype {
      readonly value = secret;
    }

    for (const value of [() => secret, Symbol(secret), throwing, new UnsupportedPrototype()]) {
      const decoded = decodeOpaqueSuperJsonValue(value);
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") {
        expect(decoded.error).toBeInstanceOf(OpaqueSuperJsonValueUnsupported);
        expect(decoded.error.message).not.toContain(secret);
        expect(JSON.stringify(decoded.error)).not.toContain(secret);
      }
    }
  });

  it("exports, executes, and classifies the complete six-case fixture catalog", () => {
    expect(Object.keys(gracefulRestartSnapshotCodecCases).sort()).toEqual([
      "corrupt-fields",
      "current",
      "legacy",
      "malformed-serialization",
      "missing-defaulted",
      "unsupported-version",
    ]);

    for (const [name, fixture] of Object.entries(gracefulRestartSnapshotCodecCases)) {
      const decoded = decodeGracefulRestartSnapshot(fixture.input);
      expect(decoded.status).toBe(fixture.outcome);
      if (decoded.status === "ok") {
        if (!("provenance" in fixture)) throw new Error(`Missing provenance for ${name}`);
        expect(decoded.value.provenance).toBe(fixture.provenance);
      } else {
        const expectedError = {
          "corrupt-fields": CorruptPersistedFields,
          legacy: UnsupportedVersion,
          "malformed-serialization": MalformedSerialization,
          "unsupported-version": UnsupportedVersion,
        }[name];
        if (!expectedError) throw new Error(`Missing error classification for ${name}`);
        expect(decoded.error).toBeInstanceOf(expectedError);
      }
    }
  });

  it("rejects the shipped v1 envelope and every unsupported version", () => {
    const legacy = decodeGracefulRestartSnapshot(gracefulRestartSnapshotCodecCases.legacy.input);
    expect(legacy.status).toBe("error");
    if (legacy.status === "error") expect(legacy.error).toBeInstanceOf(UnsupportedVersion);

    const unsupported = decodeGracefulRestartSnapshot(
      gracefulRestartSnapshotCodecCases["unsupported-version"].input,
    );
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error")
      expect(unsupported.error).toBeInstanceOf(UnsupportedVersion);
  });

  it.each([1, 2] as const)("rejects a populated legacy v%s snapshot", (version) => {
    const current = buildSnapshot();
    const {
      queueAttemptProof: _queueAttemptProof,
      queueAttempts: _queueAttempts,
      ...legacyBase
    } = current;
    const legacy = {
      ...legacyBase,
      version,
      agent: current.agent.map(
        ({
          identity: _identity,
          queueEntryId: _queueEntryId,
          currentTurnUserId: _currentTurnUserId,
          ...entry
        }) => entry,
      ),
      relays: current.relays.map(({ requestClient: _requestClient, ...relay }) => relay),
    };
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify(legacy),
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(UnsupportedVersion);
  });

  it.each([SHIPPED_POPULATED_V1_FIXTURE, SHIPPED_POPULATED_V2_FIXTURE])(
    "rejects frozen populated shipped v$version literals",
    (fixture) => {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(fixture),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(UnsupportedVersion);
    },
  );

  it.each([1, 2] as const)("rejects an active-only legacy v%s snapshot", (version) => {
    const current = buildSnapshot();
    const active = current.agent.find((entry) => entry.kind === "active");
    if (!active) throw new Error("Expected active fixture");
    const {
      identity: _identity,
      queueEntryId: _queueEntryId,
      currentTurnUserId: _currentTurnUserId,
      ...legacyActive
    } = active;
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify({
        version,
        createdAt: current.createdAt,
        deadlineMs: current.deadlineMs,
        agent: [legacyActive],
        relays: current.relays.map(({ requestClient: _requestClient, ...relay }) => relay),
      }),
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(UnsupportedVersion);
  });

  it("rejects missing current relay clients and explicit current disagreement", () => {
    const current = buildSnapshot();
    const missing = {
      ...current,
      relays: current.relays.map(({ requestClient: _requestClient, ...relay }) => relay),
    };
    const currentMismatch = {
      ...current,
      relays: current.relays.map((relay) => ({ ...relay, requestClient: "github" })),
    };
    for (const value of [missing, currentMismatch]) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(value),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("rejects corrupt nested relay refs across platform and active session", () => {
    const current = buildSnapshot();
    const wrongPlatform = {
      ...current,
      relays: current.relays.map((relay) => ({
        ...relay,
        createdOutputRefs: [
          { platform: "github", channelId: relay.sessionId, messageId: "wrong-platform" },
        ],
      })),
    };
    const wrongSession = {
      ...current,
      relays: current.relays.map((relay) => ({
        ...relay,
        activeOutputRefs: [
          { platform: relay.platform, channelId: "other-session", messageId: "wrong-session" },
        ],
      })),
    };
    for (const value of [wrongPlatform, wrongSession]) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(value),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("rejects semantically corrupt Core primary lineage with the canonical decoder", () => {
    const snapshot = buildSnapshot();
    const queued = snapshot.agent[1];
    const lineage = queued?.corePrimaryLineage;
    if (!queued || lineage?.state !== "complete")
      throw new Error("Expected complete lineage fixture");
    const segment = lineage.segments[0];
    if (!segment) throw new Error("Expected lineage segment");
    const corruptLineages = [
      { ...lineage, segments: [] },
      { ...lineage, segments: [{ ...segment, canonicalEnd: segment.canonicalEnd + 1 }] },
      {
        ...lineage,
        segments: [{ ...segment, cumulativeAtomCount: segment.cumulativeAtomCount + 1 }],
      },
      {
        ...lineage,
        segments: [{ ...segment, cumulativePrefixDigest: "00".repeat(32) }],
      },
      {
        ...lineage,
        segments: [
          {
            ...segment,
            requestSource: {
              aliases: [
                {
                  requestClient: "discord",
                  surfaceId: "discord",
                  sessionId: "chan",
                  messageId: "duplicate",
                },
                {
                  requestClient: "discord",
                  surfaceId: "discord",
                  sessionId: "chan",
                  messageId: "duplicate",
                },
              ],
            },
          },
        ],
      },
    ];
    for (const corePrimaryLineage of corruptLineages) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({
          ...snapshot,
          agent: snapshot.agent.map((entry) =>
            entry.queueEntryId === queued.queueEntryId ? { ...entry, corePrimaryLineage } : entry,
          ),
        }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it.each([
    ["queued-cancellation", true, 1],
    ["buffered-absorption", true, 2],
    ["buffered-absorption", false, 0],
  ] as const)(
    "decodes parked %s state with controlApplied=%s and remaining publication group %s",
    (kind, controlApplied, groupIndex) => {
      const snapshot = buildSnapshot();
      const active = snapshot.agent[0];
      const queued = snapshot.agent[1];
      if (!active || !queued?.queueEntryId) throw new Error("Expected active and queued fixtures");
      const eventId = `pel-${kind}-${controlApplied}-${groupIndex}`;
      const controlRequestId = "discord:chan:control";
      const value = {
        ...snapshot,
        agent: [
          active,
          kind === "buffered-absorption"
            ? {
                ...queued,
                raw: { bufferedForActiveRequestId: controlRequestId },
              }
            : queued,
        ],
        queueAttempts: [
          {
            eventId,
            controlRequestId,
            controlRequestClient: "discord",
            sessionId: queued.sessionId,
            kind,
            detail: "cancelled during replacement",
            controlApplied,
            controlIdentity: {
              state: "durable",
              projection: {
                requestId: controlRequestId,
                requestClient: "discord",
                sessionId: queued.sessionId,
                source: "external",
                platform: "discord",
                sessionRef: { platform: "discord", channelId: queued.sessionId },
                messageRef: {
                  platform: "discord",
                  channelId: queued.sessionId,
                  messageId: "control",
                },
                authenticationMetadataKind: "absent",
                verifiedIngress: false,
              },
              assertedSafetyMode: "restricted",
              parkedEventIds: [eventId],
            },
            pendingGroups: [
              {
                publicationIndex: groupIndex,
                requestId: queued.requestId,
                requestClient: queued.requestClient,
                targetQueueEntryIds: [queued.queueEntryId],
              },
            ],
          },
        ],
      };
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(value),
      });
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") {
        expect(decoded.value.value?.queueAttempts[0]).toMatchObject({
          kind,
          controlApplied,
          pendingGroups: [{ publicationIndex: groupIndex }],
        });
      }
    },
  );

  it("rejects globally duplicated queue-attempt event IDs", () => {
    const snapshot = buildSnapshot();
    const queued = snapshot.agent.find((entry) => entry.kind === "queued");
    if (!queued) throw new Error("Expected queued fixture");
    const eventId = "pel-duplicate";
    const controlRequestId = "discord:chan:control";
    const controlIdentity = {
      state: "durable" as const,
      projection: {
        requestId: controlRequestId,
        requestClient: "discord" as const,
        sessionId: "chan",
        source: "external" as const,
        platform: "discord" as const,
        sessionRef: { platform: "discord" as const, channelId: "chan" },
        messageRef: { platform: "discord" as const, channelId: "chan", messageId: "control" },
        authenticationMetadataKind: "absent" as const,
        verifiedIngress: false,
      },
      assertedSafetyMode: "restricted" as const,
      parkedEventIds: [eventId],
    };
    const attempt = {
      eventId,
      controlRequestId,
      controlRequestClient: "discord" as const,
      sessionId: "chan",
      kind: "queued-cancellation" as const,
      detail: "cancelled",
      controlApplied: true,
      controlIdentity,
      pendingGroups: [
        {
          publicationIndex: 0,
          requestId: queued.requestId,
          requestClient: queued.requestClient,
          targetQueueEntryIds: [queued.queueEntryId],
        },
      ],
    };
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify({
        ...snapshot,
        queueAttempts: [attempt, { ...attempt, controlRequestId: `${controlRequestId}:other` }],
      }),
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
  });

  it("rejects conflicting request routes and invalid per-session queue ordering", () => {
    const snapshot = buildSnapshot();
    const active = snapshot.agent.find((entry) => entry.kind === "active");
    const queued = snapshot.agent.find((entry) => entry.kind === "queued");
    if (!active || !queued) throw new Error("Expected queue topology fixtures");
    const corruptAgentLists = [
      [queued, active],
      [active, { ...active, queueEntryId: "second-active", requestId: "discord:chan:second" }],
      [
        active,
        queued,
        {
          ...queued,
          queueEntryId: "conflicting-route",
          sessionId: "other-session",
        },
      ],
    ];
    for (const agent of corruptAgentLists) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({ ...snapshot, agent }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("decodes authenticated and verified identity and an internal delegated unknown-client identity", () => {
    const snapshot = buildSnapshot();
    const githubRequestId = "github:octo/repo#1:123";
    const githubSessionId = "octo/repo#1";
    const github = {
      queueEntryId: "github-entry",
      kind: "queued" as const,
      requestId: githubRequestId,
      sessionId: githubSessionId,
      requestClient: "github" as const,
      queue: "prompt" as const,
      messages: [],
      identity: {
        state: "durable" as const,
        projection: {
          requestId: githubRequestId,
          requestClient: "github" as const,
          sessionId: githubSessionId,
          source: "external" as const,
          platform: "github" as const,
          sessionRef: { platform: "github" as const, channelId: githubSessionId },
          messageRef: { platform: "github" as const, channelId: githubSessionId, messageId: "123" },
          authenticatedOrigin: {
            platform: "github" as const,
            userId: "github-user",
            sessionRef: { platform: "github" as const, channelId: githubSessionId },
            messageRef: {
              platform: "github" as const,
              channelId: githubSessionId,
              messageId: "123",
            },
          },
          authenticationMetadataKind: "origin-github-trigger" as const,
          githubTrigger: {
            kind: "comment" as const,
            targetKind: "issue" as const,
            repoFullName: "octo/repo",
            issueNumber: 1,
            messageId: "123",
          },
          verifiedIngress: true,
        },
        assertedSafetyMode: "trusted" as const,
        parkedEventIds: [],
      },
    };
    const delegatedRequestId = "wfr:run:operation:1";
    const delegatedSessionId = "workflow:run";
    const delegated = {
      queueEntryId: "delegated-entry",
      kind: "queued" as const,
      requestId: delegatedRequestId,
      sessionId: delegatedSessionId,
      requestClient: "unknown" as const,
      queue: "prompt" as const,
      messages: [],
      identity: {
        state: "durable" as const,
        projection: {
          requestId: delegatedRequestId,
          requestClient: "unknown" as const,
          sessionId: delegatedSessionId,
          source: "internal-delegated" as const,
          authenticatedOrigin: {
            platform: "github" as const,
            userId: "workflow-user",
            sessionRef: { platform: "github" as const, channelId: "octo/repo#1" },
          },
          authenticationMetadataKind: "origin" as const,
          verifiedIngress: false,
        },
        assertedSafetyMode: "restricted" as const,
        parkedEventIds: [],
        delegationProof: {
          kind: "workflow" as const,
          runId: "run",
          operationId: "operation",
          dispatchEpoch: "dispatch-epoch-0001",
        },
      },
    };
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify({
        ...snapshot,
        agent: [...snapshot.agent, github, delegated],
      }),
    });
    expect(decoded.status).toBe("ok");
    if (decoded.status !== "ok" || !decoded.value.value) return;
    expect(decoded.value.value.agent[0]?.identity).toMatchObject({
      state: "durable",
      assertedSafetyMode: "trusted",
    });
    expect(decoded.value.value.agent[2]?.identity).toMatchObject({
      state: "durable",
      assertedSafetyMode: "trusted",
      projection: { requestClient: "github", verifiedIngress: true },
    });
    expect(decoded.value.value.agent[3]?.identity).toMatchObject({
      state: "durable",
      projection: { source: "internal-delegated", requestClient: "unknown" },
    });
  });

  it("rejects missing, misplaced, and impossible trusted workflow delegation proofs", () => {
    const snapshot = buildSnapshot();
    const delegated = {
      queueEntryId: "delegated-entry",
      kind: "queued" as const,
      requestId: "wfr:run:operation:1",
      sessionId: "workflow:run",
      requestClient: "unknown" as const,
      queue: "prompt" as const,
      messages: [],
      identity: {
        state: "durable" as const,
        projection: {
          requestId: "wfr:run:operation:1",
          requestClient: "unknown" as const,
          sessionId: "workflow:run",
          source: "internal-delegated" as const,
          authenticationMetadataKind: "absent" as const,
          verifiedIngress: false,
        },
        assertedSafetyMode: "restricted" as const,
        parkedEventIds: [],
        delegationProof: {
          kind: "workflow" as const,
          runId: "run",
          operationId: "operation",
          dispatchEpoch: "dispatch-epoch-0001",
        },
      },
    };
    const external = snapshot.agent[0];
    if (!external?.identity || external.identity.state !== "durable") {
      throw new Error("Expected durable external identity fixture");
    }
    const externalIdentity = external.identity;
    const corruptEntries = [
      { ...delegated, identity: { ...delegated.identity, delegationProof: undefined } },
      {
        ...delegated,
        identity: { ...delegated.identity, assertedSafetyMode: "trusted" as const },
      },
      {
        ...external,
        identity: {
          ...externalIdentity,
          delegationProof: delegated.identity.delegationProof,
        },
      },
    ];

    for (const entry of corruptEntries) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({ ...snapshot, agent: [entry] }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("rejects verified GitHub identity combinations without correlated trigger evidence", () => {
    const snapshot = buildSnapshot();
    const requestId = "github:octo/repo#1:123";
    const github = {
      queueEntryId: "github-entry",
      kind: "queued" as const,
      requestId,
      sessionId: "octo/repo#1",
      requestClient: "github" as const,
      queue: "prompt" as const,
      messages: [],
      identity: {
        state: "durable" as const,
        projection: {
          requestId,
          requestClient: "github" as const,
          sessionId: "octo/repo#1",
          source: "external" as const,
          platform: "github" as const,
          sessionRef: { platform: "github" as const, channelId: "octo/repo#1" },
          messageRef: {
            platform: "github" as const,
            channelId: "octo/repo#1",
            messageId: "123",
          },
          authenticationMetadataKind: "github-trigger" as const,
          githubTrigger: {
            kind: "comment" as const,
            targetKind: "issue" as const,
            repoFullName: "other/repo",
            issueNumber: 1,
            messageId: "123",
          },
          verifiedIngress: true,
        },
        assertedSafetyMode: "trusted" as const,
        parkedEventIds: [],
      },
    };
    const corruptProjections = [
      { ...github.identity.projection, githubTrigger: undefined },
      {
        ...github.identity.projection,
        authenticationMetadataKind: "absent" as const,
      },
      {
        ...github.identity.projection,
        githubTrigger: { ...github.identity.projection.githubTrigger, messageId: "other" },
      },
      github.identity.projection,
    ];

    for (const projection of corruptProjections) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({
          ...snapshot,
          agent: [{ ...github, identity: { ...github.identity, projection } }],
        }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("rejects Discord authentication kinds without their exact decoded evidence", () => {
    const snapshot = buildSnapshot();
    const active = snapshot.agent[0];
    if (!active?.identity || active.identity.state !== "durable") {
      throw new Error("Expected durable Discord identity fixture");
    }
    const identity = active.identity;
    const projection = identity.projection;
    const corruptProjections = [
      { ...projection, authenticationMetadataKind: "absent" as const },
      { ...projection, authenticationMetadataKind: "actor-origin" as const },
      {
        ...projection,
        authenticatedActor: {
          platform: "discord" as const,
          userId: "different-user",
        },
        authenticationMetadataKind: "actor-origin" as const,
      },
    ];
    for (const corruptProjection of corruptProjections) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({
          ...snapshot,
          agent: [
            {
              ...active,
              identity: { ...identity, projection: corruptProjection },
            },
          ],
        }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    }
  });

  it("accepts exact v4 Discord initial message proof", () => {
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify(buildSnapshot()),
    });
    expect(decoded.status).toBe("ok");
    if (decoded.status === "error") throw decoded.error;
    expect(decoded.value.provenance).toBe("current");
    expect(decoded.value.value?.agent[0]?.identity).toMatchObject({
      state: "durable",
      projection: {
        requestId: "discord:chan:msg_active",
        messageRef: { platform: "discord", channelId: "chan", messageId: "msg_active" },
        authenticatedOrigin: {
          messageRef: { platform: "discord", channelId: "chan", messageId: "msg_active" },
        },
      },
    });
  });

  it("rejects frozen v3 entries at the runtime boundary", () => {
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify(SHIPPED_POPULATED_V3_FIXTURE),
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(UnsupportedVersion);
  });

  it("strictly rejects empty v5 currentTurnUserId and a legacy v3 envelope", () => {
    const snapshot = buildSnapshot();
    const active = snapshot.agent[0];
    if (!active) throw new Error("Expected active fixture");
    const invalidValues = [
      { ...snapshot, agent: [{ ...active, currentTurnUserId: "" }] },
      { ...snapshot, version: 3 },
    ];
    for (const value of invalidValues) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(value),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") {
        expect(decoded.error).toBeInstanceOf(
          value.version === 3 ? UnsupportedVersion : CorruptPersistedFields,
        );
      }
    }
  });

  it("encodes a durable restricted alias projection without message proof", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    const active = snapshot.agent[0];
    if (!active?.identity || active.identity.state !== "durable") {
      throw new Error("Expected durable Discord identity fixture");
    }
    const requestId = "discord:chan:model-alias";
    const sessionRef = { platform: "discord" as const, channelId: "chan" };
    const aliasSnapshot: GracefulRestartSnapshotInput = {
      ...snapshot,
      relays: [],
      agent: [
        {
          ...active,
          requestId,
          identity: {
            ...active.identity,
            projection: {
              requestId,
              requestClient: "discord",
              sessionId: "chan",
              source: "external",
              platform: "discord",
              sessionRef,
              authenticatedActor: { platform: "discord", userId: "user_active" },
              authenticatedOrigin: { platform: "discord", userId: "user_active", sessionRef },
              authenticationMetadataKind: "actor",
              verifiedIngress: false,
            },
            assertedSafetyMode: "restricted",
          },
        },
      ],
    };
    try {
      expect(store.saveCompletedSnapshot(aliasSnapshot).status).toBe("ok");
      const loaded = store.readCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status === "error" || loaded.value.state !== "loaded") return;
      expect(loaded.value.snapshot.agent[0]?.identity).toMatchObject({
        state: "durable",
        assertedSafetyMode: "restricted",
        projection: {
          requestId,
          authenticationMetadataKind: "actor",
          verifiedIngress: false,
        },
      });
    } finally {
      store.close();
    }
  });

  it.each([
    ["requestId and messageRef", "outer"],
    ["messageRef and nested authenticatedOrigin", "nested"],
  ] as const)(
    "rejects v4 Discord %s mismatches as corrupt persisted fields",
    (_label, mismatch) => {
      const snapshot = buildSnapshot();
      const active = snapshot.agent[0];
      if (!active?.identity || active.identity.state !== "durable") {
        throw new Error("Expected durable Discord identity fixture");
      }
      const projection = active.identity.projection;
      const wrongMessageRef = {
        platform: "discord" as const,
        channelId: "chan",
        messageId: "follow-up",
      };
      const authenticatedOrigin = projection.authenticatedOrigin
        ? { ...projection.authenticatedOrigin, messageRef: wrongMessageRef }
        : undefined;
      const corruptProjection = {
        ...projection,
        ...(mismatch === "outer" ? { messageRef: wrongMessageRef } : {}),
        authenticatedOrigin,
      };
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify({
          ...snapshot,
          agent: [
            {
              ...active,
              identity: { ...active.identity, projection: corruptProjection },
            },
          ],
        }),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
    },
  );

  it("rejects v4 GitHub durable trigger evidence that does not match its parsed request ID", () => {
    const snapshot = buildSnapshot();
    const sessionId = "octo/repo#1";
    const requestId = "github:octo/repo#1:999";
    const github = {
      queueEntryId: "github-incomplete-trigger",
      kind: "queued" as const,
      requestId,
      sessionId,
      requestClient: "github" as const,
      queue: "prompt" as const,
      messages: [],
      identity: {
        state: "durable" as const,
        projection: {
          requestId,
          requestClient: "github" as const,
          sessionId,
          source: "external" as const,
          platform: "github" as const,
          sessionRef: { platform: "github" as const, channelId: sessionId },
          messageRef: { platform: "github" as const, channelId: sessionId, messageId: "123" },
          authenticationMetadataKind: "github-trigger" as const,
          githubTrigger: { kind: "comment" as const, messageId: "123" },
          verifiedIngress: false,
        },
        assertedSafetyMode: "restricted" as const,
        parkedEventIds: [],
      },
    };
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: SuperJSON.stringify({ ...snapshot, agent: [github] }),
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
  });

  it("does not include persisted content in corruption diagnostics", () => {
    const secret = "SECRET_SENTINEL_DO_NOT_LOG";
    const decoded = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: `{"version":2,"agent":["${secret}"]}`,
    });
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error.message).not.toContain(secret);
      expect(JSON.stringify(decoded.error)).not.toContain(secret);
    }
  });

  it("rejects unrecognized nested and relay-envelope fields", () => {
    const snapshot = buildSnapshot();
    const nestedAgent = {
      ...snapshot,
      agent: snapshot.agent.map((entry, index) =>
        index === 0 ? { ...entry, silentlyTrusted: true } : entry,
      ),
    };
    const nestedRelay = {
      ...snapshot,
      relays: snapshot.relays.map((relay) => ({
        ...relay,
        toolStatus: relay.toolStatus.map((status) => ({ ...status, silentlyTrusted: true })),
      })),
    };
    const changedRelayEnvelope = {
      ...snapshot,
      relays: snapshot.relays.map((relay) => ({
        ...relay,
        streamHasTerminalOutput: true,
      })),
    };

    for (const value of [nestedAgent, nestedRelay, changedRelayEnvelope]) {
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(value),
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") {
        expect(decoded.error).toBeInstanceOf(CorruptPersistedFields);
      }
    }
  });
});

describe("SqliteGracefulRestartStore", () => {
  it("stops startup on legacy state with the exact offline command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lilac-graceful-legacy-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "graceful-restart.db");
    const database = new Database(dbPath, { strict: true });
    database.run(`
      CREATE TABLE graceful_restart_state (
        singleton_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    database.run("INSERT INTO graceful_restart_state VALUES (?, ?, ?, ?)", [
      1,
      "completed",
      1,
      SuperJSON.stringify(SHIPPED_POPULATED_V3_FIXTURE),
    ]);
    database.close();

    expect(() => new SqliteGracefulRestartStore(dbPath)).toThrow(
      "Graceful restart state requires offline blob migration. Run: bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data",
    );
  });

  it("preserves rich opaque raw values in a current snapshot", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    const opaque = richOpaqueValue();
    const first = snapshot.agent[0];
    if (!first) throw new Error("Expected an agent fixture");
    try {
      const richSnapshot = {
        ...snapshot,
        agent: [{ ...first, raw: opaque }, ...snapshot.agent.slice(1)],
      };
      const decoded = decodeGracefulRestartSnapshot({
        status: "completed",
        payload_json: SuperJSON.stringify(richSnapshot),
      });
      if (decoded.status === "error") throw new Error(`decode:${decoded.error._tag}`);
      const saved = store.saveCompletedSnapshot(richSnapshot);
      expect(saved.status).toBe("ok");

      const loaded = store.readCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok" || loaded.value.state !== "loaded") {
        throw new Error("Expected a loaded current snapshot");
      }
      expect(isDeepStrictEqual(loaded.value.snapshot.agent[0]?.raw, opaque)).toBeTrue();
    } finally {
      store.close();
    }
  });

  it("rejects managed bytes nested in current opaque raw state", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    const first = snapshot.agent[0];
    if (!first) throw new Error("Expected an agent fixture");
    try {
      const byteSnapshot = {
        ...snapshot,
        agent: [
          { ...first, raw: { nested: new Uint8Array([1, 2, 3]) } },
          ...snapshot.agent.slice(1),
        ],
      };
      expect(
        decodeGracefulRestartSnapshot({
          status: "completed",
          payload_json: SuperJSON.stringify(byteSnapshot),
        }).status,
      ).toBe("error");
      expect(store.saveCompletedSnapshot(byteSnapshot).status).toBe("error");
    } finally {
      store.close();
    }
  });

  it("roundtrips retained request-delivery terminal outcomes", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    const first = snapshot.agent[0];
    if (!first) throw new Error("Expected an agent fixture");
    try {
      const retained = {
        ...snapshot,
        agent: [
          {
            ...first,
            retainedRequestDeliveries: [
              {
                requestDeliveryId: "b258d276-bca4-4a82-bf7d-b0ea7a14f584",
                outcome: { kind: "upload-failed" as const, code: "integrity" },
              },
            ],
          },
          ...snapshot.agent.slice(1),
        ],
      };
      expect(store.saveCompletedSnapshot(retained).status).toBe("ok");
      const loaded = store.readCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok" && loaded.value.state === "loaded") {
        expect(loaded.value.snapshot.agent[0]?.retainedRequestDeliveries).toEqual(
          retained.agent[0]?.retainedRequestDeliveries,
        );
      }
    } finally {
      store.close();
    }
  });

  it("saves and consumes a fully validated completed snapshot", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    try {
      expect(store.saveCompletedSnapshot(snapshot).status).toBe("ok");

      const loaded = store.readCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok" || loaded.value.state !== "loaded") {
        throw new Error("Expected a loaded graceful restart snapshot");
      }
      expect(loaded.value.provenance).toBe("current");
      expect(loaded.value.snapshot.agent).toHaveLength(2);
      expect(loaded.value.snapshot.relays).toHaveLength(1);
      expect(
        loaded.value.snapshot.agent.map((entry) => [entry.kind, entry.currentTurnUserId]),
      ).toEqual([
        ["active", "active-current-user"],
        ["queued", "queued-current-user"],
      ]);

      const queued = loaded.value.snapshot.agent.find((entry) => entry.kind === "queued");
      expect(JSON.stringify(queued?.corePrimaryLineage)).toBe(
        JSON.stringify(snapshot.agent.find((entry) => entry.kind === "queued")?.corePrimaryLineage),
      );
      const queuedMessage = queued?.messages[0];
      expect(queuedMessage).toEqual({ role: "user", content: "check this file" });

      expect(store.consumeCompletedSnapshot(loaded.value.rowToken).status).toBe("ok");
      const secondLoad = store.readCompletedSnapshot();
      expect(secondLoad.status).toBe("ok");
      if (secondLoad.status === "ok") {
        expect(secondLoad.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("distinguishes a valid empty snapshot from an absent row", async () => {
    const { store } = await makeStore();
    try {
      const snapshot = buildSnapshot();
      expect(store.saveCompletedSnapshot({ ...snapshot, agent: [], relays: [] }).status).toBe("ok");
      const empty = store.readCompletedSnapshot();
      expect(empty.status).toBe("ok");
      if (empty.status !== "ok" || empty.value.state !== "empty") {
        throw new Error("Expected empty snapshot");
      }
      expect(empty.value).toMatchObject({ state: "empty", provenance: "current" });

      expect(store.consumeCompletedSnapshot(empty.value.rowToken).status).toBe("ok");
      const absent = store.readCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") {
        expect(absent.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("returns stale metadata and consumes an expired snapshot", async () => {
    const { store } = await makeStore();
    const createdAt = 1_000;
    const deadlineMs = 500;
    try {
      expect(store.saveCompletedSnapshot(buildSnapshot({ createdAt, deadlineMs })).status).toBe(
        "ok",
      );
      const stale = store.readCompletedSnapshot(2_000);
      expect(stale.status).toBe("ok");
      if (stale.status !== "ok" || stale.value.state !== "stale") {
        throw new Error("Expected stale snapshot");
      }
      expect(stale.value).toMatchObject({
        state: "stale",
        createdAt,
        deadlineMs,
        ageMs: 1_000,
        provenance: "current",
      });
      expect(store.consumeCompletedSnapshot(stale.value.rowToken).status).toBe("ok");
      const absent = store.readCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") {
        expect(absent.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("retains malformed data for operator repair", async () => {
    const { dbPath, store } = await makeStore();
    try {
      writePersistedRow(dbPath, "completed", "{");

      const first = store.readCompletedSnapshot();
      expect(first.status).toBe("error");
      if (first.status === "error") expect(first.error).toBeInstanceOf(MalformedSerialization);

      const second = store.readCompletedSnapshot();
      expect(second.status).toBe("error");
      if (second.status === "error") expect(second.error).toBeInstanceOf(MalformedSerialization);
    } finally {
      store.close();
    }
  });

  it("retains v4 Discord durable message-proof corruption for operator repair", async () => {
    const { dbPath, store } = await makeStore();
    try {
      const snapshot = buildSnapshot();
      const active = snapshot.agent[0];
      if (!active?.identity || active.identity.state !== "durable") {
        throw new Error("Expected durable Discord identity fixture");
      }
      const projection = active.identity.projection;
      const wrongMessageRef = {
        platform: "discord" as const,
        channelId: "chan",
        messageId: "follow-up",
      };
      writePersistedRow(
        dbPath,
        "completed",
        SuperJSON.stringify({
          ...snapshot,
          agent: [
            {
              ...active,
              identity: {
                ...active.identity,
                projection: {
                  ...projection,
                  messageRef: wrongMessageRef,
                  authenticatedOrigin: projection.authenticatedOrigin
                    ? { ...projection.authenticatedOrigin, messageRef: wrongMessageRef }
                    : undefined,
                },
              },
            },
          ],
        }),
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const read = store.readCompletedSnapshot();
        expect(read.status).toBe("error");
        if (read.status === "error") expect(read.error).toBeInstanceOf(CorruptPersistedFields);
      }
    } finally {
      store.close();
    }
  });

  it("retains unsupported versions for operator repair", async () => {
    const { dbPath, store } = await makeStore();
    try {
      const fixture = gracefulRestartSnapshotCodecCases["unsupported-version"].input;
      writePersistedRow(dbPath, fixture.status, fixture.payload_json);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const read = store.readCompletedSnapshot();
        expect(read.status).toBe("error");
        if (read.status === "error") expect(read.error).toBeInstanceOf(UnsupportedVersion);
      }
    } finally {
      store.close();
    }
  });

  it("returns invalid status and nested payload corruption as typed retained errors", async () => {
    const { dbPath, store } = await makeStore();
    try {
      writePersistedRow(dbPath, "pending", "{}");
      const invalidStatus = store.readCompletedSnapshot();
      expect(invalidStatus.status).toBe("error");
      if (invalidStatus.status === "error") {
        expect(invalidStatus.error).toBeInstanceOf(CorruptPersistedFields);
      }

      const fixture = gracefulRestartSnapshotCodecCases["corrupt-fields"].input;
      writePersistedRow(dbPath, fixture.status, fixture.payload_json);
      const corrupt = store.readCompletedSnapshot();
      expect(corrupt.status).toBe("error");
      if (corrupt.status === "error") expect(corrupt.error).toBeInstanceOf(CorruptPersistedFields);
    } finally {
      store.close();
    }
  });

  it("clear returns a Result and removes a pending snapshot", async () => {
    const { store } = await makeStore();
    try {
      expect(store.saveCompletedSnapshot(buildSnapshot()).status).toBe("ok");
      expect(store.clear().status).toBe("ok");
      const absent = store.readCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") {
        expect(absent.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("maps recognized save failures to an owned SQLite error", async () => {
    const { dbPath, store } = await makeStore();
    const database = new Database(dbPath, { strict: true });
    try {
      database.run(`
        CREATE TRIGGER reject_graceful_restart_save
        BEFORE INSERT ON graceful_restart_state
        BEGIN
          SELECT RAISE(ABORT, 'reject graceful restart save');
        END;
      `);
      const saved = store.saveCompletedSnapshot(buildSnapshot());
      expect(saved.status).toBe("error");
      if (saved.status === "error") {
        expect(saved.error).toBeInstanceOf(GracefulRestartSqliteFailure);
      }
    } finally {
      database.close();
      store.close();
    }
  });

  it("returns a SQLite read failure without performing a disposition write", async () => {
    const { dbPath, store } = await makeStore();
    const snapshot = buildSnapshot();
    expect(store.saveCompletedSnapshot(snapshot).status).toBe("ok");
    const database = new Database(dbPath, { strict: true });
    try {
      database.run("BEGIN EXCLUSIVE");
      const read = store.readCompletedSnapshot();
      expect(read.status).toBe("error");
      if (read.status === "error") {
        expect(read.error).toBeInstanceOf(GracefulRestartSqliteFailure);
        if (read.error instanceof GracefulRestartSqliteFailure) {
          expect(read.error.operation).toBe("read");
        }
      }
      database.run("ROLLBACK");
      const retained = store.readCompletedSnapshot();
      expect(retained.status).toBe("ok");
      if (retained.status === "ok") expect(retained.value.state).toBe("loaded");
    } finally {
      if (database.inTransaction) database.run("ROLLBACK");
      database.close();
      store.close();
    }
  });

  it("rejects nested raw values that serialization would silently discard", async () => {
    const { store } = await makeStore();
    try {
      const snapshot = buildSnapshot();
      const first = snapshot.agent[0];
      if (!first) throw new Error("Expected an agent fixture");
      const saved = store.saveCompletedSnapshot({
        ...snapshot,
        agent: [
          {
            ...first,
            raw: { unsupported: () => "SECRET_SENTINEL_DO_NOT_PERSIST" },
          },
          ...snapshot.agent.slice(1),
        ],
      });
      expect(saved.status).toBe("error");
      if (saved.status === "error") expect(saved.error).toBeInstanceOf(CorruptPersistedFields);

      const absent = store.readCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") expect(absent.value.state).toBe("absent");
    } finally {
      store.close();
    }
  });

  it("keeps a decoded row when explicit consumption hits a recognized driver failure", async () => {
    const { dbPath, store } = await makeStore();
    const fixture = gracefulRestartSnapshotCodecCases.current.input;
    writePersistedRow(dbPath, fixture.status, fixture.payload_json);
    const database = new Database(dbPath, { strict: true });
    try {
      database.run(`
        CREATE TRIGGER reject_graceful_restart_consume
        BEFORE DELETE ON graceful_restart_state
        BEGIN
          SELECT RAISE(ABORT, 'reject graceful restart consume');
        END;
      `);
      const read = store.readCompletedSnapshot(1);
      if (read.status !== "ok" || read.value.state !== "empty") {
        throw new Error("Expected empty snapshot before disposition failure");
      }
      const failed = store.consumeCompletedSnapshot(read.value.rowToken);
      expect(failed.status).toBe("error");
      if (failed.status === "error") {
        expect(failed.error).toBeInstanceOf(GracefulRestartSqliteFailure);
      }

      database.run("DROP TRIGGER reject_graceful_restart_consume");
      const retained = store.readCompletedSnapshot(1);
      expect(retained.status).toBe("ok");
      if (retained.status === "ok") expect(retained.value.state).toBe("empty");
    } finally {
      database.close();
      store.close();
    }
  });

  it("compare-and-delete retains a replacement written after the classified read", async () => {
    const { store } = await makeStore();
    try {
      const first = buildSnapshot({ createdAt: 1_000 });
      const replacement = buildSnapshot({ createdAt: 2_000 });
      expect(store.saveCompletedSnapshot(first).status).toBe("ok");
      const read = store.readCompletedSnapshot(1_000);
      if (read.status !== "ok" || read.value.state !== "loaded") {
        throw new Error("Expected first loaded snapshot");
      }
      expect(store.saveCompletedSnapshot(replacement).status).toBe("ok");

      const conflicted = store.consumeCompletedSnapshot(read.value.rowToken);
      expect(conflicted.status).toBe("error");
      if (conflicted.status === "error") {
        expect(conflicted.error).toBeInstanceOf(GracefulRestartDispositionConflict);
      }
      const retained = store.readCompletedSnapshot(2_000);
      if (retained.status !== "ok" || retained.value.state !== "loaded") {
        throw new Error("Expected replacement snapshot to remain");
      }
      expect(retained.value.snapshot.createdAt).toBe(2_000);
    } finally {
      store.close();
    }
  });

  it("rolls back paused admission on disposition conflict and activates only the second process", async () => {
    const { store } = await makeStore();
    let pausedAdmissions = 0;
    let agentEffects = 0;
    const plan = (snapshot: GracefulRestartSnapshotInput): SurfaceRecoveryPlan => ({
      snapshot,
      attempts: [],
      agentAttempt: {
        apply: () => {
          pausedAdmissions += 1;
          return Result.ok(undefined);
        },
        rollback: () => {
          pausedAdmissions -= 1;
        },
        activate: () => {
          agentEffects += 1;
        },
      },
    });
    try {
      const firstSnapshot = buildSnapshot({ createdAt: 1_000 });
      const secondSnapshot = buildSnapshot({ createdAt: 2_000 });
      expect(store.saveCompletedSnapshot(firstSnapshot).status).toBe("ok");
      const firstRead = store.readCompletedSnapshot(1_000);
      if (firstRead.status !== "ok" || firstRead.value.state !== "loaded") {
        throw new Error("Expected first process snapshot");
      }
      const firstPlan = plan(firstSnapshot);
      expect((await applySurfaceRecovery(firstPlan)).status).toBe("ok");
      expect(pausedAdmissions).toBe(1);
      expect(agentEffects).toBe(0);

      expect(store.saveCompletedSnapshot(secondSnapshot).status).toBe("ok");
      const conflicted = store.consumeCompletedSnapshot(firstRead.value.rowToken);
      expect(conflicted.status).toBe("error");
      await rollbackSurfaceRecovery(firstPlan);
      expect({ pausedAdmissions, agentEffects }).toEqual({ pausedAdmissions: 0, agentEffects: 0 });

      const secondRead = store.readCompletedSnapshot(2_000);
      if (secondRead.status !== "ok" || secondRead.value.state !== "loaded") {
        throw new Error("Expected second process snapshot");
      }
      const secondPlan = plan(secondSnapshot);
      expect((await applySurfaceRecovery(secondPlan)).status).toBe("ok");
      expect(store.consumeCompletedSnapshot(secondRead.value.rowToken).status).toBe("ok");
      activateSurfaceRecovery(secondPlan);
      expect({ pausedAdmissions, agentEffects }).toEqual({ pausedAdmissions: 1, agentEffects: 1 });
    } finally {
      store.close();
    }
  });

  it("retains the exact snapshot row when startup fails after paused apply", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot({ createdAt: 1_000 });
    let paused = false;
    const plan: SurfaceRecoveryPlan = {
      snapshot,
      attempts: [],
      agentAttempt: {
        apply: () => {
          paused = true;
          return Result.ok(undefined);
        },
        rollback: () => {
          paused = false;
        },
        activate: () => undefined,
      },
    };
    try {
      expect(store.saveCompletedSnapshot(snapshot).status).toBe("ok");
      const before = store.readCompletedSnapshot(1_000);
      if (before.status !== "ok" || before.value.state !== "loaded") {
        throw new Error("Expected startup recovery row");
      }
      expect((await applySurfaceRecovery(plan)).status).toBe("ok");
      const ownership = createPausedSurfaceRecoveryOwnership(plan);
      await ownership.rollback();
      expect(paused).toBe(false);

      const retained = store.readCompletedSnapshot(1_000);
      expect(retained.status).toBe("ok");
      if (retained.status === "ok" && retained.value.state === "loaded") {
        expect(retained.value.rowToken).toEqual(before.value.rowToken);
      } else {
        throw new Error("Expected exact retained startup recovery row");
      }
    } finally {
      store.close();
    }
  });
});
