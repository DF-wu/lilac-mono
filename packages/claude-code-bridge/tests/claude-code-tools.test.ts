import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { createClaudeCodeToolBridge, displayClaudeCodeToolName } from "../claude-code-tools";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectBridge(
  bridge: Awaited<ReturnType<typeof createClaudeCodeToolBridge>>,
): Promise<Client> {
  const config = bridge.mcpServers.lilac;
  if (!config || config.type !== "sdk") throw new Error("Expected Lilac SDK MCP server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
  closeCallbacks.push(async () => {
    await Promise.all([client.close(), config.instance.close()]);
  });
  return client;
}

function permissionOptions(
  toolUseID: string,
): Parameters<Awaited<ReturnType<typeof createClaudeCodeToolBridge>>["canUseTool"]>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID,
    requestId: `permission-${toolUseID}`,
  };
}

describe("Claude Code tool bridge", () => {
  it("omits batch and preserves whole-schema input transforms exactly once", async () => {
    let transforms = 0;
    const seen: unknown[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        transformed: tool({
          inputSchema: z.object({ value: z.string() }).transform((input) => {
            transforms += 1;
            return { value: Number(input.value) + 1 };
          }),
          execute: () => "unused",
        }),
        batch: tool({ inputSchema: z.object({}), execute: () => "unused" }),
      },
      execute: async (request) => {
        seen.push(request);
        return {
          result: request.input,
          isError: false,
          outcome: "success",
          toolOutput: { type: "json", value: request.input as { value: number } },
        };
      },
    });
    const client = await connectBridge(bridge);

    const listed = await client.listTools();
    expect(listed.tools.map((entry) => entry.name)).toEqual(["transformed"]);

    const permission = await bridge.canUseTool(
      "mcp__lilac__transformed",
      { value: "2" },
      permissionOptions("toolu_1"),
    );
    if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");
    const result = await client.callTool({
      name: "transformed",
      arguments: permission.updatedInput,
    });

    expect(transforms).toBe(1);
    expect(seen).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        toolName: "transformed",
        input: { value: 3 },
        inputValidation: "prevalidated",
      }),
    ]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ value: 3 });
  });

  it("fails closed without valid correlation and supports parallel identical calls", async () => {
    const calls: string[] = [];
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        echo: tool({ inputSchema: z.object({ value: z.string() }), execute: () => "unused" }),
      },
      execute: async (request) => {
        calls.push(request.toolCallId);
        return {
          result: request.input,
          isError: false,
          outcome: "success",
          toolOutput: { type: "text", value: request.toolCallId },
        };
      },
    });
    const client = await connectBridge(bridge);

    const missing = await client.callTool({ name: "echo", arguments: { value: "same" } });
    expect(missing.isError).toBe(true);

    const permissions = await Promise.all(
      ["toolu_a", "toolu_b"].map((toolUseId) =>
        bridge.canUseTool("mcp__lilac__echo", { value: "same" }, permissionOptions(toolUseId)),
      ),
    );
    const inputs = permissions.map((permission) => {
      if (!permission || permission.behavior !== "allow") throw new Error("Expected allow");
      return permission.updatedInput;
    });
    const results = await Promise.all(
      inputs.map((arguments_) => client.callTool({ name: "echo", arguments: arguments_ })),
    );

    expect(calls.toSorted()).toEqual(["toolu_a", "toolu_b"]);
    expect(results.map((result) => CallToolResultSchema.parse(result).content[0])).toEqual([
      { type: "text", text: "toolu_a" },
      { type: "text", text: "toolu_b" },
    ]);
  });

  it("skips provider-executed tools the model runs itself", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: {
        local: tool({ inputSchema: z.object({}), execute: () => "ran" }),
        // A native web search: the provider runs it, so there is nothing for
        // the bridge to expose.
        websearch: {
          ...tool({ inputSchema: z.object({}) }),
          isProviderExecuted: true,
        } as unknown as ToolSet[string],
      },
      execute: async () => {
        throw new Error("unreachable");
      },
    });
    const client = await connectBridge(bridge);

    expect(bridge.exposedToolNames).toEqual(["local"]);
    expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["local"]);
    expect(
      await bridge.canUseTool("mcp__lilac__websearch", {}, permissionOptions("toolu_skip")),
    ).toMatchObject({ behavior: "deny" });
  });

  it("names the tool when a Lilac tool cannot be executed at all", async () => {
    // Not provider-executed, just broken: that is a toolset bug and must not
    // silently remove the tool from the model's reach.
    await expect(
      createClaudeCodeToolBridge({
        tools: { broken: tool({ inputSchema: z.object({}) }) },
        execute: async () => {
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow("Cannot expose Claude MCP tool 'broken': execute is missing");
  });

  it("rejects built-ins outside the vetted set even when typechecking is bypassed", async () => {
    await expect(
      createClaudeCodeToolBridge({
        tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
        execute: async () => {
          throw new Error("unreachable");
        },
        builtInTools: ["Bash"] as unknown as ["WebSearch"],
      }),
    ).rejects.toThrow("Claude built-in tool 'Bash' is not supported");
  });

  it("allows only exactly allowlisted built-ins and denies every other Claude tool", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
      execute: async () => {
        throw new Error("unreachable");
      },
      builtInTools: ["WebSearch"],
    });

    expect(
      await bridge.canUseTool("WebSearch", { query: "lilac" }, permissionOptions("toolu_search")),
    ).toEqual({ behavior: "allow", updatedInput: { query: "lilac" } });
    for (const denied of ["Bash", "WebFetch", "WebSearchExtra", "websearch"]) {
      expect(
        await bridge.canUseTool(denied, {}, permissionOptions(`toolu_${denied}`)),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  it("denies built-ins when no allowlist is supplied", async () => {
    const bridge = await createClaudeCodeToolBridge({
      tools: { local: tool({ inputSchema: z.object({}), execute: () => "ran" }) },
      execute: async () => {
        throw new Error("unreachable");
      },
    });

    expect(await bridge.canUseTool("WebSearch", {}, permissionOptions("toolu_x"))).toMatchObject({
      behavior: "deny",
    });
  });

  it("formats only the Lilac MCP namespace for display", () => {
    expect(displayClaudeCodeToolName("mcp__lilac__read_file")).toBe("read_file");
    expect(displayClaudeCodeToolName("mcp__other__read_file")).toBe("mcp__other__read_file");
  });
});
