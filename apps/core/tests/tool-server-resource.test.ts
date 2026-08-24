import { describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Panic, Result } from "better-result";

import {
  ResourceAlreadyExists,
  ResourceCancelled,
  ResourceInvalidUri,
  ResourceTooLarge,
  type MaterializedResource,
  type ResourceAccess,
} from "../src/resource";
import { resolveRestrictedSessionTmpDir } from "../src/shared/attachment-utils";
import { Resource } from "../src/tool-server/tools/resource";
import { bindRequestInvocationCwd } from "../src/tool-server/request-invocation-cwd";

const URIS = [
  "resource://r1_00000000000000000000000000000001",
  "resource://r1_00000000000000000000000000000002",
  "resource://r1_00000000000000000000000000000003",
  "resource://r1_00000000000000000000000000000004",
] as const;

function fakeAccess(materialize: ResourceAccess["materialize"]): ResourceAccess {
  return { materialize } as ResourceAccess;
}

function materialized(uri: string, targetDirectory: string, bytes: number): MaterializedResource {
  const filename = `${uri.slice(-2)}.txt`;
  return {
    uri: uri as MaterializedResource["uri"],
    path: path.join(targetDirectory, filename),
    filename,
    mimeType: "text/plain",
    bytes,
    sha256: uri.slice(-1).repeat(64),
  };
}

async function callValue(
  tool: Resource,
  input: Record<string, unknown>,
  options?: Parameters<Resource["call"]>[2],
): Promise<unknown> {
  const result = await tool.call("resource.materialize", input, options);
  return result.match({
    ok: (value) => value,
    err: (error) => ({ failure: error }),
  });
}

