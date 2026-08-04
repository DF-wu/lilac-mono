import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { buildCoreLineageManifestV1 as buildCoreLineageManifestResultV1 } from "@stanley2058/lilac-event-bus";
import type { Result as ResultType } from "better-result";
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
  GracefulRestartSqliteFailure,
  gracefulRestartSnapshotCodecCases,
  OpaqueSuperJsonValueUnsupported,
  SqliteGracefulRestartStore,
  type GracefulRestartSnapshotInput,
} from "../../src/runtime/graceful-restart-store";

const tempDirs: string[] = [];

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function buildCoreLineageManifestV1(...args: Parameters<typeof buildCoreLineageManifestResultV1>) {
  return resultValue(buildCoreLineageManifestResultV1(...args));
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
  const lineage = buildCoreLineageManifestV1([
    {
      atoms: [
        {
          kind: "synthetic",
          source: "restart-test",
          messageDigest: "11".repeat(32),
        },
      ],
      canonicalMessages: [{ role: "user", content: "queued" }],
    },
  ]);
  return {
    version: 2,
    createdAt: overrides?.createdAt ?? Date.now(),
    deadlineMs: overrides?.deadlineMs ?? 3_000,
    agent: [
      {
        kind: "active",
        requestId: "discord:chan:msg_active",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [],
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
      },
      {
        kind: "queued",
        requestId: "discord:chan:msg_queued",
        sessionId: "chan",
        requestClient: "discord",
        queue: "prompt",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "check this file" },
              {
                type: "file",
                data: new URL("https://example.com/a.txt"),
                mediaType: "text/plain",
              },
            ],
          },
        ],
        corePrimaryLineage: lineage,
        raw: { triggerType: "mention" },
      },
    ],
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

  it("exports and executes the complete six-case fixture catalog", () => {
    expect(Object.keys(gracefulRestartSnapshotCodecCases).sort()).toEqual([
      "corrupt-fields",
      "current",
      "legacy",
      "malformed-serialization",
      "missing-defaulted",
      "unsupported-version",
    ]);

    for (const fixture of Object.values(gracefulRestartSnapshotCodecCases)) {
      const decoded = decodeGracefulRestartSnapshot(fixture.input);
      expect(decoded.status).toBe(fixture.outcome);
    }
  });

  it("migrates the shipped v1 envelope and rejects every other version", () => {
    const legacy = decodeGracefulRestartSnapshot(gracefulRestartSnapshotCodecCases.legacy.input);
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value?.version).toBe(2);
    }

    const unsupported = decodeGracefulRestartSnapshot(
      gracefulRestartSnapshotCodecCases["unsupported-version"].input,
    );
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error")
      expect(unsupported.error).toBeInstanceOf(UnsupportedVersion);
  });

  it("distinguishes absent, malformed serialization, and corrupt nested fields", () => {
    const absent = decodeGracefulRestartSnapshot(null);
    expect(absent.status).toBe("ok");
    if (absent.status === "ok") {
      expect(absent.value).toEqual({ value: null, provenance: "missing-defaulted" });
    }

    const malformed = decodeGracefulRestartSnapshot(
      gracefulRestartSnapshotCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error).toBeInstanceOf(MalformedSerialization);
    }

    const corrupt = decodeGracefulRestartSnapshot(
      gracefulRestartSnapshotCodecCases["corrupt-fields"].input,
    );
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error).toBeInstanceOf(CorruptPersistedFields);
    }
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

  it("rejects unrecognized nested agent and relay fields", () => {
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

    for (const value of [nestedAgent, nestedRelay]) {
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
  it("preserves rich opaque raw values in a shipped v2 snapshot", async () => {
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

      const loaded = store.loadAndConsumeCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok" || loaded.value.state !== "loaded") {
        throw new Error("Expected a loaded rich v2 snapshot");
      }
      expect(isDeepStrictEqual(loaded.value.snapshot.agent[0]?.raw, opaque)).toBeTrue();
    } finally {
      store.close();
    }
  });

  it("saves and consumes a fully validated completed snapshot", async () => {
    const { store } = await makeStore();
    const snapshot = buildSnapshot();
    try {
      expect(store.saveCompletedSnapshot(snapshot).status).toBe("ok");

      const loaded = store.loadAndConsumeCompletedSnapshot();
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok" || loaded.value.state !== "loaded") {
        throw new Error("Expected a loaded graceful restart snapshot");
      }
      expect(loaded.value.provenance).toBe("current");
      expect(loaded.value.snapshot.agent).toHaveLength(2);
      expect(loaded.value.snapshot.relays).toHaveLength(1);

      const queued = loaded.value.snapshot.agent.find((entry) => entry.kind === "queued");
      expect(JSON.stringify(queued?.corePrimaryLineage)).toBe(
        JSON.stringify(snapshot.agent.find((entry) => entry.kind === "queued")?.corePrimaryLineage),
      );
      const queuedMessage = queued?.messages[0];
      if (
        !queuedMessage ||
        queuedMessage.role !== "user" ||
        !Array.isArray(queuedMessage.content)
      ) {
        throw new Error("Expected queued user content");
      }
      const file = queuedMessage.content.find((part) => part.type === "file");
      expect(file?.data).toBeInstanceOf(URL);

      const secondLoad = store.loadAndConsumeCompletedSnapshot();
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
      const empty = store.loadAndConsumeCompletedSnapshot();
      expect(empty.status).toBe("ok");
      if (empty.status === "ok") {
        expect(empty.value).toEqual({ state: "empty", provenance: "current" });
      }

      const absent = store.loadAndConsumeCompletedSnapshot();
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
      const stale = store.loadAndConsumeCompletedSnapshot(2_000);
      expect(stale.status).toBe("ok");
      if (stale.status === "ok") {
        expect(stale.value).toEqual({
          state: "stale",
          createdAt,
          deadlineMs,
          ageMs: 1_000,
          provenance: "current",
        });
      }
      const absent = store.loadAndConsumeCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") {
        expect(absent.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("commits consume-on-read before reporting malformed data", async () => {
    const { dbPath, store } = await makeStore();
    try {
      writePersistedRow(dbPath, "completed", "{");

      const first = store.loadAndConsumeCompletedSnapshot();
      expect(first.status).toBe("error");
      if (first.status === "error") expect(first.error).toBeInstanceOf(MalformedSerialization);

      const second = store.loadAndConsumeCompletedSnapshot();
      expect(second.status).toBe("ok");
      if (second.status === "ok") {
        expect(second.value).toEqual({ state: "absent", provenance: "missing-defaulted" });
      }
    } finally {
      store.close();
    }
  });

  it("returns invalid status and nested payload corruption as typed consumed errors", async () => {
    const { dbPath, store } = await makeStore();
    try {
      writePersistedRow(dbPath, "pending", "{}");
      const invalidStatus = store.loadAndConsumeCompletedSnapshot();
      expect(invalidStatus.status).toBe("error");
      if (invalidStatus.status === "error") {
        expect(invalidStatus.error).toBeInstanceOf(CorruptPersistedFields);
      }

      const fixture = gracefulRestartSnapshotCodecCases["corrupt-fields"].input;
      writePersistedRow(dbPath, fixture.status, fixture.payload_json);
      const corrupt = store.loadAndConsumeCompletedSnapshot();
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
      const absent = store.loadAndConsumeCompletedSnapshot();
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
      database.exec(`
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

      const absent = store.loadAndConsumeCompletedSnapshot();
      expect(absent.status).toBe("ok");
      if (absent.status === "ok") expect(absent.value.state).toBe("absent");
    } finally {
      store.close();
    }
  });

  it("rolls back consumption when the delete hits a recognized driver failure", async () => {
    const { dbPath, store } = await makeStore();
    const fixture = gracefulRestartSnapshotCodecCases.current.input;
    writePersistedRow(dbPath, fixture.status, fixture.payload_json);
    const database = new Database(dbPath, { strict: true });
    try {
      database.exec(`
        CREATE TRIGGER reject_graceful_restart_consume
        BEFORE DELETE ON graceful_restart_state
        BEGIN
          SELECT RAISE(ABORT, 'reject graceful restart consume');
        END;
      `);
      const failed = store.loadAndConsumeCompletedSnapshot();
      expect(failed.status).toBe("error");
      if (failed.status === "error") {
        expect(failed.error).toBeInstanceOf(GracefulRestartSqliteFailure);
      }

      database.run("DROP TRIGGER reject_graceful_restart_consume");
      const retained = store.loadAndConsumeCompletedSnapshot(1);
      expect(retained.status).toBe("ok");
      if (retained.status === "ok") expect(retained.value.state).toBe("empty");
    } finally {
      database.close();
      store.close();
    }
  });
});
