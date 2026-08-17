import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { Panic, Result, type Result as ResultType } from "better-result";
import type { SurfaceAttachment } from "../../../../src/surface/types";

import {
  DiscordOutputStream,
  buildDiscordProgressLines,
  buildOutputAllowedMentions,
  buildWorkingTitle,
  clampReasoningDetail,
  escapeDiscordMarkdown,
  formatReasoningAsBlockquote,
  toPreviewTail,
} from "../../../../src/surface/discord/output/discord-output-stream";
import type { SurfaceToolStatusUpdate } from "../../../../src/surface/adapter";
import { buildProgressFieldValue } from "../../../../src/surface/discord/output/embed-pusher";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

describe("escapeDiscordMarkdown", () => {
  it("escapes emphasis markers in glob-like patterns", () => {
    expect(escapeDiscordMarkdown("**/*")).toBe("\\*\\*/\\*");
  });

  it("escapes common markdown control characters", () => {
    expect(escapeDiscordMarkdown("[x](y) _z_ `k` ~u~")).toBe(
      "\\[x\\]\\(y\\) \\_z\\_ \\`k\\` \\~u\\~",
    );
  });
});

describe("compact subagent progress", () => {
  function entry(
    toolCallId: string,
    updatedSeq: number,
    update: Omit<SurfaceToolStatusUpdate, "toolCallId">,
  ) {
    return { toolCallId, updatedSeq, update: { toolCallId, ...update } };
  }

  function visible(lines: readonly string[]): string[] {
    return lines.map((line) => line.replaceAll("\\", ""));
  }

  it("keeps detailed reasoning visible alongside all five action rows", () => {
    const value = buildProgressFieldValue({
      reasoningValue: "> **Inspecting**\n> reasoning detail",
      actionsValue: "action one\naction two\naction three\naction four\nagent one",
    });

    expect(value.split("\n")).toEqual([
      "> **Inspecting**",
      "> reasoning detail",
      "",
      "action one",
      "action two",
      "action three",
      "action four",
      "agent one",
    ]);
  });

  it("reserves three rows for one active agent and two for recent main actions", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-1", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-2", 2, { status: "end", display: "grep auth", ok: true }),
          entry("tool-3", 3, { status: "start", display: "bash bun test" }),
          entry("tool-4", 4, { status: "start", display: "read failing.test.ts" }),
        ],
        subagents: [
          entry("agent-1", 5, {
            status: "update",
            display: [
              "subagent (general; claude-fable-5 [high]; 1/2 done)",
              "|- + read package.json",
              "`- > bash bunx tsc --noEmit",
            ].join("\n"),
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "▶ bash bun test",
      "▶ read failing.test.ts",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bunx tsc --noEmit",
    ]);
  });

  it("shows one child row per active agent when two are visible", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [low]; 1/2 done)\n`- > bash bun test",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (explore; claude-fable-5 [medium]; 14/20 done)\n`- > batch (2/6)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "… explore (cl...fable-5 [md]; 14/20)",
      "`- > batch (2/6)",
      "… general (gpt-5.6-sol [lo]; 1/2)",
      "`- > bash bun test",
    ]);
  });

  it("moves completed agents into tool history while active agents stay at the bottom", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; claude-fable-5 [high]; 12/13 done)\n`- > read src/a.ts",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)\n`- > patch src/b.ts",
          }),
          entry("agent-3", 3, {
            status: "update",
            display: "subagent (explore; grok-4.5 [xhigh]; 8/10 done)\n`- > batch (2/6)",
          }),
          entry("agent-4", 4, {
            status: "end",
            display: "subagent (explore; 3/3 done)",
            ok: true,
          }),
          entry("agent-5", 5, {
            status: "end",
            display: "subagent (general; 4/4 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ explore (3/3)",
      "✓ general (4/4)",
      "… explore (grok-4.5 [xh]; 8/10; batch)",
      "… self (gpt-5.6-sol [md]; 1/2; patch)",
      "… general (cl...fable-5 [hi]; 12/13; read)",
    ]);
  });

  it("orders completed agents with tools by recency", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-old", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-new", 3, { status: "end", display: "grep auth", ok: true }),
        ],
        subagents: [
          entry("agent-complete", 2, {
            status: "end",
            display: "subagent (general; gpt-5.6-sol [high]; 2/2 done)",
            ok: true,
          }),
          entry("agent-active", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ glob src",
      "✓ general (gpt-5.6-sol [hi]; 2/2)",
      "✓ grep auth",
      "… explore (gpt-5.6-sol [lo]; 1/2)",
    ]);
  });

  it("evicts completed agents naturally as newer tools fill the history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: Array.from({ length: 5 }, (_, index) =>
          entry(`tool-${index}`, index + 2, {
            status: "end",
            display: `bash command-${index}`,
            ok: true,
          }),
        ),
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; 2/2 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ bash command-0",
      "✓ bash command-1",
      "✓ bash command-2",
      "✓ bash command-3",
      "✓ bash command-4",
    ]);
  });

  it("counts only active agents in subagent overflow", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; resolved)",
            ok: true,
          }),
          ...Array.from({ length: 4 }, (_, index) =>
            entry(`agent-active-${index}`, index + 2, {
              status: "update",
              display: `subagent (explore; ${index + 1}/4 done)`,
            }),
          ),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ general (resolved)",
      "… explore (4/4)",
      "… explore (3/4)",
      "… explore (2/4) · +1 more",
    ]);
  });

  it("renders failed and cancelled agents as terminal tool history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-failed", 1, {
            status: "end",
            display: "subagent (general; failed)",
            ok: false,
          }),
          entry("agent-cancelled", 2, {
            status: "end",
            display: "subagent (explore; cancelled)",
            ok: false,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✗ general (failed)", "✗ explore (cancelled)"]);
  });

  it("collapses a completed agent and omits unresolved effort", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "end",
            display:
              "subagent (explore; gpt-5.6-sol [provider-default]; 3/3 done)\n`- + bash bun test",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✓ explore (gpt-5.6-sol; 3/3)"]);
  });

  it("uses the delegated profile while an agent is starting", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "start",
            display: "subagent_delegate (general) Investigate flaky tests",
          }),
        ],
      }),
    );

    expect(lines).toEqual(["▶ general (starting)"]);
  });

  it("counts multiline batch rows within the five-line budget", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("batch-1", 1, {
            status: "update",
            display: [
              "batch (3 tools; 2/3 done)",
              "|- ✓ read a.ts",
              "|- ✓ grep auth",
              "`- ▶ bash bun test",
            ].join("\n"),
          }),
        ],
        subagents: [
          entry("agent-1", 2, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)",
          }),
          entry("agent-2", 3, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)",
          }),
          entry("agent-3", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 2)).toEqual(["… batch (3 tools; 2/3 done)", "`- ▶ bash bun test"]);
    expect(lines.slice(2).every((line) => line.includes("gpt-5.6-sol"))).toBe(true);
  });

  it("normalizes restored builtin prefixes without rewriting plugin or batch displays", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("read", 1, { status: "start", display: "read_file restored.ts" }),
          entry("plugin", 2, { status: "start", display: "read_file_plugin restored.ts" }),
          entry("batch", 3, {
            status: "update",
            display: "batch (1 tools)\n`- ▶ read_file restored.ts",
          }),
        ],
        subagents: [
          entry("agent", 4, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > apply_patch restored.ts",
          }),
        ],
      }),
    );

    expect(lines).toContain("▶ read_file_plugin restored.ts");
    expect(lines).toContain("… batch (1 tools)");
    expect(lines).toContain("`- ▶ read restored.ts");
    expect(lines).toContain("`- > patch restored.ts");
  });

  it("normalizes restored builtin names in compact subagent headers", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("one", 1, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > read_file one.ts",
          }),
          entry("two", 2, {
            status: "update",
            display: "subagent (general; 1/2 done)\n`- > apply_patch two.ts",
          }),
          entry("three", 3, {
            status: "update",
            display: "subagent (self; 1/2 done)\n`- > edit_file three.ts",
          }),
        ],
      }),
    );

    expect(lines.some((line) => line.includes("; read)"))).toBe(true);
    expect(lines.some((line) => line.includes("; patch)"))).toBe(true);
    expect(lines.some((line) => line.includes("; edit)"))).toBe(true);
  });
});

