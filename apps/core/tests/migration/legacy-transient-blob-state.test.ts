import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  discardLegacyTransientState,
  inspectLegacyTransientState,
} from "../../scripts/legacy-transient-blob-state";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-blob-migration-transient-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const fallbackDir = path.join(root, "fallback");
  await fs.mkdir(path.join(dataDir, "tool-results"), { recursive: true });
  await fs.mkdir(fallbackDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "tool-results", "one.bin"), new Uint8Array([1, 2, 3]));
  await fs.writeFile(path.join(dataDir, "tool-results", "one.json"), "meta");
  await fs.writeFile(path.join(fallbackDir, "cache.bin"), new Uint8Array([4, 5]));
  return { dataDir, fallbackDir };
}

describe("legacy transient blob state", () => {
  it("reports discard counts without mutating either legacy root", async () => {
    const input = await fixture();
    const inspected = await inspectLegacyTransientState({
      dataDir: input.dataDir,
      anthropicFallbackCacheDir: input.fallbackDir,
    });

    const reports = inspected.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(reports).toEqual([
      { kind: "tool-result-artifacts", recordCount: 2, byteTotal: 7 },
      { kind: "anthropic-fallback-media", recordCount: 1, byteTotal: 2 },
    ]);
    expect(await fs.readFile(path.join(input.dataDir, "tool-results", "one.bin"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(await fs.readFile(path.join(input.fallbackDir, "cache.bin"))).toEqual(
      Buffer.from([4, 5]),
    );
  });

  it("removes both transient roots during apply", async () => {
    const input = await fixture();
    const discarded = await discardLegacyTransientState({
      dataDir: input.dataDir,
      anthropicFallbackCacheDir: input.fallbackDir,
    });

    discarded.match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    expect(await fs.exists(path.join(input.dataDir, "tool-results"))).toBe(false);
    expect(await fs.exists(input.fallbackDir)).toBe(false);
  });

  it("counts nested transient files before recursive deletion", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transient-state-"));
    const fallbackDir = path.join(dataDir, "fallback");
    roots.push(dataDir);
    await fs.mkdir(path.join(dataDir, "tool-results", "nested"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "tool-results", "nested", "artifact.bin"), "1234");

    const inspected = await inspectLegacyTransientState({
      dataDir,
      anthropicFallbackCacheDir: fallbackDir,
    });

    expect(inspected.status).toBe("ok");
    if (inspected.status === "ok") {
      expect(inspected.value[0]).toEqual({
        kind: "tool-result-artifacts",
        recordCount: 1,
        byteTotal: 4,
      });
    }
  });
});
