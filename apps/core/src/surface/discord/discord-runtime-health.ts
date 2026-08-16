import type { DiscordAdapterHealthSnapshot } from "./discord-adapter";
import type { SurfaceRuntimeHealthPort } from "../runtime-descriptor";

const DISCORD_DISCONNECT_GRACE_MS = 60_000;
const DISCORD_GATEWAY_STALE_MS = 60_000;

export type DiscordRuntimeHealthProvider = {
  getHealthSnapshot(options?: { includeCache?: boolean }): DiscordAdapterHealthSnapshot;
};

export function createDiscordRuntimeHealthPort(
  provider: DiscordRuntimeHealthProvider,
): SurfaceRuntimeHealthPort {
  return {
    getContribution: ({ now, runtimeFullyStarted, includeMemoryDiagnostics }) => {
      const discord = provider.getHealthSnapshot({ includeCache: includeMemoryDiagnostics });
      const disconnectedForMs = discord.lastDisconnectAt ? now - discord.lastDisconnectAt : 0;
      const gatewayEventStaleForMs = discord.lastGatewayEventAt
        ? now - discord.lastGatewayEventAt
        : null;
      const gatewayPingStaleForMs = discord.lastGatewayPingAt
        ? now - discord.lastGatewayPingAt
        : null;
      const gatewayEventFresh =
        gatewayEventStaleForMs !== null && gatewayEventStaleForMs < DISCORD_GATEWAY_STALE_MS;
      const gatewayPingFresh =
        Number.isFinite(discord.gatewayPingMs) &&
        gatewayPingStaleForMs !== null &&
        gatewayPingStaleForMs < DISCORD_GATEWAY_STALE_MS;

      return {
        checks: [
          {
            name: "discord.ready",
            ok: !runtimeFullyStarted || discord.isReady,
            impact: "ready",
            reason:
              !runtimeFullyStarted || discord.isReady ? undefined : "discord gateway is not ready",
            details: discord,
          },
          {
            name: "discord.connection",
            ok:
              !runtimeFullyStarted ||
              discord.isReady ||
              disconnectedForMs < DISCORD_DISCONNECT_GRACE_MS,
            impact: "live",
            reason:
              !runtimeFullyStarted ||
              discord.isReady ||
              disconnectedForMs < DISCORD_DISCONNECT_GRACE_MS
                ? undefined
                : `discord gateway disconnected for ${disconnectedForMs}ms`,
            details: {
              connectionState: discord.connectionState,
              disconnectedForMs,
              thresholdMs: DISCORD_DISCONNECT_GRACE_MS,
            },
          },
          {
            name: "discord.gateway",
            ok: !runtimeFullyStarted || !discord.isReady || gatewayEventFresh || gatewayPingFresh,
            impact: "live",
            reason:
              !runtimeFullyStarted || !discord.isReady || gatewayEventFresh || gatewayPingFresh
                ? undefined
                : `discord gateway dispatches and heartbeat acknowledgements are stale (event=${gatewayEventStaleForMs ?? "unknown"}ms, ping=${gatewayPingStaleForMs ?? "unknown"}ms)`,
            details: {
              lastGatewayEventAt: discord.lastGatewayEventAt,
              lastGatewayPingAt: discord.lastGatewayPingAt,
              gatewayPingMs: discord.gatewayPingMs,
              eventStaleForMs: gatewayEventStaleForMs,
              pingStaleForMs: gatewayPingStaleForMs,
              thresholdMs: DISCORD_GATEWAY_STALE_MS,
            },
          },
        ],
        info: discord,
        ...(includeMemoryDiagnostics && discord.cache ? { memoryDiagnostics: discord.cache } : {}),
      };
    },
  };
}
