import { describe, expect, it } from "bun:test";

import {
  toBusEvtAdapterMessageCreated,
  toBusEvtAdapterMessageDeleted,
  toBusEvtAdapterMessageUpdated,
  toBusEvtAdapterReactionAdded,
  toBusEvtAdapterReactionRemoved,
} from "../../../src/surface/bridge/adapter-event-projection";
import type { SessionRef, SurfaceMessage } from "../../../src/surface/types";

/**
 * These mappers are shared by every adapter — `bridgeAdapterToBus` calls them
 * for whichever adapter it is bridging — so the platform must come from the
 * payload rather than being assumed.
 *
 * Getting this wrong is invisible to tests that publish bus events directly:
 * a Telegram message labelled `discord` is handed to the Discord router, which
 * reads `raw.discord`, finds nothing, and silently skips it. That is exactly
 * how it reached a live deployment.
 */
function surfaceMessage(session: SessionRef): SurfaceMessage {
  return {
    ref: { platform: session.platform, channelId: session.channelId, messageId: "10" },
    session,
    userId: "7",
    userName: "ada",
    text: "hello",
    ts: 1_700_000_000_000,
    raw: { [session.platform]: { isDMBased: true, mentionsBot: true } },
  };
}

const SESSIONS: SessionRef[] = [
  { platform: "discord", channelId: "c1" },
  { platform: "telegram", channelId: "1001" },
  { platform: "github", channelId: "owner/repo#1" },
];

describe("adapter bus mappers carry the originating platform", () => {
  for (const session of SESSIONS) {
    it(`message.created keeps ${session.platform}`, () => {
      const data = toBusEvtAdapterMessageCreated({
        type: "adapter.message.created",
        platform: session.platform,
        ts: 1,
        message: surfaceMessage(session),
      });

      expect(data.platform).toBe(session.platform);
      expect(data.channelId).toBe(session.channelId);
    });

    it(`message.updated keeps ${session.platform}`, () => {
      const data = toBusEvtAdapterMessageUpdated({
        type: "adapter.message.updated",
        platform: session.platform,
        ts: 1,
        message: surfaceMessage(session),
      });
      expect(data.platform).toBe(session.platform);
    });

    it(`message.deleted keeps ${session.platform}`, () => {
      const data = toBusEvtAdapterMessageDeleted({
        type: "adapter.message.deleted",
        platform: session.platform,
        messageRef: { platform: session.platform, channelId: session.channelId, messageId: "10" },
        session,
        ts: 1,
      });
      expect(data.platform).toBe(session.platform);
    });

    it(`reaction.added keeps ${session.platform}`, () => {
      const data = toBusEvtAdapterReactionAdded({
        type: "adapter.reaction.added",
        platform: session.platform,
        messageRef: { platform: session.platform, channelId: session.channelId, messageId: "10" },
        session,
        reaction: "👍",
        ts: 1,
      });
      expect(data.platform).toBe(session.platform);
    });

    it(`reaction.removed keeps ${session.platform}`, () => {
      const data = toBusEvtAdapterReactionRemoved({
        type: "adapter.reaction.removed",
        platform: session.platform,
        messageRef: { platform: session.platform, channelId: session.channelId, messageId: "10" },
        session,
        reaction: "👍",
        ts: 1,
      });
      expect(data.platform).toBe(session.platform);
    });
  }

  it("preserves the raw envelope, which the router keys off the platform to read", () => {
    const data = toBusEvtAdapterMessageCreated({
      type: "adapter.message.created",
      platform: "telegram",
      ts: 1,
      message: surfaceMessage({ platform: "telegram", channelId: "1001" }),
    });

    // A mislabelled platform makes getSurfaceFlags(raw, platform) look under
    // the wrong key and return no flags at all, which reads downstream as
    // "not a DM, no mention" and skips the message.
    expect(data.platform).toBe("telegram");
    expect(data.raw).toEqual({ telegram: { isDMBased: true, mentionsBot: true } });
  });
});