function createFakeDiscordClient(opts?: {
  failEdit?: boolean;
  editFailure?: unknown;
  failEditWithFiles?: boolean;
  sendFailure?: unknown;
  failReplyAt?: number;
  replyFailure?: unknown;
  failResumeFetch?: boolean;
  resumeFetchFailure?: unknown;
  onEdit?: (options: unknown) => void;
}): {
  client: Client;
  createdMessageIds: string[];
  deletedMessageIds: string[];
  operations: Array<{
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  }>;
} {
  type RecordedOp = {
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  };

  type FakeMessage = {
    readonly id: string;
    readonly channelId: string;
    readonly attachments: Map<string, { id: string }>;
    edit(options: unknown): Promise<FakeMessage>;
    reply(options: unknown): Promise<FakeMessage>;
    delete(): Promise<void>;
  };

  const operations: RecordedOp[] = [];
  const deletedMessageIds: string[] = [];
  const createdMessageIds: string[] = [];
  const messages = new Map<string, FakeMessage>();
  let nextMessageId = 1;
  let nextAttachmentId = 1;
  let replyAttempts = 0;
  const channelId = "chan";

  const fileCountFromOptions = (options: unknown): number => {
    if (!options || typeof options !== "object") return 0;
    const files = (options as { files?: unknown }).files;
    if (!Array.isArray(files)) return 0;
    return files.length;
  };

  const keepAttachmentIdsFromOptions = (options: unknown): Set<string> | null => {
    if (!options || typeof options !== "object") return null;
    const raw = (options as { attachments?: unknown }).attachments;
    if (!Array.isArray(raw)) return null;

    const keep = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") keep.add(id);
    }
    return keep;
  };

  const appendNewAttachments = (message: FakeMessage, count: number): void => {
    for (let i = 0; i < count; i++) {
      const id = `att_${nextAttachmentId++}`;
      message.attachments.set(id, { id });
    }
  };

  const applyEditAttachments = (message: FakeMessage, options: unknown): void => {
    const keep = keepAttachmentIdsFromOptions(options);
    if (keep) {
      const idsToDelete: string[] = [];
      for (const id of message.attachments.keys()) {
        if (!keep.has(id)) {
          idsToDelete.push(id);
        }
      }
      for (const id of idsToDelete) {
        message.attachments.delete(id);
      }
    }

    const newFileCount = fileCountFromOptions(options);
    appendNewAttachments(message, newFileCount);
  };

  const createMessage = (params?: {
    operation: "send" | "reply";
    options: unknown;
    parentId?: string;
  }): FakeMessage => {
    const id = `m_${nextMessageId++}`;
    createdMessageIds.push(id);

    const attachments = new Map<string, { id: string }>();

    const message: FakeMessage = {
      id,
      channelId,
      attachments,
      edit: async (options) => {
        operations.push({ kind: "edit", messageId: id, options });
        opts?.onEdit?.(options);
        if (opts?.editFailure) throw opts.editFailure;
        if (opts?.failEdit) throw new Error("edit failed");
        if (opts?.failEditWithFiles && fileCountFromOptions(options) > 0) {
          throw new Error("edit failed");
        }
        applyEditAttachments(message, options);
        return message;
      },
      reply: async (options) => {
        replyAttempts += 1;
        if (replyAttempts === opts?.failReplyAt) {
          throw opts.replyFailure ?? new Error("reply failed");
        }
        return createMessage({ operation: "reply", parentId: id, options });
      },
      delete: async () => {
        deletedMessageIds.push(id);
        messages.delete(id);
      },
    };

    if (params) {
      operations.push({
        kind: params.operation,
        messageId: id,
        parentId: params.parentId,
        options: params.options,
      });
      appendNewAttachments(message, fileCountFromOptions(params.options));
    }

    messages.set(id, message);
    return message;
  };

  const channel = {
    send: async (options: unknown) => {
      if (opts?.sendFailure) throw opts.sendFailure;
      return createMessage({ operation: "send", options });
    },
    messages: {
      fetch: async (messageId: string) => {
        if (opts?.resumeFetchFailure) throw opts.resumeFetchFailure;
        if (opts?.failResumeFetch) throw new Error("resume fetch failed");
        return messages.get(messageId) ?? null;
      },
    },
  };

  const client = {
    channels: {
      fetch: async (id: string) => (id === channelId ? channel : null),
    },
  };

  return {
    client: client as unknown as Client,
    createdMessageIds,
    deletedMessageIds,
    operations,
  };
}

