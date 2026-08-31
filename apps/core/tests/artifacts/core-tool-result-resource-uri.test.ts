import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  coreToolResultArtifactIdFromUri,
  createToolResultArtifactStore,
  legacyToolResultUri,
} from "../../src/artifacts/tool-result-artifact-store";
import { getTestBlobStore } from "../helpers/blob-store";

function value<T>(result: { status: "ok"; value: T } | { status: "error"; error: Error }): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

describe("Core transient resource URI adapter", () => {
  it("emits t1 URIs for every creation path and reads their legacy form", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-core-tool-result-uri-"));
    try {
      const sourcePath = path.join(root, "source.txt");
      await fs.writeFile(sourcePath, "from file");
      const store = createToolResultArtifactStore(
        path.join(root, "artifacts"),
        await getTestBlobStore(),
      );
      await store.init();
      const base = {
        scopeId: "scope-a",
        requestId: "request-a",
        toolName: "test",
        ttlMs: 60_000,
        maxBytesPerScope: 1024,
      };
      const created = [
        value(await store.create({ ...base, toolCallId: "text", content: "from text" })),
        value(await store.createFromFile({ ...base, toolCallId: "file", sourcePath })),
        value(
          await store.createFromStream({
            ...base,
            toolCallId: "stream",
            source: Readable.from(["from stream"]),
          }),
        ),
      ];

      for (const artifact of created) {
        expect(artifact.uri).toMatch(/^resource:\/\/t1_[0-9a-f]{32}$/u);
        expect(coreToolResultArtifactIdFromUri(artifact.uri)).toBe(artifact.id);
        expect(await store.read(legacyToolResultUri(artifact.uri), "scope-a")).toMatchObject({
          status: "ok",
          value: { id: artifact.id },
        });
      }
      expect(coreToolResultArtifactIdFromUri("resource://t1_bad")).toBeNull();
      expect(coreToolResultArtifactIdFromUri("tool-result://bad")).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
