import { describe, expect, it } from "bun:test";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

import { resolveAuthenticatedOrigin } from "../../src/tool-server/request-message-cache";
import { isSurfaceRefPlatform, type SurfacePrincipalPlatform } from "../../src/surface/types";

/**
 * Widening the TypeScript union was not enough here.
 *
 * These validators run at runtime, so leaving the zod enums narrow silently
 * dropped every Telegram origin: the request still received a Level-2
 * capability, but the run was unattributed because the principal never
 * resolved.
 */
type CacheMessage = Parameters<typeof resolveAuthenticatedOrigin>[0];

function message(platform: AdapterPlatform): CacheMessage {
  const msg: CacheMessage = {
    id: "1-0",
    ts: 1_700_000_000_000,
    topic: "cmd.request",
    type: "cmd.request.message",
    key: `${platform}:1:2`,
    headers: {
      request_id: `${platform}:1:2`,
      session_id: "1",
      request_client: platform,
    },
    data: {
      queue: "prompt",
      messages: [],
      raw: {
        authenticatedOrigin: {
          platform,
          userId: "7",
          messageRef: { platform, channelId: "1", messageId: "2" },
        },
      },
    },
  };

  return msg;
}

const PRINCIPAL_PLATFORMS: SurfacePrincipalPlatform[] = ["discord", "github", "telegram"];

describe("authenticated request origin accepts every principal surface", () => {
  it("narrows a decoded adapter platform to referenceable surfaces", () => {
    const referenceable: AdapterPlatform = "telegram";
    const nonReferenceable: AdapterPlatform = "slack";

    expect(isSurfaceRefPlatform(referenceable)).toBe(true);
    expect(isSurfaceRefPlatform(nonReferenceable)).toBe(false);
  });

  for (const platform of PRINCIPAL_PLATFORMS) {
    it(`resolves a ${platform} origin`, () => {
      const origin = resolveAuthenticatedOrigin(message(platform)).unwrap();

      expect(origin?.platform).toBe(platform);
      expect(origin?.authenticatedOrigin?.userId).toBe("7");
      expect(origin?.messageRef?.platform).toBe(platform);
    });
  }

  it("still rejects a surface that cannot act as a principal", () => {
    // slack is a valid AdapterPlatform but deliberately not a principal one,
    // so this proves the check is real rather than accepting anything.
    const origin = resolveAuthenticatedOrigin(message("slack"));
    expect(origin.status).toBe("error");
    expect(origin.match({ ok: (value) => value, err: () => undefined })).toBeUndefined();
  });

  it("rejects an origin whose envelope disagrees with the request client", () => {
    const mismatched = message("telegram");
    const data = mismatched.data as { raw: { authenticatedOrigin: { platform: string } } };
    data.raw.authenticatedOrigin.platform = "discord";

    const origin = resolveAuthenticatedOrigin(mismatched);
    expect(origin.status).toBe("error");
    expect(origin.match({ ok: (value) => value, err: () => undefined })).toBeUndefined();
  });
});
