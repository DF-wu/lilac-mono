import { describe, expect, it } from "bun:test";
import type { Message } from "discord.js";

import { startEmbedPusher } from "../../../../src/surface/discord/output/embed-pusher";

describe("startEmbedPusher content phase", () => {
  it("requests streaming content before streamDone and terminal content after it", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const phases: boolean[] = [];
    const message = { id: "message-1" } as Message;

    const result = await startEmbedPusher({
      createFirst: async () => {
        resolveDone();
        return message;
      },
      createReply: async () => message,
      getContent: (isStreaming) => {
        phases.push(isStreaming);
        return isStreaming ? "streaming" : "terminal";
      },
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      safeEdit: async () => true,
    });

    expect(result.status).toBe("ok");
    expect(phases).toEqual([true, false, false]);
    if (result.status === "error") throw result.error;
    expect(result.value.responseQueue).toEqual(["terminal"]);
  });

  it("performs a terminal read when streamDone resolves during a streaming sync", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const phases: boolean[] = [];
    const message = { id: "message-1" } as Message;

    const result = await startEmbedPusher({
      createFirst: async () => message,
      createReply: async () => message,
      getContent: (isStreaming) => {
        phases.push(isStreaming);
        return phases.length === 1 ? "first content" : "same content";
      },
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      safeEdit: async () => {
        resolveDone();
        return true;
      },
    });

    expect(result.status).toBe("ok");
    expect(phases).toEqual([true, true, false, false]);
  });

  it("returns an invariant error when the terminal transition edit fails", async () => {
    let resolveDone: () => void = () => {};
    const streamDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const message = { id: "message-1" } as Message;
    const edits: unknown[] = [];

    const result = await startEmbedPusher({
      createFirst: async () => {
        resolveDone();
        return message;
      },
      createReply: async () => message,
      getContent: (isStreaming) => (isStreaming ? "before " : "before \\(partial"),
      getActionsLines: () => [],
      getMaxLength: () => 4096,
      streamDone,
      useSmartSplitting: false,
      safeEdit: async (_message, options) => {
        edits.push(options);
        return false;
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected terminal edit failure");
    expect(result.error).toMatchObject({
      _tag: "DiscordEmbedPusherInvariant",
      message: "startEmbedPusher failed to edit message message-1",
    });
    expect(edits).toHaveLength(1);
  });
});