function hasFiles(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) && files.length > 0;
}

function contentFromOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const content = (options as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function hasEmbeds(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const embeds = (options as { embeds?: unknown }).embeds;
  return Array.isArray(embeds) && embeds.length > 0;
}

function embedDescriptionsFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  return embeds.flatMap((embed) => {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") serialized = toJSON.call(embed);
    }
    if (!serialized || typeof serialized !== "object") return [];
    const description = (serialized as { description?: unknown }).description;
    return typeof description === "string" ? [description] : [];
  });
}

function embedFieldValuesFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  const values: string[] = [];
  for (const embed of embeds) {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        serialized = toJSON.call(embed);
      }
    }

    if (!serialized || typeof serialized !== "object") continue;
    const fields = (serialized as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      if (!field || typeof field !== "object") continue;
      const value = (field as { value?: unknown }).value;
      if (typeof value === "string") values.push(value);
    }
  }

  return values;
}

function filesCount(options: unknown): number {
  if (!options || typeof options !== "object") return 0;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) ? files.length : 0;
}

function uploadedFileNames(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const files = (options as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const names: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const name = (file as { name?: unknown }).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

function allUploadedFileNames(
  operations: ReadonlyArray<{
    kind: "send" | "reply" | "edit";
    options: unknown;
  }>,
): string[] {
  return operations
    .filter((op) => hasFiles(op.options))
    .flatMap((op) => uploadedFileNames(op.options));
}

function makeAttachment(index: number): SurfaceAttachment {
  return {
    kind: "image",
    mimeType: "image/png",
    filename: `image-${index}.png`,
    bytes: new Uint8Array([index]),
  };
}

describe("Discord initial output", () => {
  it("sends substantive content directly with reply, cancel, and creation correlation", async () => {
    const { client, operations } = createFakeDiscordClient();
    let createdMessageId: string | undefined;
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        requestId: "discord:chan:request",
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
        onMessageCreated: (ref) => {
          createdMessageId = ref.messageId;
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(out.push({ type: "text.delta", delta: "hello" })).resolves.toEqual(
      Result.ok("visible"),
    );

    expect(operations).toHaveLength(1);
    const first = operations[0]?.options as {
      content?: string;
      embeds?: unknown[];
      reply?: { messageReference?: string };
      components?: unknown[];
    };
    expect(first.content).toBeUndefined();
    expect(first.embeds).toHaveLength(1);
    expect(first.reply).toEqual({ messageReference: "source" });
    expect(first.components).toHaveLength(1);
    expect(createdMessageId).toBe("m_1");
    await out.finish();
  });
});

describe("Discord recovery hydration", () => {
  it("applies restored state without provider calls before the first live part", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "simple",
      workingIndicators: ["Working"],
    });

    expect(
      out.hydrateRecovery([
        { type: "text.set", text: "restored" },
        {
          type: "reasoning.status",
          update: { startedAtMs: 1, frozenAtMs: 2, detailText: "reasoning" },
        },
      ]),
    ).toBe("visible");
    expect(createdMessageIds).toEqual([]);
    expect(operations).toEqual([]);

    await expect(out.push({ type: "text.delta", delta: " live" })).resolves.toEqual(
      Result.ok("visible"),
    );
    expect(createdMessageIds).toEqual(["m_1"]);
    expect(operations.map((operation) => operation.kind)).toEqual(["send"]);
    expect(hasEmbeds(operations[0]?.options)).toBe(true);
    expect(contentFromOptions(operations[0]?.options)).not.toBe("*Replying...*");
  });
});

