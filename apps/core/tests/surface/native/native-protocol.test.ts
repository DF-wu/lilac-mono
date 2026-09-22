import { describe, expect, it } from "bun:test";
import type { LilacMessageForTopic } from "@stanley2058/lilac-event-bus";

import {
  projectAuthenticatedRequest,
  latchAuthenticatedRequest,
} from "../../../src/surface/authenticated-request";
import {
  nativeSessionId,
  nativeSurfaceProtocol,
  parseNativeRequestId,
} from "../../../src/surface/native/native-protocol";
import { resolveBuiltinSurfaceRequestMessageRef } from "../../../src/surface/builtin-surface-protocols";

type RequestMessage = Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>;

function nativeRequest(overrides: Record<string, unknown> = {}): RequestMessage {
  const requestDeliveryId = crypto.randomUUID();
  return {
    id: "1-0",
    topic: "cmd.request",
    type: "cmd.request.message",
    ts: 1,
    key: "run-1",
    headers: { request_id: "run-1", session_id: "native:thread-1", request_client: "native" },
    data: {
      requestDeliveryId,
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
      raw: {
        authenticatedActor: { platform: "native", userId: "owner" },
        authenticatedOrigin: {
          platform: "native",
          userId: "owner",
          messageRef: { platform: "native", channelId: "thread-1", messageId: "message-1" },
        },
        native: {
          threadId: "thread-1",
          authorUserId: "participant",
          starterUserId: "owner",
          turnId: "turn-1",
          historyGeneration: 0,
          inputId: "input-1",
          requestId: "run-1",
          requestDeliveryId,
          ...overrides,
        },
      },
    },
  };
}

describe("native surface references and authority projection", () => {
  it("maps namespaced sessions to raw thread references", () => {
    expect(nativeSessionId("thread-1")).toBe("native:thread-1");
    expect(nativeSurfaceProtocol.refs.createSessionRef("native:thread-1")).toEqual({
      platform: "native",
      channelId: "thread-1",
    });
    expect(parseNativeRequestId("native:thread-1:message-1")).toEqual({
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(parseNativeRequestId("native:thread-1:message-1:extra")).toBeNull();
    expect(
      nativeSurfaceProtocol.refs.decodeMessageRef({
        ref: { platform: "native", channelId: "thread-1", messageId: "message-1" },
        expectedSessionId: "native:thread-1",
      }).status,
    ).toBe("ok");
    expect(
      nativeSurfaceProtocol.refs.decodeMessageRef({
        ref: { platform: "native", channelId: "other", messageId: "message-1" },
        expectedSessionId: "native:thread-1",
      }).status,
    ).toBe("error");
  });

  it("rejects a reply target owned by another surface", () => {
    expect(
      resolveBuiltinSurfaceRequestMessageRef({
        protocol: nativeSurfaceProtocol,
        requestId: "discord:thread-1:message-1",
        sessionRef: { platform: "native", channelId: "thread-1" },
      }).kind,
    ).toBe("invalid");
  });

  it("keeps participant authorship separate from starter authority", () => {
    const result = projectAuthenticatedRequest(nativeRequest());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value?.authenticatedActor?.userId).toBe("owner");
    expect(result.value?.native?.authorUserId).toBe("participant");
    expect(result.value?.sessionRef).toEqual({ platform: "native", channelId: "thread-1" });
  });

  it.each([
    { threadId: "other" },
    { starterUserId: "participant" },
    { requestId: "other-run" },
    { requestDeliveryId: crypto.randomUUID() },
    { historyGeneration: -1 },
  ])("rejects mismatched or malformed native proof %j", (overrides) => {
    expect(projectAuthenticatedRequest(nativeRequest(overrides)).status).toBe("error");
  });

  it("requires native metadata even with actor claims", () => {
    const request = nativeRequest();
    request.data.raw = { authenticatedActor: { platform: "native", userId: "owner" } };
    expect(projectAuthenticatedRequest(request).status).toBe("error");
  });

  it("rejects native metadata on another platform", () => {
    const request = nativeRequest();
    expect(
      projectAuthenticatedRequest({
        ...request,
        headers: { ...request.headers, request_client: "discord" },
      }).status,
    ).toBe("error");
  });

  it("allows a steering author change without changing the starter or turn", () => {
    const first = projectAuthenticatedRequest(nativeRequest());
    const next = projectAuthenticatedRequest(
      nativeRequest({ authorUserId: "other-editor", inputId: "input-2" }),
    );
    if (first.status !== "ok" || next.status !== "ok" || !first.value || !next.value)
      throw new Error("fixture must project");
    expect(latchAuthenticatedRequest(first.value, next.value, "cmd.request.message").status).toBe(
      "ok",
    );
    expect(
      latchAuthenticatedRequest(
        first.value,
        { ...next.value, native: { ...next.value.native!, historyGeneration: 1 } },
        "cmd.request.message",
      ).status,
    ).toBe("error");
  });
});
