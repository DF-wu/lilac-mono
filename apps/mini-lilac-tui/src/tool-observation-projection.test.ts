import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import { MINI_LILAC_TOOL_NAMES } from "@stanley2058/mini-lilac-client";

import {
  KnownToolObservationMalformed,
  decodeKnownToolObservation,
  projectToolObservation,
  type ToolObservation,
  type ToolProjection,
} from "./tool-observation-projection";

type KnownToolName = (typeof MINI_LILAC_TOOL_NAMES)[number];

function success(toolName: string, input: unknown, output: unknown = {}): ToolObservation {
  return { toolName, lifecycle: "success", input, output };
}

function editSuccess(replacementsMade = 1) {
  return {
    success: true as const,
    resolvedPath: "/workspace/src/a.ts",
    oldHash: "old-hash",
    newHash: "new-hash",
    changesMade: replacementsMade > 0,
    replacementsMade,
  };
}

describe("tool observation catalog", () => {
  it("projects every catalog member into its deliberate closed variant", () => {
    const fixtures = [
      ["bash", success("bash", { command: "pwd" }, "/workspace"), "bash", "$ pwd"],
      ["read", success("read", { path: "src/app.ts" }), "exploration", "Read src/app.ts"],
      ["glob", success("glob", { patterns: ["**/*.ts"] }), "exploration", "Glob **/*.ts"],
      ["grep", success("grep", { pattern: "TODO" }), "exploration", 'Grep "TODO"'],
      [
        "fuzzy_search",
        success("fuzzy_search", { query: "app config" }),
        "exploration",
        'Find "app config"',
      ],
      [
        "edit",
        success("edit", { path: "src/a.ts", oldText: "old", newText: "new\nnext" }, editSuccess()),
        "edit",
        "Edit src/a.ts +2 -1",
      ],
      [
        "patch",
        success("patch", {
          patchText: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
        }),
        "edit",
        "Patch src/a.ts +1 -1",
      ],
      [
        "subagent_delegate",
        success(
          "subagent_delegate",
          { profile: "explore", prompt: "Trace routing", mode: "sync" },
          {
            status: "completed",
            childRunId: "child-1",
            childSessionId: "session-1",
            sessionName: "research",
            profile: "explore",
            text: "Done",
          },
        ),
        "subagent-delegate",
        "Explore: Trace routing",
      ],
      [
        "subagent_result",
        success(
          "subagent_result",
          { childRunId: "child-1", profile: "explore" },
          {
            status: "completed",
            childRunId: "child-1",
            childSessionId: "session-1",
            sessionName: "research",
            profile: "explore",
            text: "Done",
          },
        ),
        "subagent-result",
        "Subagent Result",
      ],
      ["batch", success("batch", { tool_calls: [{ tool: "bash" }] }), "batch", "Batch 1 tool"],
      ["skill", success("skill", { name: "frontend-design" }), "skill", "Skill frontend-design"],
      [
        "todowrite",
        success("todowrite", {
          todos: [
            { content: "Implement", status: "in_progress", priority: "high" },
            { content: "Verify", status: "pending", priority: "medium" },
          ],
        }),
        "todo",
        "Update todos: 2 items",
      ],
      [
        "webfetch",
        success("webfetch", { url: "https://example.test" }),
        "webfetch",
        "Fetch https://example.test",
      ],
      [
        "websearch",
        success("websearch", { query: "latest   runtime\nrelease" }),
        "websearch",
        'Search "latest runtime release"',
      ],
    ] as const satisfies readonly [
      KnownToolName,
      ToolObservation,
      ToolProjection["kind"],
      string,
    ][];

    expect(fixtures.map(([toolName]) => toolName)).toEqual([...MINI_LILAC_TOOL_NAMES]);
    for (const [toolName, observation, kind, summary] of fixtures) {
      const projection = projectToolObservation(observation);
      expect(projection.toolName).toBe(toolName);
      expect(projection.kind).toBe(kind);
      expect(projection.summary).toBe(summary);
      expect(projection.lifecycle).toBe("success");
      expect(projection.state.status).toBe("success");
      expect(projection).not.toHaveProperty("input");
      expect(projection).not.toHaveProperty("output");
      expect(projection).not.toHaveProperty("partial");
    }
  });
});