describe("Discord compact progress integration", () => {
  it("moves a completed agent into history before newer tool activity", async () => {
    let resolveActiveEdit: (options: unknown) => void = () => {};
    let resolveCompletedEdit: (options: unknown) => void = () => {};
    let resolveShiftedEdit: (options: unknown) => void = () => {};
    const activeEdit = new Promise<unknown>((resolve) => {
      resolveActiveEdit = resolve;
    });
    const completedEdit = new Promise<unknown>((resolve) => {
      resolveCompletedEdit = resolve;
    });
    const shiftedEdit = new Promise<unknown>((resolve) => {
      resolveShiftedEdit = resolve;
    });
    const { client } = createFakeDiscordClient({
      onEdit: (options) => {
        const lines = embedFieldValuesFromOptions(options)
          .flatMap((value) => value.replaceAll("\\", "").split("\n"))
          .filter(Boolean);
        if (lines.some((line) => line.includes("… general") && line.includes("1/2"))) {
          resolveActiveEdit(options);
        }
        if (lines.some((line) => line.includes("✓ general")) && lines.length === 1) {
          resolveCompletedEdit(options);
        }
        const completedIndex = lines.findIndex((line) => line.includes("✓ general"));
        const newerToolIndex = lines.findIndex((line) => line.includes("▶ bash parent-check"));
        if (completedIndex >= 0 && newerToolIndex > completedIndex) {
          resolveShiftedEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)\n`- > bash child-check",
      },
    });
    await activeEdit;

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "end",
        display: "subagent (general; resolved)",
        ok: true,
      },
    });
    const completedEditOptions = await completedEdit;
    expect(
      embedFieldValuesFromOptions(completedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)"]);

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "tool-1",
        status: "start",
        display: "bash parent-check",
      },
    });
    const shiftedEditOptions = await shiftedEdit;
    expect(
      embedFieldValuesFromOptions(shiftedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)\n▶ bash parent-check"]);
    await out.finish();
  });

  it("keeps agents in the Working field and removes progress on completion", async () => {
    let resolveStreamingEdit: (options: unknown) => void = () => {};
    const streamingEdit = new Promise<unknown>((resolve) => {
      resolveStreamingEdit = resolve;
    });
    const { client, operations } = createFakeDiscordClient({
      onEdit: (options) => {
        if (embedFieldValuesFromOptions(options).some((value) => value.includes("bash bun test"))) {
          resolveStreamingEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    for (let index = 1; index <= 4; index++) {
      await out.push({
        type: "tool.status",
        update: {
          toolCallId: `tool-${index}`,
          status: "start",
          display: `bash command-${index}`,
        },
      });
    }
    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: [
          "subagent (general; claude-fable-5 [high]; 1/2 done)",
          "|- + read package.json",
          "`- > bash bun test",
        ].join("\n"),
      },
    });

    const streamingEditOptions = await streamingEdit;
    const streamingValues = embedFieldValuesFromOptions(streamingEditOptions).map((value) =>
      value.replaceAll("\\", ""),
    );
    expect(streamingValues).toHaveLength(1);
    expect(streamingValues[0]?.split("\n")).toEqual([
      "▶ bash command-3",
      "▶ bash command-4",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bun test",
    ]);

    await out.finish();
    const finalEdit = operations.filter((operation) => operation.kind === "edit").at(-1);
    expect(embedFieldValuesFromOptions(finalEdit?.options)).toEqual([]);
  });
});

