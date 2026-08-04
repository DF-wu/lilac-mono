import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  acpCleanupFailuresForPanic,
  captureExternal,
  projectExternalFailure,
} from "../external-adapters.ts";
import {
  decodeRunRecord,
  decodeSessionIndex,
  loadRunRecord,
  loadSessionIndex,
  saveRunRecord,
  upsertSessionIndexEntries,
} from "../run-store.ts";
import { createEmptyPermissionCounters, type PromptRunRecord } from "../types.ts";

let tempRoot = "";
let previousStateHome: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-acp-store-test-"));
  previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tempRoot;
});

afterEach(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function runRecord(): PromptRunRecord {
  return {
    id: "run_11111111-1111-4111-8111-111111111111",
    status: "submitted",
    createdAt: 1,
    updatedAt: 1,
    directory: "/repo",
    harnessId: "opencode",
    targetKind: "new",
    promptText: "test",
    textPreview: "test",
    permissions: createEmptyPermissionCounters(),
  };
}

describe("run persistence codecs", () => {
  it("distinguishes current, malformed, and corrupt run records", () => {
    const current = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify(runRecord()),
    });
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const malformed = decodeRunRecord({ runId: runRecord().id, content: "{" });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("RunRecordMalformedSerialization");
    }

    const corrupt = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify({ id: runRecord().id }),
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("RunRecordCorruptFields");
  });

  it("migrates historical run records only when permissions are absent", () => {
    const { permissions: _permissions, ...legacyRecord } = runRecord();
    const legacy = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify(legacyRecord),
    });
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value.permissions).toEqual(createEmptyPermissionCounters());
    }
  });

  it("rejects current-shaped run records with present malformed permissions", () => {
    const malformedPermissions = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify({ ...runRecord(), permissions: {} }),
    });

    expect(malformedPermissions.status).toBe("error");
    if (malformedPermissions.status === "error") {
      expect(malformedPermissions.error._tag).toBe("RunRecordCorruptFields");
    }
  });

  it("distinguishes session index codec outcomes", () => {
    const current = decodeSessionIndex('{"version":1,"sessions":[]}');
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const malformed = decodeSessionIndex("{");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("SessionIndexMalformedSerialization");
    }

    const unsupported = decodeSessionIndex('{"version":2,"sessions":[]}');
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("SessionIndexUnsupportedVersion");
    }

    const corrupt = decodeSessionIndex('{"version":1,"sessions":"invalid"}');
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("SessionIndexCorruptFields");

    const legacy = decodeSessionIndex('{"version":0,"sessions":[]}');
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value.version).toBe(1);
    }
  });
});

describe("run store adapters", () => {
  it("round trips records and reports missing session index provenance", async () => {
    const missing = await loadSessionIndex();
    expect(missing.status).toBe("ok");
    if (missing.status === "ok") expect(missing.value.provenance).toBe("missing-defaulted");

    const saved = await saveRunRecord(runRecord());
    expect(saved.status).toBe("ok");
    const loaded = await loadRunRecord(runRecord().id);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.value).toEqual(runRecord());
  });

  it("keeps malformed, corrupt, and unsupported session indexes as typed errors", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(indexPath, "{", "utf8");

    const malformed = await loadSessionIndex();
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("SessionIndexMalformedSerialization");
    }

    await fs.writeFile(indexPath, '{"version":1,"sessions":"invalid"}', "utf8");
    const corrupt = await loadSessionIndex();
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("SessionIndexCorruptFields");

    await fs.writeFile(indexPath, '{"version":2,"sessions":[]}', "utf8");
    const unsupported = await loadSessionIndex();
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("SessionIndexUnsupportedVersion");
    }
  });

  it("blocks upserts without rewriting corrupt or unsupported session indexes", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    const invalidIndexes = [
      {
        content: '{"version":1,"sessions":"invalid"}',
        tag: "SessionIndexCorruptFields",
      },
      {
        content: '{"version":2,"sessions":[]}',
        tag: "SessionIndexUnsupportedVersion",
      },
    ] as const;

    for (const invalid of invalidIndexes) {
      await fs.writeFile(indexPath, invalid.content, "utf8");
      const upserted = await upsertSessionIndexEntries([
        {
          sessionRef: "opencode::session-1",
          harnessId: "opencode",
          remoteSessionId: "session-1",
          cwd: "/repo",
          capabilities: [],
          lastSeenAt: 1,
        },
      ]);

      expect(upserted.status).toBe("error");
      if (upserted.status === "error") expect(upserted.error._tag).toBe(invalid.tag);
      expect(await fs.readFile(indexPath, "utf8")).toBe(invalid.content);
    }
  });

  it("releases the session-index lock before rethrowing the exact work Panic", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    const lockPath = path.join(sessionsDir, "index.lock");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(indexPath, '{"version":1,"sessions":[]}', "utf8");
    const panic = new Panic({ message: "session index work invariant" });
    const entry = new Proxy(
      {
        sessionRef: "opencode::session-1",
        harnessId: "opencode",
        remoteSessionId: "session-1",
        cwd: "/repo",
        capabilities: [],
        lastSeenAt: 1,
      },
      {
        get(target, property, receiver) {
          if (property === "sessionRef") throw panic;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    let observed: unknown;
    try {
      await upsertSessionIndexEntries([entry]);
    } catch (cause) {
      observed = cause;
    }

    expect(observed).toBe(panic);
    const lock = await captureExternal("read-session-index", () => fs.stat(lockPath));
    expect(lock.status).toBe("error");
    if (lock.status === "error") expect(lock.error.code).toBe("ENOENT");
  });

  it("retains cleanup failure while preserving the original work Panic", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    const lockPath = path.join(sessionsDir, "index.lock");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(indexPath, '{"version":1,"sessions":[]}', "utf8");
    const panic = new Panic({ message: "session index work invariant" });
    const entry = new Proxy(
      {
        sessionRef: "opencode::session-1",
        harnessId: "opencode",
        remoteSessionId: "session-1",
        cwd: "/repo",
        capabilities: [],
        lastSeenAt: 1,
      },
      {
        get(target, property, receiver) {
          if (property === "sessionRef") {
            fsSync.chmodSync(sessionsDir, 0o500);
            throw panic;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    let observed: unknown;
    try {
      await upsertSessionIndexEntries([entry]);
    } catch (cause) {
      observed = cause;
    } finally {
      fsSync.chmodSync(sessionsDir, 0o700);
    }

    expect(observed).toBe(panic);
    const cleanupFailures = acpCleanupFailuresForPanic(panic);
    expect(cleanupFailures).toHaveLength(1);
    expect(cleanupFailures[0]?._tag).toBe("ExternalOperationFailed");
    await fs.rm(lockPath, { recursive: true, force: true });
  });

  it("preserves exact Panic identity at external rejection boundaries", async () => {
    const panic = new Panic({ message: "adapter invariant" });
    let observed: unknown;
    try {
      await captureExternal("read-run", () => Promise.reject(panic));
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBe(panic);
  });

  it("totally projects null-prototype and hostile proxy rejection values", async () => {
    const nullPrototype = Object.create(null);
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap");
      },
      get() {
        throw new Error("get trap");
      },
      has() {
        throw new Error("has trap");
      },
    });

    for (const cause of [nullPrototype, hostile]) {
      expect(projectExternalFailure(cause)).toEqual({ message: "Opaque ACP external failure" });
      const captured = await captureExternal("read-run", () => Promise.reject(cause));
      expect(captured.status).toBe("error");
      if (captured.status === "error") {
        expect(captured.error.message).toBe("Opaque ACP external failure");
      }
    }
  });
});
