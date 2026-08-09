import { describe, expect, it } from "bun:test";

import {
  connectAndValidateSurfaceAdapters,
  createSurfaceAdapterMap,
  disconnectSurfaceAdapters,
  restoreSurfaceRecovery,
  startSurfaceAdapterIngress,
  startSurfaceOutputs,
  stopIngressAndDrainSurfaceRecovery,
  stopSurfaceAdapterIngress,
  stopSurfaceOutputs,
  stopSurfaceRequestIngress,
  type ConnectedSurfaceAdapters,
  type SurfaceAdapterIngressHandles,
  type SurfaceRelayHandles,
  type SurfaceRequestIngressHandles,
} from "../../src/runtime/surface-runtime-lifecycle";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import type { AgentRunnerRecoveryEntry } from "../../src/surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../../src/surface/bridge/subscribe-from-bus";
import { createDiscordSurfaceRuntimeDescriptor } from "../../src/surface/discord/discord-runtime-descriptor";
import { createGithubSurfaceRuntimeDescriptor } from "../../src/surface/github/github-runtime-descriptor";
import {
  SurfaceRuntimeRegistry,
  type SurfaceRelayHandle,
} from "../../src/surface/runtime-descriptor";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfacePlatform,
  SurfaceSelf,
  SurfaceSession,
} from "../../src/surface/types";

const agentEntry: AgentRunnerRecoveryEntry = {
  kind: "active",
  requestId: "discord:session:request",
  sessionId: "session",
  requestClient: "discord",
  queue: "prompt",
  messages: [],
};

class TestAdapter implements SurfaceAdapter {
  constructor(
    private readonly platform: SurfacePlatform,
    private readonly calls: string[],
    private readonly connectFailure?: Error,
  ) {}

  async connect(): Promise<void> {
    this.calls.push(`${this.platform}-connect`);
    if (this.connectFailure) throw this.connectFailure;
  }

  async disconnect(): Promise<void> {
    this.calls.push(`${this.platform}-disconnected`);
  }

  async getSelf(): Promise<SurfaceSelf> {
    this.calls.push(`${this.platform}-validate`);
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }

  async startOutput(
    _sessionRef: SessionRef,
    _opts?: StartOutputOpts,
  ): Promise<SurfaceOutputStream> {
    return {
      push: async () => undefined,
      finish: async () => ({
        created: [{ platform: "discord", channelId: "channel", messageId: "message" }],
        last: { platform: "discord", channelId: "channel", messageId: "message" },
      }),
      abort: async () => undefined,
    };
  }

  async sendMsg(sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    return { platform: "discord", channelId: sessionRef.channelId, messageId: "message" };
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return null;
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    return [];
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {}

  async deleteMsg(_msgRef: MsgRef): Promise<void> {}

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    return [];
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {}

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {}

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [];
  }

  async subscribe(_handler: AdapterEventHandler) {
    return { stop: async () => undefined };
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    return [];
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {}
}

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

function emptyRelayHandle<P extends "discord" | "github">(
  platform: P,
  stop: () => Promise<void> = async () => undefined,
): SurfaceRelayHandle<P> {
  return {
    platform,
    beginDrain: async () => undefined,
    snapshotRelays: () => [],
    restoreRelays: async () => undefined,
    stop,
  };
}

function createRegistry(input: {
  readonly calls: string[];
  readonly discordAdapter?: SurfaceAdapter;
  readonly githubAdapter?: SurfaceAdapter;
  readonly adapterIngressStart?: () => Promise<{
    readonly platform: "discord";
    stop(): Promise<void>;
  }>;
  readonly discordRelayStart?: () => Promise<SurfaceRelayHandle<"discord">>;
  readonly githubRequestIngressStart?: () => Promise<{ stop(): Promise<void> }>;
  readonly githubRelayStart?: () => Promise<SurfaceRelayHandle<"github">>;
}): SurfaceRuntimeRegistry {
  const discordAdapter = input.discordAdapter ?? new TestAdapter("discord", input.calls);
  const githubAdapter = input.githubAdapter ?? new TestAdapter("github", input.calls);
  const created = SurfaceRuntimeRegistry.create([
    createDiscordSurfaceRuntimeDescriptor({
      adapter: discordAdapter,
      adapterIngress: {
        start:
          input.adapterIngressStart ??
          (async () => ({ platform: "discord", stop: async () => undefined })),
      },
      relay: {
        lifecycle: {
          platform: "discord",
          start: input.discordRelayStart ?? (async () => emptyRelayHandle("discord")),
        },
      },
    }),
    createGithubSurfaceRuntimeDescriptor({
      adapter: githubAdapter,
      ...(input.githubRequestIngressStart
        ? { requestIngress: { start: input.githubRequestIngressStart } }
        : {}),
      ...(input.githubRelayStart
        ? {
            relay: {
              lifecycle: { platform: "github" as const, start: input.githubRelayStart },
            },
          }
        : {}),
    }),
  ]);
  if (created.status === "error") throw created.error;
  return created.value;
}

function maps() {
  return {
    connected: new Map() as ConnectedSurfaceAdapters,
    adapterIngress: new Map() as SurfaceAdapterIngressHandles,
    requestIngress: new Map() as SurfaceRequestIngressHandles,
    relays: new Map() as SurfaceRelayHandles,
  };
}

describe("surface runtime lifecycle", () => {
  it("derives the workflow adapter map from unique registry entries", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const adapters = createSurfaceAdapterMap(registry);

    expect([...adapters.keys()]).toEqual(["discord", "github"]);
    expect(new Set(adapters.keys()).size).toBe(adapters.size);
    expect(adapters.get("discord")).toBe(registry.get("discord")?.adapter);
    expect(adapters.get("github")).toBe(registry.get("github")?.adapter);
  });

  it("preserves adapter ingress, connection, validation, and output activation phases", async () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      adapterIngressStart: async () => {
        calls.push("discord-adapter-ingress");
        return { platform: "discord", stop: async () => undefined };
      },
      discordRelayStart: async () => {
        calls.push("discord-relay");
        return emptyRelayHandle("discord");
      },
      githubRequestIngressStart: async () => {
        calls.push("github-request-ingress");
        return { stop: async () => undefined };
      },
      githubRelayStart: async () => {
        calls.push("github-relay");
        return emptyRelayHandle("github");
      },
    });
    const handles = maps();