describe("preview reanchor behavior", () => {
  it("reports hidden reasoning as terminal without rendering it", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(
      out.push({
        type: "reasoning.status",
        update: { startedAtMs: 1, detailText: "hidden" },
      }),
    ).resolves.toEqual(Result.ok("terminal"));
    expect(operations).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(out.getFinalTextMode()).toBe("full");
    expect(deletedMessageIds).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on interrupt reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor_interrupt");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(deletedMessageIds).toEqual([]);
  });

  it("reports continuation final text mode for inline streams", () => {
    const { client } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    expect(out.getFinalTextMode()).toBe("continuation");
  });
});

describe("output operation failures", () => {
  it("returns a classified failure when the first substantive send fails", async () => {
    const { client, createdMessageIds } = createFakeDiscordClient({ sendFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    const result = await out.push({ type: "text.delta", delta: "hello" });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected first-send failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceUnavailable",
      operation: "push-output",
    });
    expect(createdMessageIds).toEqual([]);
  });

  it("raises a Panic when final output rejects with an impossible non-Error value", async () => {
    const { client } = createFakeDiscordClient({
      failReplyAt: 1,
      replyFailure: "invalid non-Error rejection",
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });

    try {
      await out.finish();
      throw new Error("expected Discord output invariant Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
      if (!Panic.is(cause)) throw cause;
      expect(cause.message).toBe("Discord output invariant violated");
    }
  });

  it("does not finish successfully when embed synchronization fails", async () => {
    const { client } = createFakeDiscordClient({ editFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await expect(out.finish()).rejects.toMatchObject({
      _tag: "DiscordEmbedPusherInvariant",
    });
  });

  it("classifies resume fetch failures instead of creating a duplicate chain", async () => {
    const { client, createdMessageIds } = createFakeDiscordClient({
      resumeFetchFailure: { status: 403 },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        resume: {
          created: [{ platform: "discord", channelId: "chan", messageId: "existing" }],
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    const result = await out.push({ type: "text.delta", delta: "hello" });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected push failure");
    expect(result.error).toMatchObject({
      _tag: "SurfacePermissionDenied",
      operation: "push-output",
    });
    expect(createdMessageIds).toEqual([]);
  });

  it("returns partial completion when a later final chunk fails", async () => {
    const replyFailure = Object.assign(new Error("reply unavailable"), { status: 503 });
    const { client } = createFakeDiscordClient({
      failReplyAt: 1,
      replyFailure,
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    const result = await out.finish();

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected finish failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      operation: "finish-output",
      created: { platform: "discord", channelId: "chan" },
    });
  });
});

describe("attachment finalization", () => {
  it("inline mode edits attachments onto the final split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "a".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    expect(res.created.length).toBeGreaterThan(1);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(editsWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(0);
  });

  it("preview mode posts attachments on the final reposted split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "b".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    expect(res.created.length).toBeGreaterThan(1);

    const sentWithFiles = operations.filter(
      (op) => (op.kind === "send" || op.kind === "reply") && hasFiles(op.options),
    );
    expect(sentWithFiles.length).toBe(1);
    expect(sentWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(0);
  });

  it("falls back to follow-up attachment messages when final edit fails", async () => {
    const { client, operations } = createFakeDiscordClient({ failEditWithFiles: true });

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });

  it("keeps first 10 attachments on final message and overflows remainder", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    for (let i = 0; i < 11; i++) {
      await out.push({ type: "attachment.add", attachment: makeAttachment(i) });
    }

    const res = resultValue(await out.finish());

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(filesCount(editsWithFiles[0]?.options)).toBe(10);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    expect(filesCount(replyWithFiles[0]?.options)).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected overflow reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });
});

describe("preview final output style", () => {
  it("reposts phased final segments as a plain reply chain", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "Commentary.\n\nFinal answer." });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.push({
      type: "text.set",
      text: "Commentary.\n\nFinal answer.",
      finalSegments: ["Commentary.", "Final answer."],
    });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (operation) =>
        (operation.kind === "send" || operation.kind === "reply") &&
        !hasEmbeds(operation.options) &&
        ["Commentary.", "Final answer."].includes(contentFromOptions(operation.options) ?? ""),
    );
    expect(plainFinalOps.map((operation) => contentFromOptions(operation.options))).toEqual([
      "Commentary.",
      "Final answer.",
    ]);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(filesCount(plainFinalOps[0]?.options)).toBe(0);
    expect(filesCount(plainFinalOps[1]?.options)).toBe(1);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    const finalPlainOperation = plainFinalOps[1];
    if (!finalPlainOperation) throw new Error("expected final plain segment");
    expect(res.last.messageId).toBe(finalPlainOperation.messageId);
  });

  it("renders each final segment in the terminal phase", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({
      type: "text.set",
      text: "combined",
      finalSegments: ["first \\(partial", "second \\(x+1\\)"],
    });
    await out.finish();

    const finalContents = operations
      .filter((operation) => operation.kind === "send" || operation.kind === "reply")
      .map((operation) => contentFromOptions(operation.options))
      .filter((content): content is string => content !== undefined);
    expect(finalContents).toContain("first \\(partial");
    expect(finalContents).toContain("second `x + 1`");
  });

  it("posts preview final output as content and stats as metadata when configured", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "preview text" });
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const finalSend = operations.find(
      (op) =>
        op.kind === "send" &&
        contentFromOptions(op.options) === "preview text" &&
        hasEmbeds(op.options),
    );

    expect(finalSend).toBeDefined();
    if (!finalSend) {
      throw new Error("expected plain final send");
    }
    expect(contentFromOptions(finalSend.options)).not.toContain("nerd stats");
    expect(embedFieldValuesFromOptions(finalSend.options)).toEqual(["*nerd stats*"]);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    expect(res.last.messageId).toBe(finalSend.messageId);
  });

  it("attaches stats metadata only to the final plain preview chunk", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(hasEmbeds(plainFinalOps[0]?.options)).toBe(false);
    expect(hasEmbeds(plainFinalOps[1]?.options)).toBe(false);
    expect(embedFieldValuesFromOptions(lastPlainFinal.options)).toEqual(["*nerd stats*"]);
    expect(contentFromOptions(lastPlainFinal.options)).not.toContain("nerd stats");
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });

  it("splits plain preview final output into a normal reply chain", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        !hasEmbeds(op.options) &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(plainFinalOps[2]?.parentId).toBe(plainFinalOps[1]?.messageId);
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });
});

