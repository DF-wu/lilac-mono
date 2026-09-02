import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { SurfaceAdapter } from "../../../src/surface/adapter";
import {
  createDiscordQuestionPort,
  DISCORD_QUESTION_ACTIVE_COLOR,
  DISCORD_QUESTION_CANCELLED_COLOR,
  DISCORD_QUESTION_INTERRUPTED_COLOR,
} from "../../../src/surface/discord/discord-question-port";
import type { ContentOpts, MsgRef, SendOpts, SessionRef } from "../../../src/surface/types";

describe("Discord question port", () => {
  it("posts an indexed card as a reply to the current turn", async () => {
    const sends: Array<{ session: SessionRef; content: ContentOpts; opts?: SendOpts }> = [];
    const adapter = {
      sendMsg: async (session: SessionRef, content: ContentOpts, opts?: SendOpts) => {
        sends.push({ session, content, opts });
        return Result.ok({ platform: "discord", channelId: "channel", messageId: "card" } as const);
      },
    } as unknown as SurfaceAdapter;
    const port = createDiscordQuestionPort({
      adapter,
      answers: {
        subscribeQuestionAnswers: async () => ({ stop: async () => undefined }),
      },
    });
    const prompt = {
      ordinal: 1,
      total: 2,
      header: "Deployment target",
      question: "Where should I deploy this?",
      options: [
        { index: 1, label: "Staging", description: "Deploy to staging.", token: "one" },
        { index: 2, label: "Production", description: "Deploy to production.", token: "two" },
      ],
      customToken: "custom",
    } as const;

    const presented = await port.present({
      sessionRef: { platform: "discord", channelId: "channel" },
      replyTo: { platform: "discord", channelId: "channel", messageId: "turn" },
      prompt,
    });
    expect(presented.status).toBe("ok");
    expect(sends).toEqual([
      {
        session: { platform: "discord", channelId: "channel" },
        content: {
          text: [
            "**Q: Deployment target (1/2)**",
            "",
            "Where should I deploy this?",
            "",
            "**1. Staging**",
            "Deploy to staging.",
            "",
            "**2. Production**",
            "Deploy to production.",
          ].join("\n"),
          format: "markdown",
          accentColor: DISCORD_QUESTION_ACTIVE_COLOR,
          actions: [
            { actionId: "question:v1:one:option:1", label: "1", style: "primary" },
            { actionId: "question:v1:two:option:2", label: "2", style: "primary" },
            { actionId: "question:v1:custom:custom", label: "Other…", style: "secondary" },
          ],
        },
        opts: {
          replyTo: { platform: "discord", channelId: "channel", messageId: "turn" },
        },
      },
    ]);
  });

  it("renders cancelled, expired, and interrupted terminal cards", async () => {
    const edits: ContentOpts[] = [];
    const port = createDiscordQuestionPort({
      adapter: {
        editMsg: async (_ref: MsgRef, content: ContentOpts) => {
          edits.push(content);
          return Result.ok(undefined);
        },
      } as unknown as SurfaceAdapter,
      answers: {
        subscribeQuestionAnswers: async () => ({ stop: async () => undefined }),
      },
    });
    const messageRef = { platform: "discord", channelId: "channel", messageId: "card" } as const;

    await port.finish({ messageRef, state: "cancelled" });
    await port.finish({ messageRef, state: "expired" });
    await port.finish({ messageRef, state: "interrupted" });

    expect(edits).toEqual([
      {
        text: "**Question cancelled**",
        format: "markdown",
        accentColor: DISCORD_QUESTION_CANCELLED_COLOR,
        actions: [],
      },
      {
        text: "**Question expired**",
        format: "markdown",
        accentColor: DISCORD_QUESTION_CANCELLED_COLOR,
        actions: [],
      },
      {
        text: "**Question interrupted**",
        format: "markdown",
        accentColor: DISCORD_QUESTION_INTERRUPTED_COLOR,
        actions: [],
      },
    ]);
  });
});
