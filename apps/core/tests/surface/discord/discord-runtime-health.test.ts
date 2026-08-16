import { describe, expect, it } from "bun:test";

import {
  createDiscordRuntimeHealthPort,
  type DiscordRuntimeHealthProvider,
} from "../../../src/surface/discord/discord-runtime-health";
import {
  DISCORD_CACHE_LIMITS,
  type DiscordAdapterHealthSnapshot,
} from "../../../src/surface/discord/discord-adapter";

function provider(snapshot: DiscordAdapterHealthSnapshot): DiscordRuntimeHealthProvider {
  return {
    getHealthSnapshot: () => snapshot,
  };
}

describe("Discord runtime health", () => {
  it("suppresses readiness and liveness failures until runtime startup completes", async () => {
    const contribution = await createDiscordRuntimeHealthPort(
      provider({
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: 1,
      }),
    ).getContribution({
      now: 120_000,
      runtimeFullyStarted: false,
      includeMemoryDiagnostics: false,
    });

    expect(contribution.checks.map((check) => [check.name, check.ok, check.impact])).toEqual([
      ["discord.ready", true, "ready"],
      ["discord.connection", true, "live"],
      ["discord.gateway", true, "live"],
    ]);
  });

  it("preserves disconnect grace and stale gateway policy", async () => {
    const disconnected = await createDiscordRuntimeHealthPort(
      provider({
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: 1,
      }),
    ).getContribution({
      now: 60_002,
      runtimeFullyStarted: true,
      includeMemoryDiagnostics: false,
    });
    expect(disconnected.checks).toMatchObject([
      { name: "discord.ready", ok: false, impact: "ready" },
      {
        name: "discord.connection",
        ok: false,
        impact: "live",
        details: { disconnectedForMs: 60_001, thresholdMs: 60_000 },
      },
      { name: "discord.gateway", ok: true, impact: "live" },
    ]);

    const stale = await createDiscordRuntimeHealthPort(
      provider({
        connectionState: "ready",
        isReady: true,
        lastGatewayEventAt: 1,
        lastGatewayPingAt: 1,
        gatewayPingMs: 10,
      }),
    ).getContribution({
      now: 60_002,
      runtimeFullyStarted: true,
      includeMemoryDiagnostics: false,
    });
    expect(stale.checks[2]).toMatchObject({
      name: "discord.gateway",
      ok: false,
      impact: "live",
      details: {
        eventStaleForMs: 60_001,
        pingStaleForMs: 60_001,
        thresholdMs: 60_000,
      },
    });
  });

  it("returns the adapter snapshot and optional cache diagnostics unchanged", async () => {
    const snapshot: DiscordAdapterHealthSnapshot = {
      connectionState: "ready",
      isReady: true,
      lastGatewayEventAt: 99_999,
      cache: {
        perManagerLimits: DISCORD_CACHE_LIMITS,
        aggregateSizes: {
          MessageManager: 1,
          GuildMemberManager: 2,
          PresenceManager: 3,
          ThreadMemberManager: 4,
          UserManager: 5,
        },
      },
    };
    const contribution = await createDiscordRuntimeHealthPort(provider(snapshot)).getContribution({
      now: 100_000,
      runtimeFullyStarted: true,
      includeMemoryDiagnostics: true,
    });

    expect(contribution.checks[2]).toMatchObject({ name: "discord.gateway", ok: true });
    expect(contribution.info).toBe(snapshot);
    expect(contribution.memoryDiagnostics).toBe(snapshot.cache);
  });
});