describe("attachment single-event safety", () => {
  it("does not reattach one queued attachment across reanchor and finish", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "before reanchor" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.abort("reanchor");

    await out.push({ type: "text.delta", delta: "after reanchor" });
    await out.finish();

    expect(allUploadedFileNames(operations)).toEqual(["image-9.png"]);
  });

  it("attaches one queued attachment exactly once on cancel", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(10) });
    await out.abort("cancel");

    expect(allUploadedFileNames(operations)).toEqual(["image-10.png"]);
  });

  it("attaches attachment-only cancel output once", async () => {
    const { client, operations, createdMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "attachment.add", attachment: makeAttachment(11) });
    await out.abort("cancel");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(allUploadedFileNames(operations)).toEqual(["image-11.png"]);
  });
});

describe("discord blockquote normalization", () => {
  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream, "terminal") as string;
  }

  it("normalizes bare blockquote continuation lines before rendering", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", "> first\n>\n> second");

    expect(getRenderedText(out)).toBe("> first\n> \n> second");
  });

  it("does not normalize bare markers inside fenced code in rendered text", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });
    const input = ["```md", ">", "```", ">"].join("\n");

    Reflect.set(out as object, "textAcc", input);

    expect(getRenderedText(out)).toBe(["```md", ">", "```", "> "].join("\n"));
  });
});

