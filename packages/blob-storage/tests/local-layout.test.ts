import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import type { Result } from "better-result";

import {
  BlobAdapterLayoutInvalid,
  BlobInvalidConfiguration,
  createLocalBlobStore,
  preflightLocalBlobStore,
} from "../src";
import { LocalBlobBackend } from "../src/local-backend";

function success<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

function failure<T, E>(result: Result<T, E>): E {
  return result.match({
    ok: () => {
      throw new Error("Expected an error Result");
    },
    err: (error) => error,
  });
}

test("local factory rejects relative roots and unmarked nonempty roots", async () => {
  expect(failure(await createLocalBlobStore({ root: "relative" }))).toBeInstanceOf(
    BlobInvalidConfiguration,
  );

  const root = await mkdtemp(path.join(tmpdir(), "lilac-blob-unmarked-"));
  await writeFile(path.join(root, "unrelated"), "do not adopt");
  expect(failure(await preflightLocalBlobStore({ root }))).toBeInstanceOf(BlobAdapterLayoutInvalid);
  expect(failure(await createLocalBlobStore({ root }))).toBeInstanceOf(BlobAdapterLayoutInvalid);
});

test("local preflight is read-only for an absent root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-preflight-"));
  const root = path.join(parent, "absent");
  const preflight = await preflightLocalBlobStore({ root });
  expect(preflight.match({ ok: (value) => value.status, err: () => "error" })).toBe("absent");
  expect(await Bun.file(root).exists()).toBe(false);
});

test("local preflight does not repair permissions on an existing layout", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-preflight-mode-"));
  const root = path.join(parent, "store");
  await createLocalBlobStore({ root });
  await chmod(root, 0o755);

  expect(
    (await preflightLocalBlobStore({ root })).match({
      ok: (value) => value.status,
      err: () => "error",
    }),
  ).toBe("ready");
  expect((await stat(root)).mode & 0o777).toBe(0o755);
});

test("local preflight rejects a non-directory or symlinked existing ancestor", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-ancestor-"));
  const file = path.join(parent, "file");
  await writeFile(file, "not a directory");
  expect(failure(await preflightLocalBlobStore({ root: path.join(file, "child") }))).toBeInstanceOf(
    BlobAdapterLayoutInvalid,
  );

  const target = await mkdtemp(path.join(tmpdir(), "lilac-blob-ancestor-target-"));
  const link = path.join(parent, "link");
  await symlink(target, link);
  expect(
    failure(await preflightLocalBlobStore({ root: path.join(link, "missing") })),
  ).toBeInstanceOf(BlobAdapterLayoutInvalid);
  const realBelowLink = path.join(target, "real");
  await mkdir(realBelowLink);
  expect(
    failure(
      await preflightLocalBlobStore({
        root: path.join(link, "real", "missing"),
      }),
    ),
  ).toBeInstanceOf(BlobAdapterLayoutInvalid);
});

test("local runtime rejects replacement of its configured root with a symlink", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-root-swap-"));
  const root = path.join(parent, "store");
  const store = (await createLocalBlobStore({ root })).match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
  const moved = path.join(parent, "moved-store");
  const outside = await mkdtemp(path.join(tmpdir(), "lilac-blob-swap-outside-"));
  await rename(root, moved);
  await symlink(outside, root);

  expect(
    failure(
      await store.startUpload({
        source: new Uint8Array([1]),
        retention: { kind: "durable" },
      }),
    )._tag,
  ).toBe("BlobUploadReservationFailed");
  expect(await readdir(outside)).toEqual([]);
});

test("local initialization removes an abandoned temporary object", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-restart-"));
  const root = path.join(parent, "store");
  await createLocalBlobStore({ root });
  const temporary = path.join(
    root,
    "temporary",
    `b1_${"a".repeat(32)}.00000000-0000-4000-8000-000000000000`,
  );
  await writeFile(temporary, "abandoned", { mode: 0o600 });

  await createLocalBlobStore({ root });
  expect(await Bun.file(temporary).exists()).toBe(false);
});

test("local layout rejects unsupported markers and symlink traversal", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "lilac-blob-layout-"));
  await createLocalBlobStore({ root: first });
  await writeFile(path.join(first, "layout.json"), '{"version":999}\n');
  expect(failure(await createLocalBlobStore({ root: first }))).toBeInstanceOf(
    BlobAdapterLayoutInvalid,
  );

  const second = await mkdtemp(path.join(tmpdir(), "lilac-blob-symlink-"));
  await writeFile(path.join(second, "layout.json"), '{"version":1,"name":"lilac-blob-storage"}\n');
  await mkdir(path.join(second, "reservations"), { mode: 0o700 });
  await mkdir(path.join(second, "temporary"), { mode: 0o700 });
  await mkdir(path.join(second, "expiry"), { mode: 0o700 });
  const outside = await mkdtemp(path.join(tmpdir(), "lilac-blob-outside-"));
  await symlink(outside, path.join(second, "content"));
  expect(failure(await createLocalBlobStore({ root: second }))).toBeInstanceOf(
    BlobAdapterLayoutInvalid,
  );
  expect(await readFile(path.join(second, "layout.json"), "utf8")).toContain("lilac-blob-storage");
  expect((await stat(outside)).isDirectory()).toBe(true);

  const third = await mkdtemp(path.join(tmpdir(), "lilac-blob-marker-link-"));
  const externalMarker = path.join(outside, "external-layout.json");
  await writeFile(externalMarker, '{"version":1,"name":"lilac-blob-storage"}\n');
  await symlink(externalMarker, path.join(third, "layout.json"));
  expect(failure(await preflightLocalBlobStore({ root: third }))).toBeInstanceOf(
    BlobAdapterLayoutInvalid,
  );
});

test("local reservation compare-and-swap has one cross-instance winner", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-local-cas-"));
  const root = path.join(parent, "store");
  const first = new LocalBlobBackend(root);
  const second = new LocalBlobBackend(root);
  success(await first.initialize({ createIfMissing: true }));
  success(await second.initialize({ createIfMissing: false }));
  const objectId = `b1_${"a".repeat(32)}`;
  const pending = '{"state":"pending"}\n';
  const ready = '{"state":"ready"}\n';
  const interrupted = '{"state":"interrupted"}\n';
  success(await first.createReservation(objectId, pending));

  const outcomes = await Promise.all([
    first.compareAndSwapReservation(objectId, pending, ready),
    second.compareAndSwapReservation(objectId, pending, interrupted),
  ]);
  expect(outcomes.map(success).filter(Boolean)).toHaveLength(1);
  const observed = success(await first.readReservation(objectId));
  expect(observed).not.toBeNull();
  expect([ready, interrupted].includes(observed ?? "")).toBe(true);
});
