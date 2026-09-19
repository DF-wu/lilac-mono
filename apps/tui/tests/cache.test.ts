import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskNativeCache } from "../src/cache";
import {
  decodeTuiCache,
  decodeTuiCredential,
  tuiCacheCodecCases,
  tuiCredentialCodecCases,
} from "../src/persistence-codec";
import type { CachePatch, CacheScope } from "@stanley2058/lilac-client";
const dirs: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "lilac-tui-cache-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const scope: CacheScope = {
  installationId: "fixture",
  principalId: "owner",
  protocolVersion: 1,
  projectionVersion: 1,
};
function patch(revision: number, replace = true): CachePatch {
  return {
    replace,
    checkpoint: {
      protocolVersion: 1,
      historyGeneration: 0,
      projectionRevision: revision,
      cursor: `cursor_${revision}`,
    },
    remove: [],
    put: [
      {
        revision,
        slot: {
          kind: "deferred",
          slotId: `slot_${revision}`,
          position: revision,
          endPosition: revision + 1,
        },
      },
    ],
  };
}
test("atomic cache preserves checkpoints and unresolved slots across processes", async () => {
  const dir = await directory();
  const cache = new DiskNativeCache(dir);
  await cache.commit(scope, "thread", patch(1));
  await cache.commit(scope, "thread", patch(2, false));
  const restored = await new DiskNativeCache(dir).read(scope, "thread");
  expect(restored?.checkpoint.projectionRevision).toBe(2);
  expect(restored?.slots.map((slot) => slot.slot.slotId)).toEqual(["slot_1", "slot_2"]);
  expect((await stat(join(dir, "cache-v1.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});
test("scope separation, concurrent commits, removal and logout purge", async () => {
  const cache = new DiskNativeCache(await directory());
  const other = { ...scope, principalId: "other" };
  await Promise.all([
    cache.commit(scope, "a", patch(1)),
    cache.commit(scope, "b", patch(2)),
    cache.commit(other, "a", patch(3)),
  ]);
  await cache.remove(scope, "b");
  expect(await cache.read(scope, "b")).toBeUndefined();
  await cache.purge(scope);
  expect(await cache.read(scope, "a")).toBeUndefined();
  expect((await cache.read(other, "a"))?.checkpoint.projectionRevision).toBe(3);
});
test("evicts whole threads without manufacturing partial coverage", async () => {
  const dir = await directory();
  const cache = new DiskNativeCache(dir, 1024, 1);
  await cache.commit(scope, "a", patch(1));
  await cache.commit(scope, "b", patch(2));
  expect(await cache.read(scope, "a")).toBeUndefined();
  expect(await cache.read(scope, "b")).toBeDefined();
  expect(Buffer.byteLength(await readFile(join(dir, "cache-v1.json"), "utf8"))).toBeLessThanOrEqual(
    1024,
  );
  const tiny = new DiskNativeCache(await directory(), 50);
  await tiny.commit(scope, "a", patch(1));
  expect(await tiny.read(scope, "a")).toBeUndefined();
});
test("invalid or truncated cache resets instead of replaying a torn cursor", async () => {
  const dir = await directory();
  await writeFile(join(dir, "cache-v1.json"), '{"entries":');
  const cache = new DiskNativeCache(dir);
  expect(await cache.read(scope, "a")).toBeUndefined();
  await cache.commit(scope, "a", patch(2, false));
  expect(await cache.read(scope, "a")).toBeUndefined();
  await cache.commit(scope, "a", patch(3));
  expect((await cache.read(scope, "a"))?.checkpoint.projectionRevision).toBe(3);
});
test("both persisted codecs reject all invalid compatibility cases", () => {
  for (const [name, entry] of Object.entries(tuiCacheCodecCases))
    expect(decodeTuiCache(entry.input).isOk()).toBe(name === "current");
  for (const [name, entry] of Object.entries(tuiCredentialCodecCases))
    expect(decodeTuiCredential(entry.input).isOk()).toBe(name === "current");
});

test("unsupported disk version resets and failed persistence reports an error", async () => {
  const dir = await directory();
  const path = join(dir, "cache-v1.json");
  await writeFile(path, JSON.stringify({ version: 2, entries: [] }));
  const cache = new DiskNativeCache(dir);
  expect(await cache.read(scope, "a")).toBeUndefined();
  await rm(path);
  await writeFile(join(dir, "blocked"), "fixture");
  const blocked = new DiskNativeCache(join(dir, "blocked"));
  await expect(blocked.commit(scope, "a", patch(1))).rejects.toThrow("Could not");
  await expect(blocked.purge(scope)).rejects.toThrow("Could not");
  await rm(join(dir, "blocked"));
  await blocked.commit(scope, "a", patch(2));
  expect((await blocked.read(scope, "a"))?.checkpoint.projectionRevision).toBe(2);
});