describe("experimental markdown table rendering", () => {
  const markdownTable = [
    "| Name | Score |",
    "| --- | ---: |",
    "| Alice | 10 |",
    "| Bob | 200 |",
  ].join("\n");

  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream, "terminal") as string;
  }

  it("rewrites markdown tables into fixed-width blocks when enabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownTableRender: {
        style: "unicode",
        maxWidth: 40,
      },
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toContain("```text");
    expect(rendered).toContain("┌");
  });

  it("leaves markdown table text untouched when disabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toBe(markdownTable);
  });
});

describe("Discord markdown math integration", () => {
  function getRenderedText(stream: DiscordOutputStream, phase: "streaming" | "terminal"): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") throw new Error("getRenderedText is unavailable");
    return method.call(stream, phase) as string;
  }

  function createMathStream(options?: {
    markdownMathRender?: { maxWidth?: number; fallbackMode?: "source" | "passthrough" };
    rewriteText?: (text: string) => string;
    markdownTableRender?: { style?: "unicode" | "ascii"; maxWidth?: number };
  }): DiscordOutputStream {
    const { client } = createFakeDiscordClient();
    return new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      ...options,
    });
  }

  it("renders inline and display math when enabled", () => {
    const out = createMathStream({ markdownMathRender: { maxWidth: 50 } });
    Reflect.set(out as object, "textAcc", "inline \\(x+1\\)\n\n$$y^2$$");

    expect(getRenderedText(out, "terminal")).toBe("inline `x + 1`\n\n```text\ny²\n```");
  });

  it("leaves math source byte-for-byte unchanged when options are omitted", () => {
    const out = createMathStream();
    const source = "inline \\(x+1\\)\r\n\r\n$$y^2$$";
    Reflect.set(out as object, "textAcc", source);

    expect(getRenderedText(out, "streaming")).toBe(source);
    expect(getRenderedText(out, "terminal")).toBe(source);
  });

  it("runs rewrite, blockquote normalization, tables, then math", () => {
    const out = createMathStream({
      rewriteText: () =>
        [">", "", "| Formula |", "| --- |", "| $$x+1$$ |", "", "outside \\(y+1\\)"].join("\n"),
      markdownTableRender: { style: "ascii", maxWidth: 40 },
      markdownMathRender: { maxWidth: 50 },
    });
    Reflect.set(out as object, "textAcc", "unrewritten \\(z\\)");

    const rendered = getRenderedText(out, "terminal");
    expect(rendered).toStartWith("> \n\n```text\n");
    expect(rendered).toContain("| $$x+1$$ |");
    expect(rendered).not.toContain("```text\nx + 1\n```");
    expect(rendered).toEndWith("outside `y + 1`");
    expect(rendered).not.toContain("unrewritten");
  });

  it("withholds incomplete math while streaming and restores it at terminal", () => {
    const out = createMathStream({ markdownMathRender: { fallbackMode: "passthrough" } });
    Reflect.set(out as object, "textAcc", "before \\(partial");

    expect(getRenderedText(out, "streaming")).toBe("before ");
    expect(getRenderedText(out, "terminal")).toBe("before \\(partial");
  });

  it("uses terminal rendering for the final embed-pusher sync", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({ type: "text.delta", delta: "before \\(partial" });
    await out.finish();

    const descriptions = operations.flatMap((operation) =>
      embedDescriptionsFromOptions(operation.options),
    );
    expect(descriptions.some((description) => description.includes("\\(partial"))).toBe(true);
    expect(descriptions.at(-1)).toBe("before \\(partial");
  });
});