describe("tool-server resource", () => {
  it("advertises resource URIs as a variadic primary positional input", async () => {
    const tool = new Resource({
      access: fakeAccess(async () => Result.ok(materialized(URIS[0], "/tmp", 1))),
    });

    const entry = (await tool.list()).find(
      (candidate) => candidate.callableId === "resource.materialize",
    );

    expect(entry?.primaryPositional).toEqual({ field: "uris", variadic: true });
    expect(entry?.hidden).not.toBe(true);
  });

  it("preserves mixed item outcomes and input order", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-tool-"));
    try {
      const tool = new Resource({
        access: fakeAccess(async (uri, options) => {
          if (uri === URIS[1]) {
            return Result.err(new ResourceInvalidUri({ uri, message: "invalid resource URI" }));
          }
          if (uri === URIS[3]) {
            return Result.err(
              new ResourceAlreadyExists({
                uri,
                path: path.join(options.targetDirectory, "exists.txt"),
                message: "resource destination already exists",
              }),
            );
          }
          return Result.ok(materialized(uri, options.targetDirectory, 2));
        }),
      });

      const value = await callValue(
        tool,
        { uris: [...URIS] },
        { context: { cwd, safetyMode: "trusted" } },
      );

      expect(value).toMatchObject({
        results: [
          { uri: URIS[0], status: "ok", bytes: 2 },
          { uri: URIS[1], status: "error", error: { code: "invalid_uri" } },
          { uri: URIS[2], status: "ok", bytes: 2 },
          { uri: URIS[3], status: "error", error: { code: "already_exists" } },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("passes the remaining actual-byte budget to every item and continues after batch_limit", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-tool-"));
    const observedLimits: number[] = [];
    try {
      const tool = new Resource({
        limits: { materializeCallMaxBytes: 5 },
        access: fakeAccess(async (uri, options) => {
          observedLimits.push(options.maxBytes);
          if (uri === URIS[1]) {
            return Result.err(
              new ResourceTooLarge({
                uri,
                limit: options.maxBytes,
                limitKind: "operation",
                observedBytes: options.maxBytes + 1,
                message: "remaining batch limit exceeded",
              }),
            );
          }
          return Result.ok(materialized(uri, options.targetDirectory, uri === URIS[0] ? 4 : 1));
        }),
      });

      const value = await callValue(
        tool,
        { uris: URIS.slice(0, 3) },
        { context: { cwd, safetyMode: "trusted" } },
      );

      expect(observedLimits).toEqual([5, 1, 1]);
      expect(value).toMatchObject({
        results: [
          { status: "ok", bytes: 4 },
          { status: "error", error: { code: "batch_limit" } },
          { status: "ok", bytes: 1 },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("materializes into the tools CLI cwd while retaining the capability cwd", async () => {
    const capabilityCwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-capability-"));
    const invocationCwd = path.join(capabilityCwd, "nested", "working-directory");
    let receivedTarget: string | undefined;
    try {
      await fs.mkdir(invocationCwd, { recursive: true });
      const tool = new Resource({
        access: fakeAccess(async (uri, options) => {
          receivedTarget = options.targetDirectory;
          return Result.ok(materialized(uri, options.targetDirectory, 3));
        }),
      });
      const context = {
        cwd: capabilityCwd,
        safetyMode: "trusted" as const,
      };
      bindRequestInvocationCwd(context, invocationCwd);

      const value = await callValue(tool, { uris: [URIS[0]] }, { context });

      expect(receivedTarget).toBe(invocationCwd);
      expect(value).toMatchObject({
        results: [{ status: "ok", path: path.join(invocationCwd, "01.txt") }],
      });
    } finally {
      await fs.rm(capabilityCwd, { recursive: true, force: true });
    }
  });

  it("maps a restricted tools CLI tmp cwd into the matching session-private directory", async () => {
    const sessionId = "resource-restricted-session";
    const physicalTmp = resolveRestrictedSessionTmpDir(sessionId);
    const invocationCwd = "/tmp/nested/working-directory";
    let receivedTarget: string | undefined;
    try {
      const tool = new Resource({
        access: fakeAccess(async (uri, options) => {
          receivedTarget = options.targetDirectory;
          return Result.ok(materialized(uri, options.targetDirectory, 3));
        }),
      });
      const context = {
        cwd: "/workspace",
        sessionId,
        safetyMode: "restricted" as const,
      };
      bindRequestInvocationCwd(context, invocationCwd);

      const value = await callValue(tool, { uris: [URIS[0]] }, { context });

      expect(receivedTarget).toBe(path.join(physicalTmp, "nested", "working-directory"));
      expect(value).toMatchObject({
        results: [{ status: "ok", path: "/tmp/nested/working-directory/01.txt" }],
      });
    } finally {
      await fs.rm(physicalTmp, { recursive: true, force: true });
    }
  });

  it("rejects a restricted tools CLI cwd outside its private tmp mapping", async () => {
    let materializeCalls = 0;
    const tool = new Resource({
      access: fakeAccess(async (uri, options) => {
        materializeCalls += 1;
        return Result.ok(materialized(uri, options.targetDirectory, 3));
      }),
    });
    const context = {
      cwd: "/canonical/workspace",
      sessionId: "resource-restricted-outside-tmp",
      safetyMode: "restricted" as const,
    };
    bindRequestInvocationCwd(context, "/workspace/project");

    const value = await callValue(tool, { uris: [URIS[0]] }, { context });

    expect(materializeCalls).toBe(0);
    expect(value).toMatchObject({
      failure: { kind: "denied", code: "resource_target_denied" },
    });
  });

  it("returns a call-level failure when request cwd is missing", async () => {
    const tool = new Resource({
      access: fakeAccess(async () => Result.ok(materialized(URIS[0], "/tmp", 1))),
    });

    const value = await callValue(tool, { uris: [URIS[0]] });

    expect(value).toMatchObject({
      failure: { kind: "usage", code: "resource_context_missing" },
    });
  });

  it("maps ordinary target-directory failures without swallowing Panic", async () => {
    const tool = new Resource({
      access: fakeAccess(async () => Result.ok(materialized(URIS[0], "/tmp", 1))),
    });
    const missing = path.join(os.tmpdir(), `missing-resource-target-${randomUUID()}`);

    const unavailable = await callValue(
      tool,
      { uris: [URIS[0]] },
      { context: { cwd: missing, safetyMode: "trusted" } },
    );
    expect(unavailable).toMatchObject({
      failure: { kind: "denied", code: "resource_target_unavailable" },
    });

    const panic = new Panic({ message: "resource target invariant failed" });
    const stat = spyOn(fs, "stat").mockRejectedValue(panic);
    try {
      await expect(
        tool.call(
          "resource.materialize",
          { uris: [URIS[0]] },
          { context: { cwd: os.tmpdir(), safetyMode: "trusted" } },
        ),
      ).rejects.toBe(panic);
    } finally {
      stat.mockRestore();
    }
  });

  it("marks the active and remaining items cancelled without starting more I/O", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-tool-"));
    const controller = new AbortController();
    const calls: string[] = [];
    try {
      const tool = new Resource({
        access: fakeAccess(async (uri) => {
          calls.push(uri);
          controller.abort();
          return Result.err(new ResourceCancelled({ uri, message: "cancelled" }));
        }),
      });

      const value = await callValue(
        tool,
        { uris: URIS.slice(0, 3) },
        {
          context: { cwd, safetyMode: "trusted" },
          signal: controller.signal,
        },
      );

      expect(calls).toEqual([URIS[0]]);
      expect(value).toMatchObject({
        results: [
          { uri: URIS[0], error: { code: "cancelled" } },
          { uri: URIS[1], error: { code: "cancelled" } },
          { uri: URIS[2], error: { code: "cancelled" } },
        ],
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("enforces an injected item-count limit before materialization", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-tool-"));
    let calls = 0;
    try {
      const tool = new Resource({
        limits: { materializeMaxCount: 2 },
        access: fakeAccess(async (uri, options) => {
          calls += 1;
          return Result.ok(materialized(uri, options.targetDirectory, 1));
        }),
      });

      const value = await callValue(
        tool,
        { uris: URIS.slice(0, 3) },
        { context: { cwd, safetyMode: "trusted" } },
      );

      expect(calls).toBe(0);
      expect(value).toMatchObject({ failure: { code: "invalid_input" } });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
