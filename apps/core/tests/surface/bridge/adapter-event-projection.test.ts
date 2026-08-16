import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  toBusEvtAdapterMessageCreated,
  toBusEvtAdapterMessageDeleted,
  toBusEvtAdapterMessageUpdated,
  toBusEvtAdapterReactionAdded,
  toBusEvtAdapterReactionRemoved,
} from "../../../src/surface/bridge/adapter-event-projection";
import type { AdapterEvent } from "../../../src/surface/events";
import type { MsgRef, SessionRef } from "../../../src/surface/types";

type MessageCreatedEvent = Extract<AdapterEvent, { type: "adapter.message.created" }>;
type MessageUpdatedEvent = Extract<AdapterEvent, { type: "adapter.message.updated" }>;
type MessageDeletedEvent = Extract<AdapterEvent, { type: "adapter.message.deleted" }>;
type ReactionAddedEvent = Extract<AdapterEvent, { type: "adapter.reaction.added" }>;
type ReactionRemovedEvent = Extract<AdapterEvent, { type: "adapter.reaction.removed" }>;

const discordMessage = {
  ref: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
  session: { platform: "discord", channelId: "channel-1", guildId: "guild-1" },
  userId: "user-1",
  userName: "Alice",
  text: "hello",
  ts: 1_700_000_000_001,
  raw: { discord: { mentionsBot: false } },
} satisfies MessageCreatedEvent["message"];

const githubMessage = {
  ref: { platform: "github", channelId: "owner/repo#1", messageId: "42" },
  session: { platform: "github", channelId: "owner/repo#1" },
  userId: "octocat",
  userName: "Octocat",
  text: "github hello",
  ts: 1_700_000_000_501,
  raw: { github: { issueNumber: 1 } },
} satisfies MessageCreatedEvent["message"];

type RefPlatform = MsgRef["platform"];
type PlatformTriple = {
  event: RefPlatform;
  session: RefPlatform;
  messageRef: RefPlatform;
};

const sessionRefs = {
  discord: discordMessage.session,
  github: githubMessage.session,
  telegram: { platform: "telegram", channelId: "-1001:42" },
} satisfies Record<RefPlatform, SessionRef>;

const messageRefs = {
  discord: discordMessage.ref,
  github: githubMessage.ref,
  telegram: { platform: "telegram", channelId: "-1001:42", messageId: "84" },
} satisfies Record<RefPlatform, MsgRef>;

function expectPanic(callback: () => unknown): void {
  let caught: unknown;
  try {
    callback();
  } catch (cause) {
    caught = cause;
  }
  expect(Panic.is(caught)).toBe(true);
}

function expectPlatformMismatchMatrix(project: (platforms: PlatformTriple) => unknown): void {
  expectPanic(() => project({ event: "github", session: "discord", messageRef: "discord" }));
  expectPanic(() => project({ event: "discord", session: "github", messageRef: "discord" }));
  expectPanic(() => project({ event: "discord", session: "discord", messageRef: "github" }));
  expectPanic(() => project({ event: "telegram", session: "discord", messageRef: "discord" }));
  expectPanic(() => project({ event: "discord", session: "telegram", messageRef: "discord" }));
  expectPanic(() => project({ event: "discord", session: "discord", messageRef: "telegram" }));
}

