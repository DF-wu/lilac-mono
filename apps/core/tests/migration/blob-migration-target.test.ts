import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BlobUploadFailed,
  createMemoryBlobStore,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { afterEach, describe, expect, it } from "bun:test";

import {
  BlobMigrationCredentialMissing,
  loadBlobMigrationTargetConfig,
  preflightBlobMigrationTarget,
  uploadVerifiedDurableBlob,
} from "../../scripts/blob-migration-target";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function settleStore(result: Awaited<ReturnType<typeof createMemoryBlobStore>>): BlobStore {
  return result.match({
    ok: (store) => store,
    err: (error) => {
      throw error;
    },
  });
}

describe("blob migration target", () => {
  it("loads an explicit config and resolves the omitted local root below data-dir", async () => {
    const loaded = await loadBlobMigrationTargetConfig(
      { configPath: "/operator/core-config.yaml", dataDir: "/operator/data" },
      {
        readConfigText: async () => "configVersion: 2\n",
        environment: {},
      },
    );

    loaded.match({
      ok: ({ target }) => {
        expect(target).toEqual({ kind: "local", root: "/operator/data/blobs" });
      },
      err: (error) => {
        throw error;
      },
    });
  });

  it("dereferences S3 credential names without retaining the names as credentials", async () => {
    const loaded = await loadBlobMigrationTargetConfig(
      { configPath: "/operator/core-config.yaml", dataDir: "/operator/data" },
      {
        readConfigText: async () => `
configVersion: 2
blobStorage:
  kind: s3
  bucket: lilac
  prefix: production/blobs
  endpoint: https://s3.example.com
  region: us-east-1
  accessKeyIdEnv: TEST_ACCESS_KEY
  secretAccessKeyEnv: TEST_SECRET_KEY
  sessionTokenEnv: TEST_SESSION_TOKEN
`,
        environment: {
          TEST_ACCESS_KEY: "access-value",
          TEST_SECRET_KEY: "secret-value",
          TEST_SESSION_TOKEN: "session-value",
        },
      },
    );

    loaded.match({
      ok: ({ target }) => {
        expect(target).toEqual({
          kind: "s3",
          bucket: "lilac",
          prefix: "production/blobs",
          endpoint: "https://s3.example.com",
          region: "us-east-1",
          accessKeyId: "access-value",
          secretAccessKey: "secret-value",
          sessionToken: "session-value",
          forcePathStyle: false,
        });
      },
      err: (error) => {
        throw error;
      },
    });
  });

  it("fails closed when a configured credential environment variable is absent", async () => {
    const loaded = await loadBlobMigrationTargetConfig(
      { configPath: "/operator/core-config.yaml", dataDir: "/operator/data" },
      {
        readConfigText: async () => `
configVersion: 2
blobStorage:
  kind: s3
  bucket: lilac
  prefix: production/blobs
  endpoint: https://s3.example.com
  region: us-east-1
  accessKeyIdEnv: TEST_ACCESS_KEY
  secretAccessKeyEnv: TEST_SECRET_KEY
`,
        environment: { TEST_ACCESS_KEY: "access-value" },
      },
    );

    loaded.match({
      ok: () => {
        throw new Error("expected missing credential failure");
      },
      err: (error) => {
        expect(BlobMigrationCredentialMissing.is(error)).toBeTrue();
        if (BlobMigrationCredentialMissing.is(error)) {
          expect(error.environmentVariable).toBe("TEST_SECRET_KEY");
        }
      },
    });
  });

  it("preflights an absent local target without creating it", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-blob-target-"));
    temporaryRoots.push(fixtureRoot);
    const targetRoot = path.join(fixtureRoot, "absent", "blobs");

    const preflight = await preflightBlobMigrationTarget({ kind: "local", root: targetRoot });

    preflight.match({
      ok: (value) => {
        expect(value).toMatchObject({ adapterKind: "local", status: "absent" });
        expect(value.availableLocalBytes).toBeGreaterThan(0);
      },
      err: (error) => {
        throw error;
      },
    });
    expect(await fs.exists(targetRoot)).toBeFalse();
  });

  it("uploads a durable blob and verifies it through the adapter read path", async () => {
    const store = settleStore(await createMemoryBlobStore());
    const bytes = new TextEncoder().encode("verified migration content");

    const uploaded = await uploadVerifiedDurableBlob(store, { bytes });

    uploaded.match({
      ok: (ref) => {
        expect(ref.byteLength).toBe(bytes.byteLength);
        expect(ref.expiresAt).toBeUndefined();
      },
      err: (error) => {
        throw error;
      },
    });
    const closed = await store.close({ deadlineAtMs: Date.now() + 1_000 });
    closed.match({ ok: () => undefined, err: (error) => void expect(error).toBeUndefined() });
  });

  it("does not publish a reference when the expected digest is wrong", async () => {
    const store = settleStore(await createMemoryBlobStore());
    const uploaded = await uploadVerifiedDurableBlob(store, {
      bytes: new TextEncoder().encode("mismatch"),
      expectedSha256: "0".repeat(64),
    });

    uploaded.match({
      ok: () => {
        throw new Error("expected digest mismatch");
      },
      err: (error) => expect(BlobUploadFailed.is(error)).toBeTrue(),
    });
    const closed = await store.close({ deadlineAtMs: Date.now() + 1_000 });
    closed.match({ ok: () => undefined, err: (error) => void expect(error).toBeUndefined() });
  });
});