describe("known tool decoding", () => {
  it("turns hostile input and output reflection into owned malformed errors", () => {
    const revokedInputs = MINI_LILAC_TOOL_NAMES.map((toolName) => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return { toolName, lifecycle: "active", input: revocable.proxy } satisfies ToolObservation;
    });

    for (const observation of revokedInputs) {
      const decoded = decodeKnownToolObservation(observation);
      expect(decoded.status).toBe("error");
      expect(() => projectToolObservation(observation)).not.toThrow();
      expect(projectToolObservation(observation)).toMatchObject({
        kind: "malformed-known-tool",
        malformedField: "input",
      });
    }

    const hostileOutputFixtures = [
      ["bash", { command: "pwd" }],
      ["edit", { path: "a.ts", oldText: "old", newText: "new" }],
      ["subagent_delegate", { profile: "explore", prompt: "Inspect", mode: "sync" }],
      ["subagent_result", { childRunId: "child-1", profile: "explore" }],
      ["websearch", {}],
    ] as const;
    for (const [toolName, input] of hostileOutputFixtures) {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      const projection = projectToolObservation(success(toolName, input, revocable.proxy));
      expect(projection).toMatchObject({
        kind: "malformed-known-tool",
        malformedField: "output",
      });
    }
  });

  it("preserves Panic thrown during schema reflection", () => {
    const panic = new Panic({ message: "tool decoder invariant" });
    const input = Object.create(null, {
      command: {
        enumerable: true,
        get: () => {
          throw panic;
        },
      },
    });
    const observation = {
      toolName: "bash" as const,
      lifecycle: "active" as const,
      input,
    };

    expect(() => decodeKnownToolObservation(observation)).toThrow(panic);
    expect(() => projectToolObservation(observation)).toThrow(panic);
  });

  it("rejects incomplete edit, batch, Bash, and subagent contract envelopes", () => {
    const malformedObservations = [
      success("edit", { path: "a.ts" }, { replacementsMade: 1 }),
      success("batch", { tool_calls: [] }),
      success("batch", { tool_calls: [{ tool: "", parameters: {} }] }),
      success("bash", { command: "pwd" }, { stdout: "pwd", stderr: "", exitCode: 0 }),
      success(
        "subagent_delegate",
        { profile: "explore", prompt: "Inspect", mode: "sync" },
        { status: "completed", text: "Done" },
      ),
      success(
        "subagent_result",
        { childRunId: "child-1", profile: "explore" },
        { status: "completed", text: "Done" },
      ),
    ];

    for (const observation of malformedObservations) {
      expect(projectToolObservation(observation).kind).toBe("malformed-known-tool");
    }
  });

  it("accepts the current Bash truncation envelope", () => {
    expect(
      projectToolObservation(
        success(
          "bash",
          { command: "large-output" },
          {
            stdout: "preview",
            stderr: "",
            exitCode: 0,
            stdoutTruncated: true,
            stderrTruncated: false,
            truncation: {
              artifactUri: "tool-result://bash/output",
              artifactBytes: 10_000,
              message: "Output truncated",
              originalStdoutBytes: 10_000,
              originalStderrBytes: 0,
              previewBytes: 7,
              completeOutputRetained: true,
              retentionStatus: "retained",
            },
          },
        ),
      ),
    ).toMatchObject({ kind: "bash", resultText: "preview" });
  });

  it("projects exact edit results and turns filesystem failures into tool errors", () => {
    const input = { path: "src/a.ts", oldText: "old", newText: "new" };
    expect(projectToolObservation(success("edit", input, editSuccess(2)))).toMatchObject({
      kind: "edit",
      state: { status: "success" },
      operations: [{ added: 2, removed: 2 }],
    });

    expect(
      projectToolObservation(
        success("edit", input, {
          success: false,
          resolvedPath: "/workspace/src/a.ts",
          currentHash: "current-hash",
          error: { code: "NO_MATCHES", message: "Target text was not found" },
          errors: [
            {
              code: "NO_MATCHES",
              message: "Target text was not found",
              editIndex: 0,
              edit: {
                type: "replace_snippet",
                target: "old",
                newText: "new",
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      kind: "edit",
      state: { status: "error", errorText: "Target text was not found" },
      headline: "Edit src/a.ts: Target text was not found",
      operations: [{ added: 0, removed: 0 }],
    });

    for (const output of [
      {},
      { replacementsMade: 1 },
      { success: true, replacementsMade: 1 },
      {
        success: false,
        resolvedPath: "/workspace/src/a.ts",
        error: { code: "NOT_REAL", message: "bad" },
      },
    ]) {
      expect(projectToolObservation(success("edit", input, output))).toMatchObject({
        kind: "malformed-known-tool",
        malformedField: "output",
      });
    }
  });

  it("uses exact read, skill, and todo constraints", () => {
    expect(
      projectToolObservation(success("read", { path: "a.ts", maxCharacters: 40_960 })),
    ).toMatchObject({ kind: "exploration" });
    expect(
      projectToolObservation(success("read", { path: "a.ts", maxCharacters: 40_961 })),
    ).toMatchObject({ kind: "malformed-known-tool", malformedField: "input" });

    expect(projectToolObservation(success("skill", { name: "frontend-design" }))).toMatchObject({
      kind: "skill",
    });
    for (const name of ["Frontend", "two_words", "x".repeat(65)]) {
      expect(projectToolObservation(success("skill", { name }))).toMatchObject({
        kind: "malformed-known-tool",
      });
    }

    expect(
      projectToolObservation(
        success("todowrite", {
          todos: [{ content: "", status: "cancelled", priority: "low" }],
        }),
      ),
    ).toMatchObject({ kind: "todo", todoCount: 1 });
    expect(
      projectToolObservation(
        success("todowrite", {
          todos: [
            { content: "First", status: "in_progress", priority: "high" },
            { content: "Second", status: "in_progress", priority: "low" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "malformed-known-tool", malformedField: "input" });

    const oversizedTodos = Array.from({ length: 50 }, (_, index) => ({
      content: `${index}-${"\u754c".repeat(497)}`,
      status: "pending",
      priority: "medium",
    }));
    expect(projectToolObservation(success("todowrite", { todos: oversizedTodos }))).toMatchObject({
      kind: "malformed-known-tool",
      malformedField: "input",
    });
  });

  it("uses the shared credential-safe webfetch URL contract", () => {
    expect(
      projectToolObservation(success("webfetch", { url: "  https://example.test/path  " })),
    ).toMatchObject({
      kind: "webfetch",
      url: "https://example.test/path",
    });

    for (const url of [
      "ftp://example.test/file",
      "https://user:secret@example.test/path",
      `https://example.test/${"x".repeat(2_048)}`,
    ]) {
      const projection = projectToolObservation(success("webfetch", { url }));
      expect(projection).toMatchObject({
        kind: "malformed-known-tool",
        malformedField: "input",
        payloadPreview: "<object>",
      });
      expect(JSON.stringify(projection)).not.toContain("user:secret");
    }
  });

  it("returns an owned Result error and recovers only at projectToolObservation", () => {
    const observation = {
      toolName: "bash" as const,
      lifecycle: "error" as const,
      input: { command: 42, secret: "must not escape" },
      errorText: "command must be a string",
    };

    const decoded = decodeKnownToolObservation(observation);
    expect(decoded.status).toBe("error");
    if (decoded.status !== "error") throw new Error("expected malformed known observation");
    expect(decoded.error).toBeInstanceOf(KnownToolObservationMalformed);
    expect(decoded.error).toMatchObject({
      _tag: "KnownToolObservationMalformed",
      toolName: "bash",
      lifecycle: "error",
      field: "input",
      payloadPreview: "<object>",
    });

    const projection = projectToolObservation(observation);
    expect(projection).toMatchObject({
      kind: "malformed-known-tool",
      toolName: "bash",
      lifecycle: "error",
      tone: "danger",
      headline: "Bash: command must be a string",
      malformedField: "input",
      payloadPreview: "<object>",
    });
    expect(JSON.stringify(projection)).not.toContain("must not escape");
  });

  it("keeps native web search output fallback semantics", () => {
    expect(
      projectToolObservation(
        success(
          "websearch",
          {},
          { action: { type: "search", query: "latest   runtime\nrelease" } },
        ),
      ),
    ).toMatchObject({
      kind: "websearch",
      query: "latest runtime release",
      summary: 'Search "latest runtime release"',
    });
  });
});

describe("projection lifecycle", () => {
  it("covers every lifecycle state with explicit presentation semantics", () => {
    const observations = [
      { toolName: "webfetch", lifecycle: "pending" },
      { toolName: "webfetch", lifecycle: "active", input: { url: "https://example.test" } },
      { toolName: "webfetch", lifecycle: "approval", input: { url: "https://example.test" } },
      success("webfetch", { url: "https://example.test" }),
      {
        toolName: "webfetch",
        lifecycle: "error",
        input: { url: "https://example.test" },
        errorText: "fetch failed",
      },
      { toolName: "webfetch", lifecycle: "denied", input: { url: "https://example.test" } },
      {
        toolName: "webfetch",
        lifecycle: "cancelled",
        input: { url: "https://example.test" },
        reason: "user stopped",
      },
    ] satisfies readonly ToolObservation[];

    expect(
      observations.map((observation) => {
        const projection = projectToolObservation(observation);
        return {
          status: projection.state.status,
          tone: projection.tone,
          running: projection.running,
          headline: projection.headline,
        };
      }),
    ).toEqual([
      { status: "pending", tone: "accent", running: true, headline: "Webfetch · running" },
      {
        status: "active",
        tone: "accent",
        running: true,
        headline: "Fetch https://example.test · running",
      },
      {
        status: "approval",
        tone: "warning",
        running: true,
        headline: "Fetch https://example.test · awaiting approval",
      },
      {
        status: "success",
        tone: "success",
        running: false,
        headline: "Fetch https://example.test",
      },
      {
        status: "error",
        tone: "danger",
        running: false,
        headline: "Fetch https://example.test: fetch failed",
      },
      {
        status: "denied",
        tone: "warning",
        running: false,
        headline: "Fetch https://example.test: denied",
      },
      {
        status: "cancelled",
        tone: "muted",
        running: false,
        headline: "Fetch https://example.test: cancelled (user stopped)",
      },
    ]);
  });

  it("preserves Bash partial deltas and terminal execution states", () => {
    const active = projectToolObservation({
      toolName: "bash",
      lifecycle: "active",
      input: { command: "bun test" },
      partial: { type: "output-delta", delta: "pass\n" },
    });
    expect(active).toMatchObject({
      kind: "bash",
      command: "bun test",
      outputDelta: "pass\n",
      running: true,
    });

    expect(
      projectToolObservation({
        toolName: "bash",
        lifecycle: "success",
        input: { command: "bun test" },
        output: { futureShape: true },
        partial: { type: "output-delta", delta: "pass\n" },
      }),
    ).toMatchObject({
      kind: "bash",
      resultText: "pass",
      outputDelta: "pass\n",
      state: { status: "success" },
    });

    const failed = projectToolObservation(
      success(
        "bash",
        { command: "false" },
        {
          stdout: "",
          stderr: "",
          exitCode: -1,
          stdoutTruncated: false,
          stderrTruncated: false,
          executionError: { type: "blocked", reason: "unsafe" },
        },
      ),
    );
    expect(failed).toMatchObject({ kind: "bash", tone: "danger", resultText: "unsafe" });

    expect(
      projectToolObservation({
        toolName: "bash",
        lifecycle: "error",
        input: { command: "false" },
        errorText: '{"stderr":"large raw result"}',
      }),
    ).toMatchObject({ kind: "bash", tone: "danger", resultText: "Command failed" });

    expect(
      projectToolObservation({
        toolName: "bash",
        lifecycle: "denied",
        input: { command: "rm -rf /" },
      }),
    ).toMatchObject({ kind: "bash", tone: "warning", resultText: "Denied" });

    const cancelled = projectToolObservation({
      toolName: "bash",
      lifecycle: "cancelled",
      input: { command: "long-task" },
      reason: "interrupted",
      partial: { type: "output-delta", delta: "partial\n" },
    });
    expect(cancelled).toMatchObject({
      kind: "bash",
      tone: "muted",
      outputDelta: "partial\n",
      resultText: "Cancelled: interrupted",
      headline: "$ long-task: cancelled (interrupted)",
    });
  });

  it("derives subagent lifecycle from delegate results", () => {
    expect(
      projectToolObservation(
        success(
          "subagent_delegate",
          { profile: "explore", prompt: "Trace routing", mode: "deferred" },
          {
            status: "accepted",
            childRunId: "child-1",
            childSessionId: "session-1",
            sessionName: "research",
            profile: "explore",
            mode: "deferred",
          },
        ),
      ),
    ).toMatchObject({
      kind: "subagent-delegate",
      lifecycle: "success",
      state: { status: "active" },
      running: true,
      tone: "accent",
    });

    expect(
      projectToolObservation(
        success(
          "subagent_delegate",
          { profile: "explore", prompt: "Trace routing" },
          { status: "rejected", reason: "maximum depth" },
        ),
      ),
    ).toMatchObject({
      kind: "subagent-delegate",
      state: { status: "error", errorText: "maximum depth" },
      error: "maximum depth",
      running: false,
      tone: "danger",
    });
  });

  it("maps exploration, edit, subagent, and batch terminal semantics", () => {
    expect(
      projectToolObservation(
        {
          toolName: "read",
          lifecycle: "error",
          input: { path: "/workspace/src/app.ts", start: { offset: 4 }, maxLines: 12 },
          errorText: "file missing",
        },
        { cwd: "/workspace" },
      ),
    ).toMatchObject({
      kind: "exploration",
      action: "Read",
      detail: "src/app.ts · offset 4 · 12 lines",
      operationStatus: "error",
      error: "file missing",
      tone: "danger",
    });

    expect(
      projectToolObservation(
        {
          toolName: "patch",
          lifecycle: "denied",
          input: {
            patchText:
              "*** Begin Patch\n*** Update File: /workspace/src/app.ts\n-old\n+new\n*** End Patch",
          },
        },
        { cwd: "/workspace" },
      ),
    ).toMatchObject({
      kind: "edit",
      operations: [{ action: "Patch", path: "src/app.ts", added: 1, removed: 1 }],
      tone: "warning",
      headline: "Patch src/app.ts +1 -1: denied",
    });

    expect(
      projectToolObservation({
        toolName: "subagent_delegate",
        lifecycle: "cancelled",
        input: { profile: "explore", prompt: "Trace routing", mode: "deferred" },
        reason: "run aborted",
      }),
    ).toMatchObject({
      kind: "subagent-delegate",
      profile: "explore",
      prompt: "Trace routing",
      mode: "deferred",
      tone: "muted",
    });

    expect(
      projectToolObservation({
        toolName: "batch",
        lifecycle: "error",
        input: { tool_calls: [] },
        errorText: "child failed",
      }),
    ).toMatchObject({
      kind: "malformed-known-tool",
      toolName: "batch",
      malformedField: "input",
    });
    expect(projectToolObservation(success("batch", { tool_calls: [] }))).toMatchObject({
      kind: "malformed-known-tool",
      toolName: "batch",
    });
    expect(
      projectToolObservation(
        success(
          "subagent_result",
          { childRunId: "child-1", profile: "explore" },
          {
            status: "completed",
            childRunId: "child-1",
            childSessionId: "session-1",
            sessionName: "research",
            profile: "explore",
            text: "Done",
          },
        ),
      ),
    ).toMatchObject({
      kind: "subagent-result",
      visibility: "hidden",
    });
  });

  it("normalizes legacy persisted tool names before projection", () => {
    expect(projectToolObservation(success("read_file", { path: "legacy.ts" }))).toMatchObject({
      kind: "exploration",
      toolName: "read",
      action: "Read",
      summary: "Read legacy.ts",
    });
    expect(
      projectToolObservation(
        success("apply_patch", {
          patchText: "*** Begin Patch\n*** Update File: legacy.ts\n-old\n+new\n*** End Patch",
        }),
      ),
    ).toMatchObject({ kind: "edit", toolName: "patch", summary: "Patch legacy.ts +1 -1" });
    expect(
      projectToolObservation(
        success("edit_file", { path: "legacy.ts", oldText: "old", newText: "new" }, editSuccess()),
      ),
    ).toMatchObject({ kind: "edit", toolName: "edit", summary: "Edit legacy.ts +1 -1" });
  });
});

describe("safe fallbacks", () => {
  it("bounds unknown names and payload previews without touching object properties", () => {
    let reads = 0;
    const payload = Object.create(null, {
      secret: {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error("must not run");
        },
      },
      toString: {
        get: () => {
          reads += 1;
          throw new Error("must not run");
        },
      },
    });
    const projection = projectToolObservation({
      toolName: `future_${"x".repeat(200)}`,
      lifecycle: "success",
      input: payload,
      output: payload,
    });

    expect(projection.kind).toBe("unknown-tool");
    expect(projection.toolName.length).toBeLessThanOrEqual(80);
    expect(projection).toMatchObject({ payloadPreview: "<object>" });
    expect(reads).toBe(0);
  });
});
