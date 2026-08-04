import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Panic } from "better-result";

import {
  adaptToolResultArtifactReadToAvailability,
  adaptToolResultArtifactReadToUnavailablePolicy,
  createToolResultArtifactStore as createResultToolResultArtifactStore,
  TOOL_RESULT_MAX_PAGE_CHARACTERS,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
  ToolResultArtifactContentMismatch,
  ToolResultArtifactDecryptAuthenticationFailed,
  ToolResultArtifactInvalidInput,
  ToolResultArtifactMaintenanceAndCleanupFailure,
  ToolResultArtifactReadAndCleanupFailure,
  ToolResultArtifactStorageFailure,
  ToolResultArtifactTooLargeError,
  ToolResultArtifactWriteAndCleanupFailure,
} from "../src/tool-result-artifact-store";
import { ToolResultArtifactMetadataAbsent } from "../src/tool-result-artifact-metadata-codec";

function createToolResultArtifactStore(rootDir: string) {
  const store = createResultToolResultArtifactStore(rootDir);
  const value = async <T>(
    resultPromise: Promise<{ status: "ok"; value: T } | { status: "error"; error: Error }>,
  ) => {
    const result = await resultPromise;
    if (result.status === "error") throw result.error;
    return result.value;
  };
  return {
    rootDir: store.rootDir,
    init: () => value(store.init()),
    create: (params: Parameters<typeof store.create>[0]) => value(store.create(params)),
    createFromFile: (params: Parameters<typeof store.createFromFile>[0]) =>
      value(store.createFromFile(params)),
    createFromStream: (params: Parameters<typeof store.createFromStream>[0]) =>
      value(store.createFromStream(params)),
    read: async (...params: Parameters<typeof store.read>) =>
      adaptToolResultArtifactReadToAvailability(await store.read(...params)),
    readWindow: async (...params: Parameters<typeof store.readWindow>) =>
      adaptToolResultArtifactReadToAvailability(await store.readWindow(...params)),
    maintain: (now?: number) => value(store.maintain(now)),
  };
}

function sourceThatThrows(cause: unknown): Readable {
  return new Readable({
    read() {
      this.emit("error", cause);
    },
  });
}

