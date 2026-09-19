import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, open, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystem } from "@stanley2058/lilac-fs";
import type { Result } from "better-result";
import { NativeStore } from "../../../src/surface/native/store";
import {
  NativeLiveFileService,
  rewriteNativePublishedFileLinks,
} from "../../../src/surface/native/resources-live";
function value<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("published paths read latest bytes, reject unpublished IDs, and honor filesystem deny paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-files-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  value(
    native.upsertUser({
      id: "outsider",
      providerId: "outsider",
      role: "participant",
      toolMode: "full",
      displayName: "Other",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "thread" }));
  const file = join(root, "notes.txt");
  await writeFile(file, "before");
  const reference = value(native.registerPublishedPath("owner", thread.id, file, root));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root, { denyPaths: [join(root, "private.txt")] }),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  expect(new TextDecoder().decode(value(await service.read("owner", reference.id)).bytes)).toBe(
    "before",
  );
  await writeFile(file, "after");
  expect(new TextDecoder().decode(value(await service.read("owner", reference.id)).bytes)).toBe(
    "after",
  );
  expect((await service.read("outsider", reference.id)).status).toBe("error");
  expect((await service.read("owner", file)).status).toBe("error");
  await writeFile(join(root, "private.txt"), "private");
  const denied = value(
    native.registerPublishedPath("owner", thread.id, join(root, "private.txt"), root),
  );
  expect((await service.read("owner", denied.id)).status).toBe("error");
  await rm(file);
  expect((await service.read("owner", reference.id)).status).toBe("error");
  native.close();
});

test("assistant file links publish stable authorized live previews without rewriting web URLs or code", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-links-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "thread" }));
  const path = join(root, "notes.txt");
  await writeFile(path, "latest");
  const original = `[Notes](${path}) [Site](https://example.com) \`[Code](/not-a-file)\``;
  const rewrite = () =>
    value(
      rewriteNativePublishedFileLinks({
        text: original,
        threadId: thread.id,
        actorId: "owner",
        cwd: root,
        register: (...args) => native.registerPublishedPath(...args),
      }),
    );
  const rewritten = rewrite();
  expect(rewrite()).toBe(rewritten);
  expect(rewritten).toContain("[Site](https://example.com)");
  expect(rewritten).toContain("`[Code](/not-a-file)`");
  const fileUrl = /\[Notes\]\(([^)]+)\)/u.exec(rewritten)?.[1];
  expect(fileUrl).toStartWith("/api/files/");
  const live = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const response = await live.handle(new Request(`http://local${fileUrl}`), "owner");
  expect(await response?.text()).toBe("latest");
  expect(response?.headers.get("content-disposition")).toStartWith("inline;");
  native.close();
});

test("text preview reads only a bounded prefix of a published file above the download limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-large-preview-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "large" }));
  const path = join(root, "large.txt");
  await using file = await open(path, "w");
  await file.write(Buffer.alloc(65_536, 97));
  await file.truncate(1_073_741_824);
  const reference = value(native.registerPublishedPath("owner", thread.id, path, root));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const response = await service.handle(
    new Request(`http://native/api/files/${reference.id}/preview`),
    "owner",
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    text: "a".repeat(65_536),
    byteLength: 1_073_741_824,
    truncated: true,
  });
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}`), "owner"))?.status,
  ).toBe(404);
  await file.write(Buffer.from([0]), 0, 1, 0);
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}/preview`), "owner"))
      ?.status,
  ).toBe(422);
  await rm(path);
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}/preview`), "owner"))
      ?.status,
  ).toBe(404);
  native.close();
});
