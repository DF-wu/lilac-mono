import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";

import { createBlobBackedToolResultArtifactStore } from "../src/blob-tool-result-artifact-store";
import {
  ToolResultArtifactStorageFailure,
  ToolResultArtifactTooLargeError,
} from "../src/tool-result-artifact-store";

describe("blob-backed tool result artifact store", () => {
  let baseDir: string;
  const stores: BlobStore[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-blob-tool-results-"));
  });

  afterEach(async () => {
    setSystemTime();
    await Promise.all(
      stores.splice(0).map((store) => store.close({ deadlineAtMs: Date.now() + 1_000 })),
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  async function memoryStore(): Promise<BlobStore> {
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    stores.push(created.value);
    return created.value;
  }

  function params(content: string, maxBytesPerScope = 100) {
    return {
      scopeId: "scope-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "tool-a",
      content,
      ttlMs: 1_000,
      maxBytesPerScope,
    };
  }

  function observeUploads(store: BlobStore, refs: BlobRefV1[]): BlobStore {
    return {
      startUpload: async (input) =>
        (await store.startUpload(input)).map((upload) => ({
          ...upload,
          completion: upload.completion.then((completed) =>
            completed.map((ref) => {
              refs.push(ref);
              return ref;
            }),
          ),
        })),
      resolve: (handle, options) => store.resolve(handle, options),
      open: (ref) => store.open(ref),
      delete: (target) => store.delete(target),
      maintain: (input) => store.maintain(input),
      close: (input) => store.close(input),
    };
  }

  it("stores only encrypted blob content and preserves exact domain expiry", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const blobs = await memoryStore();
    const refs: BlobRefV1[] = [];
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      observeUploads(blobs, refs),
    );
    expect((await artifacts.init()).status).toBe("ok");

    const created = await artifacts.create(params("hello"));
    expect(created.status).toBe("ok");
    if (created.status === "error") throw created.error;
    expect(await readdir(artifacts.rootDir)).toHaveLength(1);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ byteLength: 33, expiresAt: 1_767_225_601_000 });

    const opened = await blobs.open(refs[0]!);
    if (opened.status === "error") throw opened.error;
    const encrypted = await materializeBlobRead(opened.value);
    if (encrypted.status === "error") throw encrypted.error;
    expect(Buffer.from(encrypted.value).includes(Buffer.from("hello"))).toBe(false);

    expect(await artifacts.read(created.value.uri, "scope-b")).toMatchObject({ status: "error" });
    expect(await artifacts.read(created.value.uri, "scope-a")).toMatchObject({
      status: "ok",
      value: { content: "hello", createdAt: 1_767_225_600_000, expiresAt: 1_767_225_601_000 },
    });
  });

  it("streams encrypted input and keeps paging semantics", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const created = await artifacts.createFromStream({
      ...streamParams,
      source: Readable.from(["A😀\n", "beta"]),
    });
    if (created.status === "error") throw created.error;

    expect(
      await artifacts.readWindow(created.value.uri, "scope-a", {
        start: { type: "offset", offset: 1 },
        maxCharacters: 2,
        maxLines: 10,
      }),
    ).toMatchObject({
      status: "ok",
      value: {
        content: "😀\n",
        startOffset: 1,
        endOffset: 3,
        totalCharacters: 7,
        hasMore: true,
        nextStart: { type: "offset", offset: 3 },
      },
    });
  });

  it("rejects an oversized stream and deletes the completed partial blob", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const created = await artifacts.createFromStream({
      ...streamParams,
      maxArtifactBytes: 5,
      source: Readable.from(["123", "456"]),
    });

    expect(created.status === "error" && created.error).toBeInstanceOf(
      ToolResultArtifactTooLargeError,
    );
    expect(await readdir(artifacts.rootDir)).toEqual([]);
  });

  it("maps a failed source and releases serialized artifact operations", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const failedSource = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    const failed = await artifacts.createFromStream({ ...streamParams, source: failedSource });
    expect(failed.status === "error" && failed.error).toBeInstanceOf(
      ToolResultArtifactStorageFailure,
    );

    const created = await artifacts.create(params("stored"));
    expect(created.status).toBe("ok");
  });

  it("unlinks evicted metadata before deleting its blob", async () => {
    const blobs = await memoryStore();
    const metadataRoot = path.join(baseDir, "metadata");
    const metadataCountsAtDelete: number[] = [];
    const observed: BlobStore = {
      startUpload: (input) => blobs.startUpload(input),
      resolve: (handle, options) => blobs.resolve(handle, options),
      open: (ref) => blobs.open(ref),
      async delete(target) {
        metadataCountsAtDelete.push(
          (await readdir(metadataRoot)).filter((entry) => entry.endsWith(".meta")).length,
        );
        return blobs.delete(target);
      },
      maintain: (input) => blobs.maintain(input),
      close: (input) => blobs.close(input),
    };
    const artifacts = createBlobBackedToolResultArtifactStore(metadataRoot, observed);
    await artifacts.init();
    const first = await artifacts.create(params("first", 5));
    if (first.status === "error") throw first.error;
    const second = await artifacts.create({ ...params("last", 5), toolCallId: "call-b" });
    if (second.status === "error") throw second.error;

    expect(second.value.evicted).toBe(1);
    expect(metadataCountsAtDelete).toEqual([0]);
    expect(await artifacts.read(first.value.uri, "scope-a")).toMatchObject({ status: "error" });
    expect(await artifacts.read(second.value.uri, "scope-a")).toMatchObject({
      status: "ok",
      value: { content: "last" },
    });
  });
});
