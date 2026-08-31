import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CoreBlobStorageCredentialMissing,
  createCoreBlobStore,
} from "../../src/runtime/create-core-blob-store";

let temporaryRoot: string | null = null;

afterEach(async () => {
  if (!temporaryRoot) return;
  await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("Core blob store composition", () => {
  it("resolves the omitted local root below the runtime data directory", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "lilac-core-blob-runtime-"));
    const created = await createCoreBlobStore({
      config: { kind: "local" },
      dataDir: temporaryRoot,
    });
    const store = created.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });

    expect((await stat(path.join(temporaryRoot, "blobs"))).isDirectory()).toBe(true);
    const closed = await store.close({ deadlineAtMs: Date.now() + 1_000 });
    expect(closed.status).toBe("ok");
  });

  it("fails before opening S3 when a named credential is missing", async () => {
    const created = await createCoreBlobStore({
      config: {
        kind: "s3",
        bucket: "private-bucket",
        prefix: "production/blobs",
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        accessKeyIdEnv: "TEST_ACCESS_KEY_ID",
        secretAccessKeyEnv: "TEST_SECRET_ACCESS_KEY",
        forcePathStyle: false,
      },
      dataDir: "/unused",
      environment: {},
    });

    const error = created.match({ ok: () => null, err: (failure) => failure });
    expect(CoreBlobStorageCredentialMissing.is(error)).toBe(true);
    expect(error).toMatchObject({ environmentVariable: "TEST_ACCESS_KEY_ID" });
  });

  it("requires a configured S3 session-token environment variable", async () => {
    const created = await createCoreBlobStore({
      config: {
        kind: "s3",
        bucket: "private-bucket",
        prefix: "production/blobs",
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        accessKeyIdEnv: "TEST_ACCESS_KEY_ID",
        secretAccessKeyEnv: "TEST_SECRET_ACCESS_KEY",
        sessionTokenEnv: "TEST_SESSION_TOKEN",
        forcePathStyle: true,
      },
      dataDir: "/unused",
      environment: {
        TEST_ACCESS_KEY_ID: "access-key",
        TEST_SECRET_ACCESS_KEY: "secret-key",
      },
    });

    const error = created.match({ ok: () => null, err: (failure) => failure });
    expect(CoreBlobStorageCredentialMissing.is(error)).toBe(true);
    expect(error).toMatchObject({ environmentVariable: "TEST_SESSION_TOKEN" });
  });
});
