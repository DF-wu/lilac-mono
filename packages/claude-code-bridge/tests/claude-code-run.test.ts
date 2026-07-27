import { describe, expect, it } from "bun:test";
import { claudeCodeExecutableSettings } from "@stanley2058/lilac-utils";
import { tool } from "ai";
import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { z } from "zod";

import { materializeClaudeCodeRun } from "../claude-code-run";

describe("materializeClaudeCodeRun", () => {
  it("isolates the tool-enabled agent model from the no-tools utility model", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const provider = createClaudeCode();
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {
        read: tool({
          description: "Read a value",
          inputSchema: z.object({ path: z.string() }),
          execute: ({ path }) => path,
        }),
        batch: tool({
          description: "Expand calls",
          inputSchema: z.object({}),
          execute: () => "not exposed",
        }),
      },
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, modelSettings) => {
        settings.push(modelSettings);
        return provider(modelId, modelSettings);
      },
    });

    expect(run.agentModel).not.toBe(run.utilityModel);
    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({
      cwd,
      env: { ENABLE_TOOL_SEARCH: "true" },
      tools: ["ToolSearch"],
      settingSources: [],
      persistSession: false,
      streamingInput: "always",
    });
    expect(settings[0]?.mcpServers).toBeDefined();
    expect(settings[0]?.canUseTool).toBeFunction();
    expect(settings[0]?.onStreamStart).toBeFunction();
    expect(settings[0]?.onQueryControllerCreated).toBeFunction();
    expect(settings[1]).toEqual({
      ...claudeCodeExecutableSettings(),
      cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    // Both models must target the same Claude installation.
    expect(settings[0]?.pathToClaudeCodeExecutable).toBe(
      settings[1]?.pathToClaudeCodeExecutable as string | undefined,
    );

    const injected: string[] = [];
    let closed = false;
    settings[0]?.onStreamStart?.({
      inject: (message, onResult) => {
        injected.push(message);
        onResult?.(true);
      },
      close: () => {
        closed = true;
      },
    });
    let delivered = false;
    expect(
      run.control.inject("change direction", (value) => {
        delivered = value;
      }),
    ).toBe(true);
    expect(injected).toEqual(["change direction"]);
    expect(delivered).toBe(true);

    await run.dispose();
    expect(closed).toBe(true);
    expect(run.control.inject("too late")).toBe(false);
    await run.dispose();
  });

  it("preserves caller built-ins, appends ToolSearch once, and keeps utility tools empty", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const provider = createClaudeCode();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: { read: tool({ inputSchema: z.object({}), execute: () => "value" }) },
      builtInTools: ["WebSearch", "ToolSearch"],
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, modelSettings) => {
        settings.push(modelSettings);
        return provider(modelId, modelSettings);
      },
    });

    expect(settings[0]?.tools).toEqual(["WebSearch", "ToolSearch"]);
    expect(settings[0]?.env).toEqual({ ENABLE_TOOL_SEARCH: "true" });
    expect(settings[1]?.tools).toEqual([]);
    expect(settings[1]?.env).toBeUndefined();

    await run.dispose();
  });
});