    await startSurfaceAdapterIngress({ registry, handles: handles.adapterIngress });
    await connectAndValidateSurfaceAdapters({ registry, connected: handles.connected });
    await startSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
    });

    expect(calls).toEqual([
      "discord-adapter-ingress",
      "discord-connect",
      "github-connect",
      "discord-validate",
      "github-validate",
      "discord-relay",
      "github-request-ingress",
      "github-relay",
    ]);
    expect([...handles.connected.keys()]).toEqual(["discord", "github"]);
    expect([...handles.adapterIngress.keys()]).toEqual(["discord"]);
    expect([...handles.requestIngress.keys()]).toEqual(["github"]);
    expect([...handles.relays.keys()]).toEqual(["discord", "github"]);
  });

  it.each([
    ["request ingress", true, false, ["discord-relay", "github-request-ingress"]],
    ["relay", false, true, ["discord-relay", "github-relay"]],
    ["neither", false, false, ["discord-relay"]],
  ] as const)("activates GitHub %s independently", async (_, requestIngress, relay, expected) => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      discordRelayStart: async () => {
        calls.push("discord-relay");
        return emptyRelayHandle("discord");
      },
      ...(requestIngress
        ? {
            githubRequestIngressStart: async () => {
              calls.push("github-request-ingress");
              return { stop: async () => undefined };
            },
          }
        : {}),
      ...(relay
        ? {
            githubRelayStart: async () => {
              calls.push("github-relay");
              return emptyRelayHandle("github");
            },
          }
        : {}),
    });
    const handles = maps();

    await startSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
    });

    expect(calls).toEqual([...expected]);
  });

  it("retains only completed resources after partial output startup", async () => {
    const calls: string[] = [];
    const relayFailure = new Error("github relay failed");
    const registry = createRegistry({
      calls,
      discordRelayStart: async () => {
        calls.push("discord-relay-started");
        return emptyRelayHandle("discord", async () => {
          calls.push("discord-relay-stopped");
        });
      },
      githubRequestIngressStart: async () => {
        calls.push("github-ingress-started");
        return {
          stop: async () => {
            calls.push("github-ingress-stopped");
          },
        };
      },
      githubRelayStart: async () => {
        calls.push("github-relay-failed");
        throw relayFailure;
      },
    });
    const handles = maps();

    await expect(
      startSurfaceOutputs({
        registry,
        requestIngress: handles.requestIngress,
        relays: handles.relays,
      }),
    ).rejects.toBe(relayFailure);
    expect([...handles.relays.keys()]).toEqual(["discord"]);
    expect([...handles.requestIngress.keys()]).toEqual(["github"]);

    await stopSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
      runCleanup: async (label, cleanup) => {
        calls.push(label);
        await cleanup?.();
      },
    });
    expect(calls).toEqual([
      "discord-relay-started",
      "github-ingress-started",
      "github-relay-failed",
      "githubWebhook.stop",
      "github-ingress-stopped",
      "bridgeBusToAdapter.stop",
      "discord-relay-stopped",
    ]);
  });

  it("disconnects every adapter whose connection attempt may have acquired resources", async () => {
    const calls: string[] = [];
    const failure = new Error("github connect failed");
    const registry = createRegistry({
      calls,
      githubAdapter: new TestAdapter("github", calls, failure),
    });
    const handles = maps();

    await expect(
      connectAndValidateSurfaceAdapters({ registry, connected: handles.connected }),
    ).rejects.toBe(failure);
    await disconnectSurfaceAdapters({
      registry,
      connected: handles.connected,
      runCleanup: async (label, cleanup) => {
        calls.push(label);
        await cleanup?.();
      },
    });

    expect(calls).toEqual([
      "discord-connect",
      "github-connect",
      "githubAdapter.disconnect",
      "github-disconnected",
      "adapter.disconnect",
      "discord-disconnected",
    ]);
  });

  it("stops ingress and request producers before registry-ordered drain and snapshot", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const discordSnapshot = relaySnapshot("discord", "discord-request");
    const githubSnapshot = relaySnapshot("github", "github-request");
    const relay = (
      platform: "discord" | "github",
      snapshot: BusToAdapterRelaySnapshot,
    ): SurfaceRelayHandle<"discord" | "github"> => ({
      platform,
      beginDrain: async ({ deadlineMs }) => {
        calls.push(`${platform}-drain:${deadlineMs}`);
      },
      snapshotRelays: () => {
        calls.push(`${platform}-snapshot`);
        return [snapshot];
      },
      restoreRelays: async () => undefined,
      stop: async () => undefined,
    });
    handles.relays.set("discord", relay("discord", discordSnapshot));
    handles.relays.set("github", relay("github", githubSnapshot));

    const snapshot = await stopIngressAndDrainSurfaceRecovery({
      registry,
      stopAdapterIngress: async () => {
        calls.push("adapter-ingress-stop");
      },
      stopRouterIngress: async () => {
        calls.push("router-ingress-stop");
      },
      stopWorkflowRequestProducers: async () => {
        calls.push("request-producers-stop");
      },
      stopRequestIngress: async () => {
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
        restoreRecoverables: () => undefined,
      },
      relays: handles.relays,
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
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("dispatches only platform-matching relay restores before agent restore", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const discordSnapshot = relaySnapshot("discord", "discord-request");
    const githubSnapshot = relaySnapshot("github", "github-request");
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      restoreRelays: async (snapshots) => {
        calls.push(`discord:${snapshots.map((snapshot) => snapshot.requestId).join(",")}`);
      },
    });
    handles.relays.set("github", {
      ...emptyRelayHandle("github"),
      restoreRelays: async (snapshots) => {
        calls.push(`github:${snapshots.map((snapshot) => snapshot.requestId).join(",")}`);
      },
    });

    await restoreSurfaceRecovery({
      registry,
      snapshot: { agent: [agentEntry], relays: [githubSnapshot, discordSnapshot] },
      relays: handles.relays,
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

  it("stops surface resources and disconnects adapters in reverse ownership order", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    for (const descriptor of registry.entries()) {
      handles.connected.set(descriptor.platform, descriptor.adapter);
    }
    handles.relays.set(
      "discord",
      emptyRelayHandle("discord", async () => {
        calls.push("discord-relay-stopped");
      }),
    );
    handles.relays.set(
      "github",
      emptyRelayHandle("github", async () => {
        calls.push("github-relay-stopped");
      }),
    );
    handles.requestIngress.set("github", {
      stop: async () => {
        calls.push("github-ingress-stopped");
      },
    });
    handles.adapterIngress.set("discord", {
      platform: "discord",
      stop: async () => {
        calls.push("discord-ingress-stopped");
      },
    });
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      await cleanup?.();
    };

    await stopSurfaceOutputs({
      registry,
      requestIngress: handles.requestIngress,
      relays: handles.relays,
      runCleanup,
    });
    await stopSurfaceAdapterIngress({
      registry,
      handles: handles.adapterIngress,
      runCleanup,
      graceful: false,
    });
    await disconnectSurfaceAdapters({
      registry,
      connected: handles.connected,
      runCleanup,
    });

    expect(calls).toEqual([
      "bridgeGithubBusToAdapter.stop",
      "github-relay-stopped",
      "githubWebhook.stop",
      "github-ingress-stopped",
      "bridgeBusToAdapter.stop",
      "discord-relay-stopped",
      "bridgeAdapterToBus.stop",
      "discord-ingress-stopped",
      "githubAdapter.disconnect",
      "github-disconnected",
      "adapter.disconnect",
      "discord-disconnected",
    ]);
  });

  it("uses the graceful ingress cleanup labels and removes completed handles", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.adapterIngress.set("discord", {
      platform: "discord",
      stop: async () => {
        calls.push("adapter-ingress-stopped");
      },
    });
    handles.requestIngress.set("github", {
      stop: async () => {
        calls.push("request-ingress-stopped");
      },
    });
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      await cleanup?.();
    };

    await stopSurfaceAdapterIngress({
      registry,
      handles: handles.adapterIngress,
      runCleanup,
      graceful: true,
    });
    await stopSurfaceRequestIngress({
      registry,
      handles: handles.requestIngress,
      runCleanup,
      graceful: true,
    });

    expect(calls).toEqual([
      "graceful.ingress.bridgeAdapterToBus.stop",
      "adapter-ingress-stopped",
      "graceful.ingress.githubWebhook.stop",
      "request-ingress-stopped",
    ]);
    expect(handles.adapterIngress.size).toBe(0);
    expect(handles.requestIngress.size).toBe(0);
  });
});
