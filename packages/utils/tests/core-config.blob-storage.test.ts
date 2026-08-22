import { describe, expect, it } from "bun:test";

import {
  parseCoreConfigV1,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2,
  parseCoreConfigV2ToUniversal,
} from "../core-config";

describe("core blob storage config", () => {
  it("keeps the v1 input frozen while supplying the universal local default", () => {
    const parsedInput = parseCoreConfigV1({
      configVersion: 1,
      blobStorage: { kind: "s3" },
    });

    expect("blobStorage" in parsedInput).toBe(false);
    expect(parseCoreConfigV1ToUniversal({ configVersion: 1 }).blobStorage).toEqual({
      kind: "local",
    });
  });

  it("supplies the same universal local default for an omitted v2 field", () => {
    const parsedInput = parseCoreConfigV2({ configVersion: 2 });

    expect(parsedInput.blobStorage).toBeUndefined();
    expect(parseCoreConfigV2ToUniversal({ configVersion: 2 }).blobStorage).toEqual({
      kind: "local",
    });
  });

  it("isolates universal v2 defaults between parses", () => {
    const first = parseCoreConfigV2ToUniversal({ configVersion: 2 });
    first.conversation.thread.autoInject.enabled = true;

    expect(
      parseCoreConfigV2ToUniversal({ configVersion: 2 }).conversation.thread.autoInject.enabled,
    ).toBe(false);
  });

  it("accepts an explicit local adapter with an absolute root", () => {
    expect(
      parseCoreConfigV2ToUniversal({
        configVersion: 2,
        blobStorage: { kind: "local", root: "/var/lib/lilac/blobs" },
      }).blobStorage,
    ).toEqual({ kind: "local", root: "/var/lib/lilac/blobs" });
  });

  it("rejects an explicit local adapter without an absolute root", () => {
    for (const blobStorage of [{ kind: "local" }, { kind: "local", root: "blobs" }]) {
      expect(() => parseCoreConfigV2({ configVersion: 2, blobStorage })).toThrow();
    }
  });

  it("accepts S3 credentials only as environment variable names", () => {
    const blobStorage = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      blobStorage: {
        kind: "s3",
        bucket: "lilac",
        prefix: "production/blobs",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        accessKeyIdEnv: "LILAC_S3_ACCESS_KEY_ID",
        secretAccessKeyEnv: "LILAC_S3_SECRET_ACCESS_KEY",
        sessionTokenEnv: "LILAC_S3_SESSION_TOKEN",
      },
    }).blobStorage;

    expect(blobStorage).toEqual({
      kind: "s3",
      bucket: "lilac",
      prefix: "production/blobs",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      accessKeyIdEnv: "LILAC_S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "LILAC_S3_SECRET_ACCESS_KEY",
      sessionTokenEnv: "LILAC_S3_SESSION_TOKEN",
      forcePathStyle: false,
    });
  });

  it("rejects invalid S3 values and literal credential fields", () => {
    const base = {
      kind: "s3",
      bucket: "lilac",
      prefix: "production/blobs",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      accessKeyIdEnv: "LILAC_S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "LILAC_S3_SECRET_ACCESS_KEY",
    };

    for (const blobStorage of [
      { ...base, endpoint: "ftp://s3.example.com" },
      { ...base, endpoint: "https://access-key:secret@s3.example.com" },
      { ...base, accessKeyIdEnv: "literal-access-key!" },
      { ...base, secretAccessKeyEnv: "not an env name" },
      { ...base, accessKeyId: "literal-access-key" },
      { ...base, secretAccessKey: "literal-secret" },
      { ...base, sessionToken: "literal-token" },
    ]) {
      expect(() => parseCoreConfigV2({ configVersion: 2, blobStorage })).toThrow();
    }
  });
});