describe("adapter event bus projection", () => {
  it("preserves the literal Discord payload fixtures", () => {
    const created = {
      type: "adapter.message.created",
      platform: "discord",
      ts: 1_700_000_000_099,
      message: discordMessage,
      channelName: "general",
    } satisfies MessageCreatedEvent;
    const updated = {
      type: "adapter.message.updated",
      platform: "discord",
      ts: 1_700_000_000_199,
      message: { ...discordMessage, text: "hello edited", ts: 1_700_000_000_101 },
      channelName: "general",
    } satisfies MessageUpdatedEvent;
    const deleted = {
      type: "adapter.message.deleted",
      platform: "discord",
      ts: 1_700_000_000_201,
      messageRef: discordMessage.ref,
      session: discordMessage.session,
      channelName: "general",
      raw: { discord: { deleted: true } },
    } satisfies MessageDeletedEvent;
    const reactionAdded = {
      type: "adapter.reaction.added",
      platform: "discord",
      ts: 1_700_000_000_301,
      messageRef: discordMessage.ref,
      session: discordMessage.session,
      channelName: "general",
      reaction: "thumbsup",
      userId: "user-2",
      userName: "Bob",
      raw: { discord: { reaction: "thumbsup" } },
    } satisfies ReactionAddedEvent;
    const reactionRemoved = {
      ...reactionAdded,
      type: "adapter.reaction.removed",
      ts: 1_700_000_000_401,
    } satisfies ReactionRemovedEvent;

    expect(toBusEvtAdapterMessageCreated(created)).toEqual({
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      userId: "user-1",
      userName: "Alice",
      text: "hello",
      ts: 1_700_000_000_001,
      raw: { discord: { mentionsBot: false } },
    });
    expect(toBusEvtAdapterMessageUpdated(updated)).toEqual({
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      userId: "user-1",
      userName: "Alice",
      text: "hello edited",
      ts: 1_700_000_000_101,
      raw: { discord: { mentionsBot: false } },
    });
    expect(toBusEvtAdapterMessageDeleted(deleted)).toEqual({
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      ts: 1_700_000_000_201,
      raw: { discord: { deleted: true } },
    });
    expect(toBusEvtAdapterReactionAdded(reactionAdded)).toEqual({
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      reaction: "thumbsup",
      userId: "user-2",
      userName: "Bob",
      ts: 1_700_000_000_301,
      raw: { discord: { reaction: "thumbsup" } },
    });
    expect(toBusEvtAdapterReactionRemoved(reactionRemoved)).toEqual({
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      reaction: "thumbsup",
      userId: "user-2",
      userName: "Bob",
      ts: 1_700_000_000_401,
      raw: { discord: { reaction: "thumbsup" } },
    });
  });

  it("projects valid GitHub fixtures for every adapter event", () => {
    expect(
      toBusEvtAdapterMessageCreated({
        type: "adapter.message.created",
        platform: "github",
        ts: 1_700_000_000_599,
        message: githubMessage,
        channelName: "Issue 1",
      }),
    ).toEqual({
      platform: "github",
      channelId: "owner/repo#1",
      channelName: "Issue 1",
      messageId: "42",
      userId: "octocat",
      userName: "Octocat",
      text: "github hello",
      ts: 1_700_000_000_501,
      raw: { github: { issueNumber: 1 } },
    });
    expect(
      toBusEvtAdapterMessageUpdated({
        type: "adapter.message.updated",
        platform: "github",
        ts: 1_700_000_000_699,
        message: { ...githubMessage, text: "github edited", ts: 1_700_000_000_601 },
        channelName: "Issue 1",
      }),
    ).toEqual({
      platform: "github",
      channelId: "owner/repo#1",
      channelName: "Issue 1",
      messageId: "42",
      userId: "octocat",
      userName: "Octocat",
      text: "github edited",
      ts: 1_700_000_000_601,
      raw: { github: { issueNumber: 1 } },
    });
    expect(
      toBusEvtAdapterMessageDeleted({
        type: "adapter.message.deleted",
        platform: "github",
        ts: 1_700_000_000_701,
        messageRef: githubMessage.ref,
        session: githubMessage.session,
        channelName: "Issue 1",
        raw: { github: { deleted: true } },
      }),
    ).toEqual({
      platform: "github",
      channelId: "owner/repo#1",
      channelName: "Issue 1",
      messageId: "42",
      ts: 1_700_000_000_701,
      raw: { github: { deleted: true } },
    });
    expect(
      toBusEvtAdapterReactionAdded({
        type: "adapter.reaction.added",
        platform: "github",
        ts: 1_700_000_000_801,
        messageRef: githubMessage.ref,
        session: githubMessage.session,
        channelName: "Issue 1",
        reaction: "+1",
        userId: "hubot",
        userName: "Hubot",
        raw: { github: { reaction: "+1" } },
      }),
    ).toEqual({
      platform: "github",
      channelId: "owner/repo#1",
      channelName: "Issue 1",
      messageId: "42",
      reaction: "+1",
      userId: "hubot",
      userName: "Hubot",
      ts: 1_700_000_000_801,
      raw: { github: { reaction: "+1" } },
    });
    expect(
      toBusEvtAdapterReactionRemoved({
        type: "adapter.reaction.removed",
        platform: "github",
        ts: 1_700_000_000_901,
        messageRef: githubMessage.ref,
        session: githubMessage.session,
        channelName: "Issue 1",
        reaction: "+1",
        userId: "hubot",
        userName: "Hubot",
        raw: { github: { reaction: "+1" } },
      }),
    ).toEqual({
      platform: "github",
      channelId: "owner/repo#1",
      channelName: "Issue 1",
      messageId: "42",
      reaction: "+1",
      userId: "hubot",
      userName: "Hubot",
      ts: 1_700_000_000_901,
      raw: { github: { reaction: "+1" } },
    });
  });

  it("rejects every independently supplied platform mismatch for message creation", () => {
    expectPlatformMismatchMatrix((platforms) =>
      toBusEvtAdapterMessageCreated({
        type: "adapter.message.created",
        platform: platforms.event,
        ts: 2,
        message: {
          ...discordMessage,
          ref: messageRefs[platforms.messageRef],
          session: sessionRefs[platforms.session],
        },
      }),
    );
  });

  it("rejects every independently supplied platform mismatch for message updates", () => {
    expectPlatformMismatchMatrix((platforms) =>
      toBusEvtAdapterMessageUpdated({
        type: "adapter.message.updated",
        platform: platforms.event,
        ts: 2,
        message: {
          ...discordMessage,
          ref: messageRefs[platforms.messageRef],
          session: sessionRefs[platforms.session],
        },
      }),
    );
  });

  it("rejects every independently supplied platform mismatch for message deletion", () => {
    expectPlatformMismatchMatrix((platforms) =>
      toBusEvtAdapterMessageDeleted({
        type: "adapter.message.deleted",
        platform: platforms.event,
        ts: 2,
        messageRef: messageRefs[platforms.messageRef],
        session: sessionRefs[platforms.session],
      }),
    );
  });

  it("rejects every independently supplied platform mismatch for reaction addition", () => {
    expectPlatformMismatchMatrix((platforms) =>
      toBusEvtAdapterReactionAdded({
        type: "adapter.reaction.added",
        platform: platforms.event,
        ts: 2,
        messageRef: messageRefs[platforms.messageRef],
        session: sessionRefs[platforms.session],
        reaction: "thumbsup",
      }),
    );
  });

  it("rejects every independently supplied platform mismatch for reaction removal", () => {
    expectPlatformMismatchMatrix((platforms) =>
      toBusEvtAdapterReactionRemoved({
        type: "adapter.reaction.removed",
        platform: platforms.event,
        ts: 2,
        messageRef: messageRefs[platforms.messageRef],
        session: sessionRefs[platforms.session],
        reaction: "thumbsup",
      }),
    );
  });
});
