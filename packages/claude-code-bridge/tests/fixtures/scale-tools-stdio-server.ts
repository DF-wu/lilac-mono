import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tool } from "ai";
import { z } from "zod";

import { createClaudeCodeToolBridge } from "../../claude-code-tools";

const entries = Array.from({ length: 5_000 }, (_, index) => {
  const name = `mcp_scale_tool_${index}`;
  return [
    name,
    tool({
      description: `Scale tool ${index}`,
      inputSchema: z.object({ value: z.string() }),
      execute: () => "value",
    }),
  ] as const;
});

const bridge = await createClaudeCodeToolBridge({
  tools: Object.fromEntries(entries),
  catalogMetadata: Object.fromEntries(
    entries.map(([name], index) => [
      name,
      {
        sourceId: "scale-server",
        rawName: `original/tool/${index}`,
        description: `Original scale description ${index}`,
      },
    ]),
  ),
  execute: async () => {
    throw new Error("unreachable");
  },
});
const config = bridge.mcpServers.lilac;
if (!config || config.type !== "sdk") throw new Error("Expected Lilac SDK MCP server");

await config.instance.connect(new StdioServerTransport());
await new Promise<void>((resolve) => process.stdin.once("end", resolve));
await bridge.close();