describe("reasoning display helpers", () => {
  function getReasoningPresentation(
    mode: "simple" | "detailed",
    detailText: string,
  ): { title: string; detail: string | null } {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: mode,
      workingIndicators: ["Working"],
    });
    Reflect.set(out as object, "hasReasoningStatus", true);
    Reflect.set(out as object, "reasoningDetailText", detailText);

    const getProgressTitle = Reflect.get(out as object, "getProgressTitle");
    const getReasoningValue = Reflect.get(out as object, "getReasoningValue");
    if (typeof getProgressTitle !== "function" || typeof getReasoningValue !== "function") {
      throw new Error("reasoning presentation methods are unavailable");
    }
    return {
      title: getProgressTitle.call(out) as string,
      detail: getReasoningValue.call(out) as string | null,
    };
  }

  it("keeps the working indicator and shows a detailed title-only summary", () => {
    const presentation = getReasoningPresentation("detailed", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**");
  });

  it("keeps the working indicator and blockquotes the full detailed summary", () => {
    const presentation = getReasoningPresentation(
      "detailed",
      "**Inspecting the stream**\n\nChecking event ordering.",
    );

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**\n> \n> Checking event ordering.");
  });

  it("keeps the working indicator and hides the detail body in simple mode", () => {
    const presentation = getReasoningPresentation("simple", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBeNull();
  });

  it("clamps long reasoning output and preserves leading content", () => {
    expect(clampReasoningDetail("0123456789", 4)).toBe("012…");
  });

  it("renders reasoning text as blockquote lines", () => {
    expect(formatReasoningAsBlockquote("**Title**\nline 1\nline 2")).toBe(
      "> **Title**\n> line 1\n> line 2",
    );
  });

  it("renders working title with elapsed request seconds", () => {
    expect(
      buildWorkingTitle({
        nowMs: 21_500,
        startedAtMs: 20_000,
        indicator: "Working",
      }),
    ).toBe("⣽ Working... 1s");
  });

  it("clamps reasoning detail body to 500 chars by default", () => {
    const detail = `${"a".repeat(520)}\n${"b".repeat(10)}`;
    const output = clampReasoningDetail(detail);
    expect(output.includes("…")).toBe(true);
    expect(output.length).toBe(500);
  });
});

describe("working indicator picker", () => {
  function getPicker(stream: DiscordOutputStream): (previous?: string) => string {
    const picker = Reflect.get(stream as object, "pickRandomWorkingIndicator");
    if (typeof picker !== "function") {
      throw new Error("pickRandomWorkingIndicator is unavailable");
    }
    return (previous?: string) => picker.call(stream, previous) as string;
  }

  it("cycles without immediate repeats for unique indicators", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    let previous: string | undefined;

    for (let i = 0; i < 30; i++) {
      const next = pick(previous);
      if (previous) {
        expect(next).not.toBe(previous);
      }
      previous = next;
    }
  });

  it("reuses shuffled queue order across full cycles", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    const cycleOne: string[] = [];
    const cycleTwo: string[] = [];

    let previous: string | undefined;
    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleOne.push(next);
      previous = next;
    }

    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleTwo.push(next);
      previous = next;
    }

    expect(new Set(cycleOne).size).toBe(3);
    expect(cycleTwo).toEqual(cycleOne);
  });
});

describe("preview tail helper", () => {
  it("returns input unchanged when already within limit", () => {
    expect(toPreviewTail("hello", 10)).toBe("hello");
  });

  it("tails to exact max length with ellipsis prefix", () => {
    const out = toPreviewTail("0123456789", 6);
    expect(out).toBe("...789");
    expect(out.length).toBe(6);
  });
});

describe("output mention policy", () => {
  it("disables reply and mentions when notifications are off", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: false,
        previewMode: false,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("suppresses notifications on preview transient lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: false,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("enables user mentions and reply ping on preview final lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: ["users"], repliedUser: true });
  });
});
