import { describe, expect, it } from "bun:test";

import {
  connectCurrentSurfaceAdapters,
  createCurrentWorkflowAdapterMap,
  disconnectCurrentSurfaceAdapters,
  restoreCurrentSurfaceRecovery,
  startCurrentSurfaceOutputs,
  stopIngressAndDrainCurrentSurfaceRecovery,
  stopCurrentSurfaceOutputs,
} from "../../src/runtime/current-surface-runtime-lifecycle";
import type { AgentRunnerRecoveryEntry } from "../../src/surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../../src/surface/bridge/subscribe-from-bus";

const agentEntry: AgentRunnerRecoveryEntry = {
  kind: "active",
  requestId: "discord:session:request",
  sessionId: "session",
  requestClient: "discord",
  queue: "prompt",
  messages: [],
};

function relaySnapshot(
  platform: "discord" | "github",
  requestId: string,
): BusToAdapterRelaySnapshot {
  return {
    requestId,
    sessionId: "session",
    requestClient: platform,
    platform,
    createdOutputRefs: [],
    visibleText: platform,
    toolStatus: [],
  };
}

describe("current surface runtime lifecycle parity", () => {
  it("keeps one unique workflow adapter slot for each currently implemented platform", () => {
    type TestAdapter = { readonly platform: "discord" | "github" };
    const discordAdapter: TestAdapter = { platform: "discord" };
    const githubAdapter: TestAdapter = { platform: "github" };
    const adapters = createCurrentWorkflowAdapterMap({ discordAdapter, githubAdapter });

    expect([...adapters.keys()]).toEqual(["discord", "github"]);
    expect(new Set(adapters.keys()).size).toBe(adapters.size);
    expect(adapters.get("discord")).toBe(discordAdapter);
    expect(adapters.get("github")).toBe(githubAdapter);
  });

  it("preserves adapter connection and surface output activation order", async () => {
    const calls: string[] = [];
    const operation = (name: string) => async () => {
      calls.push(name);
    };

    await connectCurrentSurfaceAdapters({
      discordAdapter: { connect: operation("discord-connect") },
      githubAdapter: { connect: operation("github-connect") },
    });
    await startCurrentSurfaceOutputs({
      startDiscordRelay: operation("discord-relay"),
      resolveGithubOperations: async () => {
        calls.push("github-availability");
        return {
          startRequestIngress: operation("github-request-ingress"),
          startRelay: operation("github-relay"),
        };
      },
    });

    expect(calls).toEqual([
      "discord-connect",
      "github-connect",
      "discord-relay",
      "github-availability",
      "github-request-ingress",
      "github-relay",
    ]);
  });

  it.each([
    ["request ingress", true, false, ["discord-relay", "github-request-ingress"]],
    ["relay", false, true, ["discord-relay", "github-relay"]],
    ["neither", false, false, ["discord-relay"]],
  ] as const)("activates GitHub %s independently", async (_, requestIngress, relay, expected) => {
    const calls: string[] = [];
    const operation = (name: string) => async () => {
      calls.push(name);
    };

    await startCurrentSurfaceOutputs({
      startDiscordRelay: operation("discord-relay"),
      resolveGithubOperations: async () => ({
        ...(requestIngress ? { startRequestIngress: operation("github-request-ingress") } : {}),
        ...(relay ? { startRelay: operation("github-relay") } : {}),
      }),
    });

    expect(calls).toEqual([...expected]);
  });

  it("stops ingress and request producers before draining and collecting one snapshot", async () => {
    const calls: string[] = [];
    const discordSnapshot = relaySnapshot("discord", "discord-request");
    const githubSnapshot = relaySnapshot("github", "github-request");
    const relay = (platform: "discord" | "github", snapshot: BusToAdapterRelaySnapshot) => ({
      beginDrain: async ({ deadlineMs }: { readonly deadlineMs: number }) => {
        calls.push(`${platform}-drain:${deadlineMs}`);
      },
      snapshotRelays: () => {
        calls.push(`${platform}-snapshot`);
        return [snapshot];
      },
      restoreRelays: async () => {},
    });

    const snapshot = await stopIngressAndDrainCurrentSurfaceRecovery({
      stopAdapterIngress: async () => {
        calls.push("adapter-ingress-stop");
      },
      stopRouterIngress: async () => {
        calls.push("router-ingress-stop");
      },
      stopWorkflowRequestProducers: async () => {
        calls.push("request-producers-stop");
      },
      stopGithubRequestIngress: async () => {
        calls.push("github-request-ingress-stop");
      },
      stopRemainingRequestProducers: async () => {
        calls.push("remaining-producers-stop");
      },
      deadlineMs: 3_000,
      runCleanup: async (label, cleanup) => {
        calls.push(label);
        await cleanup?.();
      },
      agentRunner: {
        beginDrain: async ({ deadlineMs }) => {
          calls.push(`agent-drain:${deadlineMs}`);
        },
        snapshotRecoverables: () => {
          calls.push("agent-snapshot");
          return [agentEntry];
        },
        restoreRecoverables: () => {},
      },
      discordRelay: relay("discord", discordSnapshot),
      githubRelay: relay("github", githubSnapshot),
    });

    expect(calls).toEqual([
      "adapter-ingress-stop",
      "router-ingress-stop",
      "request-producers-stop",
      "github-request-ingress-stop",
      "remaining-producers-stop",
      "graceful.agentRunner.beginDrain",
      "agent-drain:3000",
      "graceful.discordBridge.beginDrain",
      "discord-drain:3000",
      "graceful.githubBridge.beginDrain",
      "github-drain:3000",
      "agent-snapshot",
      "discord-snapshot",
      "github-snapshot",
    ]);
    expect(snapshot).toEqual({
      agent: [agentEntry],
      relays: [discordSnapshot, githubSnapshot],
    });
  });

  it("dispatches only platform-matching relay restores before agent restore", async () => {
    const calls: string[] = [];
    const discordSnapshot = relaySnapshot("discord", "discord-request");
    const githubSnapshot = relaySnapshot("github", "github-request");

    await restoreCurrentSurfaceRecovery({
      snapshot: {
        agent: [agentEntry],
        relays: [githubSnapshot, discordSnapshot],
      },
      discordRelay: {
        restoreRelays: async (snapshots) => {
          calls.push(`discord:${snapshots.map((snapshot) => snapshot.requestId).join(",")}`);
        },
      },
      githubRelay: {
        restoreRelays: async (snapshots) => {
          calls.push(`github:${snapshots.map((snapshot) => snapshot.requestId).join(",")}`);
        },
      },
      agentRunner: {
        restoreRecoverables: (entries) => {
          calls.push(`agent:${entries.map((entry) => entry.requestId).join(",")}`);
        },
      },
    });

    expect(calls).toEqual([
      "discord:discord-request",
      "github:github-request",
      "agent:discord:session:request",
    ]);
  });

  it("stops surface resources in deterministic reverse ownership order", async () => {
    const calls: string[] = [];
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      await cleanup?.();
    };

    await stopCurrentSurfaceOutputs({
      runCleanup,
      discordRelay: {
        stop: async () => {
          calls.push("discord-relay-stopped");
        },
      },
      githubRelay: {
        stop: async () => {
          calls.push("github-relay-stopped");
        },
      },
      githubRequestIngress: {
        stop: async () => {
          calls.push("github-ingress-stopped");
        },
      },
    });
    await disconnectCurrentSurfaceAdapters({
      runCleanup,
      discordAdapter: {
        disconnect: async () => {
          calls.push("discord-disconnected");
        },
      },
      githubAdapter: {
        disconnect: async () => {
          calls.push("github-disconnected");
        },
      },
    });

    expect(calls).toEqual([
      "bridgeGithubBusToAdapter.stop",
      "github-relay-stopped",
      "githubWebhook.stop",
      "github-ingress-stopped",
      "bridgeBusToAdapter.stop",
      "discord-relay-stopped",
      "githubAdapter.disconnect",
      "github-disconnected",
      "adapter.disconnect",
      "discord-disconnected",
    ]);
  });
});
