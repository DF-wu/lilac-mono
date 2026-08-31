import { describe, expect, it } from "bun:test";

import {
  beginDiscordMessageLatencyTrace,
  finishDiscordMessageLatencyTrace,
  recordRequestLatencyStage,
} from "../../../src/surface/bridge/request-latency-trace";

describe("Discord request latency trace", () => {
  it("returns an end-to-end composition whose stages sum to the total", () => {
    const requestId = "discord:channel-1:message-1";
    beginDiscordMessageLatencyTrace({
      requestId,
      sessionId: "channel-1",
      messageId: "message-1",
      receivedAt: 1_000,
    });
    recordRequestLatencyStage(requestId, "adapterEventPublishedAt", 1_010);
    recordRequestLatencyStage(requestId, "routerReceivedAt", 1_030);
    recordRequestLatencyStage(requestId, "requestPublishedAt", 1_070);
    recordRequestLatencyStage(requestId, "runnerReceivedAt", 1_100);
    recordRequestLatencyStage(requestId, "replyPublishedAt", 1_600);
    recordRequestLatencyStage(requestId, "relayReceivedAt", 1_650);
    recordRequestLatencyStage(requestId, "typingRequestedAt", 1_680);

    const timing = finishDiscordMessageLatencyTrace(requestId, 1_800);

    expect(timing).toEqual({
      requestId,
      sessionId: "channel-1",
      messageId: "message-1",
      totalMs: 800,
      discordIngressMs: 10,
      adapterEventBusMs: 20,
      routerCompositionMs: 40,
      requestBusMs: 30,
      runnerAdmissionAndQueueMs: 500,
      replyBusMs: 50,
      relaySetupMs: 30,
      discordTypingApiMs: 120,
    });
    if (!timing) throw new Error("expected a complete timing trace");
    expect(
      timing.discordIngressMs +
        timing.adapterEventBusMs +
        timing.routerCompositionMs +
        timing.requestBusMs +
        timing.runnerAdmissionAndQueueMs +
        timing.replyBusMs +
        timing.relaySetupMs +
        timing.discordTypingApiMs,
    ).toBe(timing.totalMs);
  });

  it("keeps the first observation when a bus delivery is retried", () => {
    const requestId = "discord:channel-2:message-2";
    beginDiscordMessageLatencyTrace({
      requestId,
      sessionId: "channel-2",
      messageId: "message-2",
      receivedAt: 2_000,
    });
    recordRequestLatencyStage(requestId, "adapterEventPublishedAt", 2_010);
    recordRequestLatencyStage(requestId, "adapterEventPublishedAt", 9_000);
    recordRequestLatencyStage(requestId, "routerReceivedAt", 2_020);
    recordRequestLatencyStage(requestId, "requestPublishedAt", 2_030);
    recordRequestLatencyStage(requestId, "runnerReceivedAt", 2_040);
    recordRequestLatencyStage(requestId, "replyPublishedAt", 2_050);
    recordRequestLatencyStage(requestId, "relayReceivedAt", 2_060);
    recordRequestLatencyStage(requestId, "typingRequestedAt", 2_070);

    expect(finishDiscordMessageLatencyTrace(requestId, 2_080)?.discordIngressMs).toBe(10);
  });

  it("drops an incomplete trace when typing is confirmed", () => {
    const requestId = "discord:channel-3:message-3";
    beginDiscordMessageLatencyTrace({
      requestId,
      sessionId: "channel-3",
      messageId: "message-3",
      receivedAt: 3_000,
    });

    expect(finishDiscordMessageLatencyTrace(requestId, 3_100)).toBeNull();
    expect(finishDiscordMessageLatencyTrace(requestId, 3_200)).toBeNull();
  });
});
