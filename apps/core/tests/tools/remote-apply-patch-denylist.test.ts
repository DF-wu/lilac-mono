import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { localApplyPatchTool } from "../../src/tools/apply-patch/local-apply-patch-tool";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) {
      last = chunk;
    }
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }

  return await value;
}

describe("apply_patch remote denylist", () => {
  it("rejects patching ~/.ssh when remote cwd is ~", async () => {
    const tools = localApplyPatchTool(process.cwd());
    const applyPatch = tools.apply_patch;

    const patchText = [
      "*** Begin Patch",
      "*** Add File: .ssh/config",
      "+Host example",
      "*** End Patch",
    ].join("\n");

    const res = await resolveExecuteResult(
      applyPatch.execute!(
        { patchText, cwd: "myhost:~" },
        {
          toolCallId: "ap-remote-deny-1",
          messages: [],
          abortSignal: undefined,
          context: {},
        },
      ),
    );

    expect(res.status).toBe("failed");
    expect(res.output ?? "").toContain("Access denied");
  });

  it("bypasses remote denylist precheck when dangerouslyAllow=true", async () => {
    const tools = localApplyPatchTool(process.cwd());
    const applyPatch = tools.apply_patch;

    const patchText = [
      "*** Begin Patch",
      "*** Add File: .ssh/config",
      "+Host example",
      "*** End Patch",
    ].join("\n");

    const res = await resolveExecuteResult(
      applyPatch.execute!(
        { patchText, cwd: "myhost:~", dangerouslyAllow: true },
        {
          toolCallId: "ap-remote-allow-1",
          messages: [],
          abortSignal: undefined,
          context: {},
        },
      ),
    );

    expect(res.status).toBe("failed");
    expect(res.output ?? "").not.toContain("Access denied");
  });

  it("does not mutate local files for an already-aborted tool call", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "lilac-apply-patch-cancel-"));
    try {
      const tools = localApplyPatchTool(cwd);
      const controller = new AbortController();
      controller.abort();
      const patchText = [
        "*** Begin Patch",
        "*** Add File: cancelled.txt",
        "+must not exist",
        "*** End Patch",
      ].join("\n");

      const res = await resolveExecuteResult(
        tools.apply_patch.execute!(
          { patchText },
          {
            toolCallId: "ap-cancelled",
            messages: [],
            abortSignal: controller.signal,
            context: {},
          },
        ),
      );

      expect(res.status).toBe("failed");
      await expect(readFile(path.join(cwd, "cancelled.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