describe("tool result artifact store", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-tool-results-"));
  });

  afterEach(async () => {
    setSystemTime();
    await rm(baseDir, { recursive: true, force: true });
  });

  function artifactParams(content: string, sessionId = "session-a") {
    return {
      sessionId,
      requestId: "request-a",
      toolCallId: "tool-a",
      toolName: "plugin-tool",
      content,
      ttlMs: 1000,
      maxBytesPerSession: 10,
    };
  }

  it("writes private artifacts and enforces session ownership", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create(artifactParams("hello"));

    expect(await store.read(created.uri, "session-a")).toMatchObject({
      ok: true,
      content: "hello",
    });
    expect(await store.read(created.uri, "session-b")).toEqual({ ok: false });
    expect(
      await store.readWindow(created.uri, "session-b", {
        start: { type: "offset", offset: 0 },
        maxCharacters: 10,
        maxLines: 10,
      }),
    ).toEqual({ ok: false });
    const storedEntries = await readdir(store.rootDir);
    expect(storedEntries.some((entry) => entry.includes(created.id))).toBe(false);
    const encryptedContentPath = path.join(
      store.rootDir,
      storedEntries.find((entry) => entry.endsWith(".bin"))!,
    );
    const encryptedMetadataPath = path.join(
      store.rootDir,
      storedEntries.find((entry) => entry.endsWith(".meta"))!,
    );
    expect((await stat(encryptedContentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(encryptedMetadataPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(encryptedContentPath)).includes(Buffer.from("hello"))).toBe(false);
    expect((await readFile(encryptedMetadataPath)).includes(Buffer.from("session-a"))).toBe(false);
  });

  it("streams encrypted artifact creation from a file", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const sourcePath = path.join(baseDir, "source.txt");
    await writeFile(sourcePath, "streamed-content");
    const created = await store.createFromFile({
      sessionId: "session-a",
      requestId: "request-a",
      toolCallId: "tool-a",
      toolName: "bash",
      sourcePath,
      ttlMs: 1000,
      maxBytesPerSession: 100,
    });
    expect(created.bytes).toBe(Buffer.byteLength("streamed-content"));
    expect(await store.read(created.uri, "session-a")).toMatchObject({
      ok: true,
      content: "streamed-content",
    });
  });

  it("streams a producer directly into encrypted artifact storage", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.createFromStream({
      scopeId: "session-a",
      requestId: "request-a",
      toolCallId: "tool-a",
      toolName: "bash",
      source: Readable.from(["streamed-", "producer"]),
      ttlMs: 1000,
      maxBytesPerScope: 100,
    });

    expect(created.bytes).toBe(Buffer.byteLength("streamed-producer"));
    expect(await store.read(created.uri, "session-a")).toMatchObject({
      ok: true,
      content: "streamed-producer",
    });
  });

  it("rejects strings, files, and streams above the hard artifact limit without residue", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const sourcePath = path.join(baseDir, "oversized.txt");
    await writeFile(sourcePath, "123456");
    const common = {
      scopeId: "scope-a",
      requestId: "request-a",
      toolCallId: "tool-a",
      toolName: "plugin-tool",
      ttlMs: 1000,
      maxBytesPerScope: 100,
      maxArtifactBytes: 5,
    };

    const stringResult = await store.create({ ...common, content: "123456" });
    expect(stringResult.status === "error" && stringResult.error).toBeInstanceOf(
      ToolResultArtifactTooLargeError,
    );
    expect(await readdir(store.rootDir)).toEqual([]);

    const fileResult = await store.createFromFile({ ...common, sourcePath });
    expect(fileResult.status === "error" && fileResult.error).toBeInstanceOf(
      ToolResultArtifactTooLargeError,
    );
    expect(await readdir(store.rootDir)).toEqual([]);

    const streamResult = await store.createFromStream({
      ...common,
      source: Readable.from(["123", "456"]),
    });
    expect(streamResult.status === "error" && streamResult.error).toBeInstanceOf(
      ToolResultArtifactTooLargeError,
    );
    expect(await readdir(store.rootDir)).toEqual([]);

    const invalidLimit = await store.create({
      ...common,
      content: "small",
      maxArtifactBytes: Number.NaN,
    });
    expect(invalidLimit.status === "error" && invalidLimit.error).toBeInstanceOf(
      ToolResultArtifactInvalidInput,
    );
    expect(await readdir(store.rootDir)).toEqual([]);
  });

  it("releases exclusive storage access after an operation error", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const failedSource = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    const failed = await store.createFromStream({
      scopeId: "scope-a",
      requestId: "request-a",
      toolCallId: "failed",
      toolName: "plugin-tool",
      source: failedSource,
      ttlMs: 1000,
      maxBytesPerScope: 100,
    });
    expect(failed.status).toBe("error");

    const created = await store.create({
      scopeId: "scope-a",
      requestId: "request-a",
      toolCallId: "succeeded",
      toolName: "plugin-tool",
      content: "stored",
      ttlMs: 1000,
      maxBytesPerScope: 100,
    });
    expect(created.status).toBe("ok");
  });

  it("maps non-Error stream failures without retaining raw values or encrypted residue", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const failures: readonly unknown[] = [
      "raw-string-secret",
      { privateValue: "raw-object-secret" },
    ];

    for (const [index, failure] of failures.entries()) {
      const result = await store.createFromStream({
        scopeId: "scope-a",
        requestId: "request-a",
        toolCallId: `tool-${index}`,
        toolName: "plugin-tool",
        source: sourceThatThrows(failure),
        ttlMs: 1000,
        maxBytesPerScope: 100,
      });

      expect(result.status === "error" && result.error).toBeInstanceOf(
        ToolResultArtifactStorageFailure,
      );
      if (result.status === "error" && result.error instanceof ToolResultArtifactStorageFailure) {
        expect(result.error).toMatchObject({ operation: "write-content", code: "UNKNOWN" });
      }
      expect(JSON.stringify(result)).not.toContain("raw-string-secret");
      expect(JSON.stringify(result)).not.toContain("raw-object-secret");
      expect(await readdir(store.rootDir)).toEqual([]);
    }
  });

  it("returns an owned combined error when stream operation and cleanup both fail", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const remove = spyOn(fs, "rm").mockRejectedValueOnce("raw-cleanup-secret");

    try {
      const result = await store.createFromStream({
        scopeId: "scope-a",
        requestId: "request-a",
        toolCallId: "tool-a",
        toolName: "plugin-tool",
        source: sourceThatThrows("raw-operation-secret"),
        ttlMs: 1000,
        maxBytesPerScope: 100,
      });

      expect(result.status === "error" && result.error).toBeInstanceOf(
        ToolResultArtifactWriteAndCleanupFailure,
      );
      if (
        result.status === "error" &&
        result.error instanceof ToolResultArtifactWriteAndCleanupFailure
      ) {
        expect(result.error.primaryError).toBeInstanceOf(ToolResultArtifactStorageFailure);
        expect(result.error.cleanupErrors).toHaveLength(1);
        expect(result.error.cleanupErrors[0]).toMatchObject({ operation: "remove-artifact" });
      }
      expect(JSON.stringify(result)).not.toContain("raw-operation-secret");
      expect(JSON.stringify(result)).not.toContain("raw-cleanup-secret");
    } finally {
      remove.mockRestore();
    }
  });

  it("preserves cleanup Panic identity after an ordinary stream failure", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const cleanupPanic = new Panic({ message: "cleanup invariant failed" });
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(cleanupPanic);

    try {
      await expect(
        store.createFromStream({
          scopeId: "scope-a",
          requestId: "request-a",
          toolCallId: "tool-a",
          toolName: "plugin-tool",
          source: sourceThatThrows("ordinary stream failure"),
          ttlMs: 1000,
          maxBytesPerScope: 100,
        }),
      ).rejects.toBe(cleanupPanic);
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }
  });

  it("attempts stream cleanup before rethrowing the exact primary Panic", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const primaryPanic = new Panic({ message: "stream invariant failed" });
    const remove = spyOn(fs, "rm");

    try {
      await expect(
        store.createFromStream({
          scopeId: "scope-a",
          requestId: "request-a",
          toolCallId: "tool-a",
          toolName: "plugin-tool",
          source: sourceThatThrows(primaryPanic),
          ttlMs: 1000,
          maxBytesPerScope: 100,
        }),
      ).rejects.toBe(primaryPanic);
      expect(remove).toHaveBeenCalled();
      expect(await readdir(store.rootDir)).toEqual([]);
    } finally {
      remove.mockRestore();
    }
  });

  it("gives the primary stream Panic precedence after cleanup also panics", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const primaryPanic = new Panic({ message: "stream invariant failed" });
    const cleanupPanic = new Panic({ message: "cleanup invariant failed" });
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(cleanupPanic);

    try {
      await expect(
        store.createFromStream({
          scopeId: "scope-a",
          requestId: "request-a",
          toolCallId: "tool-a",
          toolName: "plugin-tool",
          source: sourceThatThrows(primaryPanic),
          ttlMs: 1000,
          maxBytesPerScope: 100,
        }),
      ).rejects.toBe(primaryPanic);
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }
  });

  it("returns a typed combined error when encrypted-window work and close both fail", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("window-content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const handle = await fs.open(path.join(store.rootDir, contentEntry), "r");
    const open = spyOn(fs, "open").mockResolvedValueOnce(handle);
    const operation = spyOn(handle, "stat").mockRejectedValueOnce(new Error("header failed"));
    const close = spyOn(handle, "close").mockRejectedValueOnce(new Error("close failed"));

    try {
      const result = await store.readWindow(created.value.uri, "session-a", {
        start: { type: "offset", offset: 0 },
        maxCharacters: 10,
        maxLines: 10,
      });

      expect(result.status === "error" && result.error).toBeInstanceOf(
        ToolResultArtifactReadAndCleanupFailure,
      );
      if (
        result.status === "error" &&
        result.error instanceof ToolResultArtifactReadAndCleanupFailure
      ) {
        expect(result.error.primaryError).toMatchObject({ operation: "read-content" });
        expect(result.error.cleanupError).toMatchObject({ operation: "read-content" });
      }
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      operation.mockRestore();
      close.mockRestore();
      await handle.close();
    }
  });

  it("always closes encrypted-window handles and preserves the exact primary Panic", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("window-content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const primaryPanic = new Panic({ message: "window header invariant failed" });
    const cleanupPanic = new Panic({ message: "window close invariant failed" });
    const handle = await fs.open(path.join(store.rootDir, contentEntry), "r");
    const open = spyOn(fs, "open").mockResolvedValueOnce(handle);
    const operation = spyOn(handle, "stat").mockRejectedValueOnce(primaryPanic);
    const close = spyOn(handle, "close").mockRejectedValueOnce(cleanupPanic);

    try {
      await expect(
        store.readWindow(created.value.uri, "session-a", {
          start: { type: "offset", offset: 0 },
          maxCharacters: 10,
          maxLines: 10,
        }),
      ).rejects.toBe(primaryPanic);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      operation.mockRestore();
      close.mockRestore();
      await handle.close();
    }
  });

  it("closes the ciphertext handle before rethrowing a decryption-path Panic", async () => {
    const primaryPanic = new Panic({ message: "content diagnostic invariant failed" });
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"), {
      onDiagnostic: () => {
        throw primaryPanic;
      },
    });
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("window-content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const contentFile = path.join(store.rootDir, contentEntry);
    const encrypted = await readFile(contentFile);
    encrypted[12] = (encrypted[12] ?? 0) ^ 1;
    await writeFile(contentFile, encrypted);
    const headerHandle = await fs.open(contentFile, "r");
    const ciphertextHandle = await fs.open(contentFile, "r");
    const headerClose = spyOn(headerHandle, "close");
    const ciphertextClose = spyOn(ciphertextHandle, "close");
    const open = spyOn(fs, "open")
      .mockResolvedValueOnce(headerHandle)
      .mockResolvedValueOnce(ciphertextHandle);

    try {
      await expect(
        store.readWindow(created.value.uri, "session-a", {
          start: { type: "offset", offset: 0 },
          maxCharacters: 10,
          maxLines: 10,
        }),
      ).rejects.toBe(primaryPanic);
      expect(headerClose).toHaveBeenCalledTimes(1);
      expect(ciphertextClose).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      headerClose.mockRestore();
      ciphertextClose.mockRestore();
    }
  });

  it("expires artifacts without extending lifetime on read", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create(artifactParams("hello"));
    expect((await store.read(created.uri, "session-a")).ok).toBe(true);

    setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect(await store.read(created.uri, "session-a")).toEqual({ ok: false });
    expect(await readdir(store.rootDir)).toHaveLength(2);
  });

  it("removes artifacts encrypted by a previous runtime", async () => {
    const rootDir = path.join(baseDir, "tool-results");
    const firstRuntime = createToolResultArtifactStore(rootDir);
    await firstRuntime.init();
    const created = await firstRuntime.create(artifactParams("hello"));

    const restartedRuntime = createToolResultArtifactStore(rootDir);
    await restartedRuntime.init();
    expect(await restartedRuntime.read(created.uri, "session-a")).toEqual({ ok: false });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("writes current v1 metadata and does not rewrite it while reading", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("no-read-rewrite"));
    if (created.status === "error") throw created.error;
    const metadataEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".meta"));
    if (!metadataEntry) throw new Error("expected metadata entry");
    const metadataFile = path.join(store.rootDir, metadataEntry);
    const before = await readFile(metadataFile);

    const read = await store.read(created.value.uri, "session-a");

    expect(read.status).toBe("ok");
    expect(await readFile(metadataFile)).toEqual(before);
  });

  it("classifies metadata authentication corruption and emits redacted diagnostics", async () => {
    const diagnostics: object[] = [];
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("secret-content-never-diagnosed"));
    if (created.status === "error") throw created.error;
    const entries = await readdir(store.rootDir);
    const metadataEntry = entries.find((entry) => entry.endsWith(".meta"));
    if (!metadataEntry) throw new Error("expected metadata entry");
    const metadataFile = path.join(store.rootDir, metadataEntry);
    const encrypted = await readFile(metadataFile);
    encrypted[12] = (encrypted[12] ?? 0) ^ 1;
    await writeFile(metadataFile, encrypted);
    const entriesBeforeRead = await readdir(store.rootDir);
    const metadataBeforeRead = await readFile(metadataFile);

    const read = await store.read(created.value.uri, "session-a");

    expect(read.status === "error" && read.error).toBeInstanceOf(
      ToolResultArtifactDecryptAuthenticationFailed,
    );
    expect(diagnostics).toEqual([{ operation: "read-metadata", issueCode: "decrypt-auth-failed" }]);
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(serializedDiagnostics.length).toBeLessThan(160);
    expect(serializedDiagnostics).not.toContain("secret-content-never-diagnosed");
    expect(serializedDiagnostics).not.toContain(metadataEntry.slice(0, -".meta".length));
    expect(await readdir(store.rootDir)).toEqual(entriesBeforeRead);
    expect(await readFile(metadataFile)).toEqual(metadataBeforeRead);

    expect(await adaptToolResultArtifactReadToUnavailablePolicy(store, read)).toEqual({
      ok: false,
    });
    expect(await readdir(store.rootDir)).toEqual(entriesBeforeRead);
    expect(await readFile(metadataFile)).toEqual(metadataBeforeRead);

    expect(
      await adaptToolResultArtifactReadToUnavailablePolicy(store, read, {
        kind: "maintain-after-unavailable",
        onMaintenanceError: "unavailable",
      }),
    ).toEqual({ ok: false });
    expect(await readdir(store.rootDir)).toEqual([]);
  });

  it("applies the explicit read maintenance failure disposition", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    await writeFile(
      path.join(store.rootDir, contentEntry),
      Buffer.concat([await readFile(path.join(store.rootDir, contentEntry)), Buffer.from([0])]),
    );
    const read = await store.read(created.value.uri, "session-a");
    expect(read.status === "error" && read.error).toBeInstanceOf(ToolResultArtifactContentMismatch);
    const remove = spyOn(fs, "rm").mockRejectedValue(new Error("maintenance cleanup failed"));

    try {
      await expect(
        adaptToolResultArtifactReadToUnavailablePolicy(store, read, {
          kind: "maintain-after-unavailable",
          onMaintenanceError: "reject",
        }),
      ).rejects.toBeInstanceOf(ToolResultArtifactMaintenanceAndCleanupFailure);

      expect(
        await adaptToolResultArtifactReadToUnavailablePolicy(store, read, {
          kind: "maintain-after-unavailable",
          onMaintenanceError: "unavailable",
        }),
      ).toEqual({ ok: false });
    } finally {
      remove.mockRestore();
    }
  });

  it("classifies absent metadata without mutation until maintenance", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("orphaned-content"));
    if (created.status === "error") throw created.error;
    const metadataEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".meta"));
    if (!metadataEntry) throw new Error("expected metadata entry");
    await rm(path.join(store.rootDir, metadataEntry));

    const read = await store.read(created.value.uri, "session-a");

    expect(read.status === "error" && read.error).toBeInstanceOf(ToolResultArtifactMetadataAbsent);
    expect(await readdir(store.rootDir)).toHaveLength(1);
    const maintained = await store.maintain();
    expect(maintained).toMatchObject({
      status: "ok",
      value: { removedInvalid: 1, removedExpired: 0 },
    });
    expect(await readdir(store.rootDir)).toEqual([]);
  });

  it("classifies content mismatch without mutation until maintenance", async () => {
    const diagnostics: object[] = [];
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const contentFile = path.join(store.rootDir, contentEntry);
    await writeFile(contentFile, Buffer.concat([await readFile(contentFile), Buffer.from([0])]));
    const entriesBeforeRead = await readdir(store.rootDir);
    const contentBeforeRead = await readFile(contentFile);

    const read = await store.read(created.value.uri, "session-a");

    expect(read.status === "error" && read.error).toBeInstanceOf(ToolResultArtifactContentMismatch);
    expect(diagnostics).toEqual([{ operation: "read-content", issueCode: "content-mismatch" }]);
    expect(await readdir(store.rootDir)).toEqual(entriesBeforeRead);
    expect(await readFile(contentFile)).toEqual(contentBeforeRead);
    expect(await store.maintain()).toMatchObject({
      status: "ok",
      value: { removedInvalid: 1, removedExpired: 0 },
    });
    expect(await readdir(store.rootDir)).toEqual([]);
  });

  it("returns a combined maintenance error when invalidation cleanup fails", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const contentFile = path.join(store.rootDir, contentEntry);
    await writeFile(contentFile, Buffer.concat([await readFile(contentFile), Buffer.from([0])]));
    const remove = spyOn(fs, "rm").mockRejectedValue(new Error("cleanup failed"));

    try {
      const maintained = await store.maintain();
      expect(maintained.status === "error" && maintained.error).toBeInstanceOf(
        ToolResultArtifactMaintenanceAndCleanupFailure,
      );
      if (
        maintained.status === "error" &&
        maintained.error instanceof ToolResultArtifactMaintenanceAndCleanupFailure
      ) {
        expect(maintained.error.primaryError).toBeInstanceOf(ToolResultArtifactContentMismatch);
        expect(maintained.error.cleanupError.operation).toBe("remove-artifact");
      }
    } finally {
      remove.mockRestore();
    }
  });

  it("preserves cleanup Panic identity from explicit maintenance", async () => {
    const store = createResultToolResultArtifactStore(path.join(baseDir, "tool-results"));
    expect((await store.init()).status).toBe("ok");
    const created = await store.create(artifactParams("content"));
    if (created.status === "error") throw created.error;
    const contentEntry = (await readdir(store.rootDir)).find((entry) => entry.endsWith(".bin"));
    if (!contentEntry) throw new Error("expected content entry");
    const contentFile = path.join(store.rootDir, contentEntry);
    await writeFile(contentFile, Buffer.concat([await readFile(contentFile), Buffer.from([0])]));
    const panic = new Panic({ message: "cleanup invariant failed" });
    const remove = spyOn(fs, "rm").mockRejectedValue(panic);

    try {
      await expect(store.maintain()).rejects.toBe(panic);
    } finally {
      remove.mockRestore();
    }
  });

  it("removes prior-runtime managed temporary and orphan files on startup", async () => {
    const rootDir = path.join(baseDir, "tool-results");
    const firstRuntime = createToolResultArtifactStore(rootDir);
    await firstRuntime.init();
    await firstRuntime.create(artifactParams("hello"));
    await writeFile(path.join(rootDir, "orphan.bin"), "orphan");
    await writeFile(path.join(rootDir, "write.bin.temporary.tmp"), "temporary");
    await writeFile(path.join(rootDir, "legacy.json"), "legacy");
    await writeFile(path.join(rootDir, "unmanaged.keep"), "keep");

    await createToolResultArtifactStore(rootDir).init();

    expect(await readdir(rootDir)).toEqual(["unmanaged.keep"]);
  });

  it("removes expired artifacts only through explicit maintenance", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    await store.create(artifactParams("old", "expired-session"));
    const retained = await store.create({
      ...artifactParams("live", "live-session"),
      ttlMs: 10_000,
    });
    expect(await readdir(store.rootDir)).toHaveLength(4);

    setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect((await store.read(retained.uri, "live-session")).ok).toBe(true);
    expect(await readdir(store.rootDir)).toHaveLength(4);
    expect(await store.maintain()).toEqual({ removedInvalid: 0, removedExpired: 1 });
    expect(await readdir(store.rootDir)).toHaveLength(2);
  });

  it("enforces a positive hard maximum for artifact pages", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("x".repeat(TOOL_RESULT_MAX_PAGE_CHARACTERS + 100)),
      maxBytesPerSession: 100_000,
    });

    const maximum = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: Number.MAX_SAFE_INTEGER,
      maxLines: 1,
    });
    expect(maximum.ok && maximum.content.length).toBe(TOOL_RESULT_MAX_PAGE_CHARACTERS);
    const positive = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: 0,
      maxLines: 0,
    });
    expect(positive.ok && positive.content.length).toBe(1);
  });

  it("reads offset windows in zero-based Unicode characters", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("A😀\nβZ"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 1 },
      maxCharacters: 2,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "😀\n",
      startOffset: 1,
      endOffset: 3,
      totalCharacters: 5,
      hasMore: true,
      nextStart: { type: "offset", offset: 3 },
    });
  });

  it("caps artifact payload bytes and returns the exact Unicode continuation", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("A😀BéC"),
      maxBytesPerSession: 100,
    });

    const first = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 0 },
      maxCharacters: 100,
      maxLines: 10,
      maxOutputBytes: 5,
    });
    expect(first).toMatchObject({
      ok: true,
      content: "A😀",
      endOffset: 2,
      nextStart: { type: "offset", offset: 2 },
      hasMore: true,
    });

    if (!first.ok || !first.nextStart) throw new Error("expected artifact continuation");
    const second = await store.readWindow(created.uri, "session-a", {
      start: first.nextStart,
      maxCharacters: 100,
      maxLines: 10,
      maxOutputBytes: 4,
    });
    expect(second).toMatchObject({ ok: true, content: "BéC", hasMore: false });
  });

  it("rejects an artifact page budget too small for one Unicode character", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("😀x"),
      maxBytesPerSession: 100,
    });

    await expect(
      store.readWindow(created.uri, "session-a", {
        start: { type: "offset", offset: 0 },
        maxCharacters: 100,
        maxLines: 10,
        maxOutputBytes: 3,
      }),
    ).rejects.toThrow(
      "Tool result artifact maxOutputBytes must be at least 4 to fit one Unicode character",
    );
    expect((await store.read(created.uri, "session-a")).ok).toBe(true);
  });

  it("reads multiline windows from one-based lines and Unicode columns", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("zero\n😀ab\nlast"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 1 },
      maxCharacters: 4,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "ab\nl",
      startOffset: 6,
      endOffset: 10,
      totalCharacters: 13,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 1 },
    });
    if (!result.ok || !result.nextStart) throw new Error("Expected a continuation");
    const continuation = await store.readWindow(created.uri, "session-a", {
      start: result.nextStart,
      maxCharacters: 10,
      maxLines: 10,
    });
    expect(continuation).toMatchObject({
      ok: true,
      content: "ast",
      startOffset: 10,
      endOffset: 13,
      hasMore: false,
    });
  });

  it("clamps line columns to the line end", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("one\n二三\nend"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 99 },
      maxCharacters: 2,
      maxLines: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "\ne",
      startOffset: 6,
      endOffset: 8,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 1 },
    });
  });

  it("normalizes starts beyond EOF to an empty EOF window", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("a😀\nlast"),
      maxBytesPerSession: 100,
    });

    const offset = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 999 },
      maxCharacters: 10,
      maxLines: 10,
    });
    const line = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 999, column: 999 },
      maxCharacters: 10,
      maxLines: 10,
    });

    expect(offset).toMatchObject({
      ok: true,
      content: "",
      startOffset: 7,
      endOffset: 7,
      totalCharacters: 7,
      hasMore: false,
    });
    expect(line).toMatchObject({
      ok: true,
      content: "",
      startOffset: 7,
      endOffset: 7,
      totalCharacters: 7,
      hasMore: false,
    });
    expect(offset.ok && offset.nextStart).toBeUndefined();
    expect(line.ok && line.nextStart).toBeUndefined();
  });

  it("caps and continues a long Unicode line exactly", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const content = "😀".repeat(TOOL_RESULT_MAX_PAGE_CHARACTERS + 2);
    const created = await store.create({
      ...artifactParams(content),
      maxBytesPerSession: Buffer.byteLength(content) + 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: Number.MAX_SAFE_INTEGER,
      maxLines: 1,
    });

    expect(result.ok && Array.from(result.content)).toHaveLength(TOOL_RESULT_MAX_PAGE_CHARACTERS);
    expect(result).toMatchObject({
      ok: true,
      startOffset: 0,
      endOffset: TOOL_RESULT_MAX_PAGE_CHARACTERS,
      totalCharacters: TOOL_RESULT_MAX_PAGE_CHARACTERS + 2,
      hasMore: true,
      nextStart: {
        type: "line",
        line: 1,
        column: TOOL_RESULT_MAX_PAGE_CHARACTERS,
      },
    });
  });

  it("keeps offset pages source-exact and line pages line-oriented", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("zero\none\ntwo"),
      maxBytesPerSession: 100,
    });

    const offset = await store.readWindow(created.uri, "session-a", {
      start: { type: "offset", offset: 2 },
      maxCharacters: 100,
      maxLines: 1,
    });
    const line = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2, column: 1 },
      maxCharacters: 100,
      maxLines: 1,
    });

    expect(offset).toMatchObject({
      ok: true,
      content: "ro\n",
      startOffset: 2,
      endOffset: 5,
      hasMore: true,
      nextStart: { type: "offset", offset: 5 },
    });
    expect(line).toMatchObject({
      ok: true,
      content: "ne",
      startOffset: 6,
      endOffset: 9,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 0 },
    });
  });

  it("reconstructs artifact source exactly from offset pages limited by lines", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const source = "one\n😀two\nthree";
    const created = await store.create({
      ...artifactParams(source),
      maxBytesPerSession: 100,
    });
    const chunks: string[] = [];
    let offset = 0;

    for (let page = 0; page < 10; page += 1) {
      const result = await store.readWindow(created.uri, "session-a", {
        start: { type: "offset", offset },
        maxCharacters: 100,
        maxLines: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected artifact page");
      chunks.push(result.content);
      if (!result.nextStart) break;
      expect(result.nextStart.type).toBe("offset");
      if (result.nextStart.type !== "offset") throw new Error("expected offset continuation");
      expect(result.nextStart.offset).toBeGreaterThan(offset);
      offset = result.nextStart.offset;
    }

    expect(chunks.join("")).toBe(source);
  });

  it("counts empty lines and advances across their newline", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("a\n\nb"),
      maxBytesPerSession: 100,
    });

    const result = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 2 },
      maxCharacters: 100,
      maxLines: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "",
      startOffset: 2,
      endOffset: 3,
      totalCharacters: 4,
      hasMore: true,
      nextStart: { type: "line", line: 3, column: 0 },
    });
  });

  it("applies character precedence at line boundaries and clamps maxLines", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const created = await store.create({
      ...artifactParams("ab\ncd\nef"),
      maxBytesPerSession: 100,
    });

    const lineFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 4,
      maxLines: 0,
    });
    const sameBoundary = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 3,
      maxLines: 1,
    });
    const newlineCharactersFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 3,
      maxLines: 2,
    });
    const charactersFirst = await store.readWindow(created.uri, "session-a", {
      start: { type: "line", line: 1 },
      maxCharacters: 2,
      maxLines: 2,
    });

    expect(lineFirst).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(sameBoundary).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(newlineCharactersFirst).toMatchObject({
      ok: true,
      content: "ab\n",
      endOffset: 3,
      nextStart: { type: "line", line: 2, column: 0 },
    });
    expect(charactersFirst).toMatchObject({
      ok: true,
      content: "ab",
      endOffset: 2,
      nextStart: { type: "line", line: 1, column: 2 },
    });
  });

  it("evicts oldest artifacts and retains an oversized artifact alone", async () => {
    const store = createToolResultArtifactStore(path.join(baseDir, "tool-results"));
    await store.init();
    const first = await store.create(artifactParams("123456"));
    const second = await store.create(artifactParams("abcdef"));
    expect(await store.read(first.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(second.uri, "session-a")).ok).toBe(true);

    const oversized = await store.create(artifactParams("this is oversized"));
    expect(oversized.oversized).toBe(true);
    expect(await store.read(second.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(oversized.uri, "session-a")).ok).toBe(true);

    const later = await store.create(artifactParams("later"));
    expect(await store.read(oversized.uri, "session-a")).toEqual({ ok: false });
    expect((await store.read(later.uri, "session-a")).ok).toBe(true);
  });

  it("uses one unavailable response contract", () => {
    expect(TOOL_RESULT_UNAVAILABLE_MESSAGE).toContain("expired or was evicted");
  });
});
