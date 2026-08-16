import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalizePathAsFarAsExists } from "@stanley2058/lilac-fs";

import { applyHunks, parsePatchResult } from "../../src/tools/apply-patch/apply-patch-core";

function parseValidPatch(patchText: string) {
  const parsed = parsePatchResult(patchText);
  if (parsed.status === "error") throw parsed.error;
  return parsed.value;
}

describe("apply_patch canonicalization failures", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-apply-patch-canonicalization-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves the filesystem error and does not apply a patch through a cyclic symlink", async () => {
    const cyclicPath = path.join(root, "cyclic");
    await symlink("cyclic", cyclicPath);
    const hunks = parseValidPatch(
      ["*** Begin Patch", "*** Add File: cyclic/created.txt", "+blocked", "*** End Patch"].join(
        "\n",
      ),
    );
    const canonical = await canonicalizePathAsFarAsExists(path.join(cyclicPath, "created.txt"));
    expect(canonical.status).toBe("error");
    if (canonical.status === "ok") return;

    await expect(
      applyHunks(root, hunks, { denyPaths: [path.join(root, "denied")] }),
    ).rejects.toThrow(canonical.error.message);
    await expect(readFile(path.join(cyclicPath, "created.txt"), "utf8")).rejects.toMatchObject({
      code: "ELOOP",
    });
  });

  it("denies descendants when the filesystem root is denied", async () => {
    const target = path.join(root, "created.txt");
    const hunks = parseValidPatch(
      ["*** Begin Patch", "*** Add File: created.txt", "+blocked", "*** End Patch"].join("\n"),
    );

    await expect(applyHunks(root, hunks, { denyPaths: [path.parse(root).root] })).rejects.toThrow(
      "Access denied",
    );
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
