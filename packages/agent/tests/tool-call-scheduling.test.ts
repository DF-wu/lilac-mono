import { expect, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import { ToolCallScheduler, groupToolCalls } from "../tool-call-scheduling";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

test("groups calls around mutation aliases in received order", () => {
  expect(
    groupToolCalls(
      [
        "read",
        "bash",
        "patch",
        "grep",
        "read",
        "write",
        "edit_file",
        "apply_patch",
        "mcp__lilac__patch",
      ],
      (name) => name,
    ),
  ).toEqual([
    ["read", "bash"],
    ["patch"],
    ["grep", "read"],
    ["write"],
    ["edit_file"],
    ["apply_patch"],
    ["mcp__lilac__patch"],
  ]);
});

test("AI SDK runs parallel groups around patches and retains result order", async () => {
  const first = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  const patch = Promise.withResolvers<void>();
  const patchStarted = Promise.withResolvers<void>();
  const starts: string[] = [];
  const calls = ["read", "bash", "patch", "grep", "read"];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...(++step === 1
            ? calls.map((toolName, index) => ({
                type: "tool-call" as const,
                toolCallId: String(index),
                toolName,
                input: "{}",
              }))
            : []),
          {
            type: "finish" as const,
            finishReason: {
              unified: step === 1 ? ("tool-calls" as const) : ("stop" as const),
              raw: "stop",
            },
            usage,
          },
        ],
      }),
    }),
  });
  const tools = Object.fromEntries(
    [...new Set(calls)].map((name) => [
      name,
      tool({
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
        execute: async (_, { toolCallId }) => {
          starts.push(toolCallId);
          if (starts.length === 2) bothStarted.resolve();
          if (toolCallId === "0" || toolCallId === "1") await first.promise;
          if (name === "patch") {
            patchStarted.resolve();
            await patch.promise;
          }
          return toolCallId;
        },
      }),
    ]),
  );
  const agent = new AiSdkPiAgent({ model, system: "test", tools });
  const run = agent.prompt("run tools");
  await bothStarted.promise;
  expect(starts).toEqual(["0", "1"]);
  first.resolve();
  await patchStarted.promise;
  expect(starts).toEqual(["0", "1", "2"]);
  patch.resolve();
  await run;
  expect(starts).toEqual(["0", "1", "2", "3", "4"]);
  expect(
    agent.state.messages.flatMap((message) =>
      message.role === "tool"
        ? message.content.map((part) => (part.type === "tool-result" ? part.toolCallId : null))
        : [],
    ),
  ).toEqual(["0", "1", "2", "3", "4"]);
});

test("individual MCP calls wait at barriers and release after failures", async () => {
  const scheduler = new ToolCallScheduler();
  const reads = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  const patchStarted = Promise.withResolvers<void>();
  const patch = Promise.withResolvers<void>();
  const starts: string[] = [];
  const runs = ["read", "bash", "apply_patch", "grep"].map((name) =>
    scheduler.run(name, async () => {
      starts.push(name);
      if (starts.length === 2) bothStarted.resolve();
      if (name === "read" || name === "bash") await reads.promise;
      if (name === "apply_patch") {
        patchStarted.resolve();
        await patch.promise;
        throw new Error("patch failed");
      }
    }),
  );
  const completed = Promise.allSettled(runs);
  await bothStarted.promise;
  expect(starts).toEqual(["read", "bash"]);
  reads.resolve();
  await patchStarted.promise;
  expect(starts).toEqual(["read", "bash", "apply_patch"]);
  patch.resolve();
  expect((await completed).map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  expect(starts).toEqual(["read", "bash", "apply_patch", "grep"]);
});
