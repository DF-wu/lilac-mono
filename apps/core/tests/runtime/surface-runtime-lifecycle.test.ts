import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";

import {
  connectAndValidateSurfaceAdapters,
  createSurfaceWorkflowProgressPortMap,
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
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import type { AgentRunnerRecoveryEntry } from "../../src/surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../../src/surface/bridge/subscribe-from-bus";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../../src/surface/discord/discord-runtime-descriptor";
import {
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
} from "../../src/surface/github/github-runtime-descriptor";
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
  SurfacePlatform,
  SurfaceSelf,
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

  async listSessions() {
    return Result.ok([]);
  }
  async listSessionParticipants() {
    return Result.ok({ source: "guild_members" as const, participants: [] });
  }

  async startOutput(_sessionRef: SessionRef, _opts?: StartOutputOpts) {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () =>
        Result.ok({
          created: [{ platform: "discord", channelId: "channel", messageId: "message" }],
          last: { platform: "discord", channelId: "channel", messageId: "message" },
        }),
      abort: async () => Result.ok(undefined),
    } satisfies SurfaceOutputStream);
  }
  async startTyping() {
    return Result.ok({ stop: async () => Result.ok(undefined) });
  }

  async sendMsg(sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts) {
    return Result.ok({
      platform: "discord" as const,
      channelId: sessionRef.channelId,
      messageId: "message",
    });
  }

  async readMsg(_msgRef: MsgRef) {
    return Result.ok(null);
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts) {
    return Result.ok(undefined);
  }

  async deleteMsg(_msgRef: MsgRef) {
    return Result.ok(undefined);
  }

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }
  async planReplyChain(msgRef: MsgRef) {
    return Result.ok([msgRef]);
  }
  async planMergeBlockEndingAt(msgRef: MsgRef) {
    return Result.ok([msgRef]);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async listReactions(_msgRef: MsgRef) {
    return Result.ok([]);
  }
  async listReactionDetails(_msgRef: MsgRef) {
    return Result.ok([]);
  }

  async getUnRead(_sessionRef: SessionRef) {
    return Result.ok([]);
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef) {
    return Result.ok(undefined);
  }
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
        ...createDiscordRelayPolicy(discordAdapter),
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
              ...createGithubRelayPolicy(),
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
  it("derives workflow progress ports from unique registry entries", () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      githubRequestIngressStart: async () => ({ stop: async () => undefined }),
    });
    const ports = createSurfaceWorkflowProgressPortMap(registry);
    const [discord, github] = registry.entries();
    if (!discord?.workflowProgress || !github?.workflowProgress) {
      throw new Error("Missing expected workflow progress ports");
    }

    expect(ports).toEqual(
      new Map([
        ["discord", discord.workflowProgress],
        ["github", github.workflowProgress],
      ]),
    );
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
      "surface.github.request-ingress.stop",
      "github-ingress-stopped",
      "surface.discord.relay.stop",
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
      "surface.github.adapter.disconnect",
      "github-disconnected",
      "surface.discord.adapter.disconnect",
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
      "graceful.surface.discord.relay.beginDrain",
      "discord-drain:3000",
      "graceful.surface.github.relay.beginDrain",
      "github-drain:3000",
      "graceful.agentRunner.snapshotRecoverables",
      "agent-snapshot",
      "graceful.surface.discord.relay.snapshotRelays",
      "discord-snapshot",
      "graceful.surface.github.relay.snapshotRelays",
      "github-snapshot",
    ]);
    expect(snapshot).toEqual({
      agent: [agentEntry],
      relays: [discordSnapshot, githubSnapshot],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("reports matched relay dispatch and unmatched relay snapshots", async () => {
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

    const dispatched = await restoreSurfaceRecovery({
      registry,
      snapshot: { agent: [agentEntry], relays: [githubSnapshot, discordSnapshot] },
      relays: handles.relays,
      agentRunner: {
        restoreRecoverables: (entries) => {
          calls.push(`agent:${entries.map((entry) => entry.requestId).join(",")}`);
        },
      },
    });

    expect(calls).toEqual(["discord:discord-request", "agent:discord:session:request"]);
    expect(dispatched).toEqual({
      agentEntriesDispatched: 1,
      agentEntriesUndispatched: 0,
      relayEntriesMatched: 1,
      relayEntriesUnmatched: 1,
    });
  });

  it("matches Discord and GitHub relays while exposing entries undispatched without an agent runner", async () => {
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

    const dispatched = await restoreSurfaceRecovery({
      registry,
      snapshot: { agent: [agentEntry], relays: [githubSnapshot, discordSnapshot] },
      relays: handles.relays,
      agentRunner: null,
    });

    expect(calls).toEqual(["discord:discord-request", "github:github-request"]);
    expect(dispatched).toEqual({
      agentEntriesDispatched: 0,
      agentEntriesUndispatched: 1,
      relayEntriesMatched: 2,
      relayEntriesUnmatched: 0,
    });
  });

  it("contains synchronous snapshot failures and continues later collection", async () => {
    const calls: string[] = [];
    const failures: Array<{ readonly label: string; readonly cause: unknown }> = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const panic = new Panic({ message: "discord snapshot invariant failed" });
    const githubSnapshot = relaySnapshot("github", "github-request");
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      snapshotRelays: () => {
        throw panic;
      },
    });
    handles.relays.set("github", {
      ...emptyRelayHandle("github"),
      snapshotRelays: () => [githubSnapshot],
    });
    const runCleanup = async (label: string, cleanup: (() => Promise<void>) | undefined) => {
      calls.push(label);
      const [settled] = await Promise.allSettled([Promise.resolve().then(() => cleanup?.())]);
      if (settled?.status === "rejected") failures.push({ label, cause: settled.reason });
    };

    const snapshot = await stopIngressAndDrainSurfaceRecovery({
      registry,
      stopAdapterIngress: async () => undefined,
      stopRouterIngress: async () => undefined,
      stopWorkflowRequestProducers: async () => undefined,
      stopRequestIngress: async () => undefined,
      stopRemainingRequestProducers: async () => undefined,
      deadlineMs: 3_000,
      runCleanup,
      agentRunner: {
        beginDrain: async () => undefined,
        snapshotRecoverables: () => {
          throw new Error("agent snapshot failed");
        },
        restoreRecoverables: () => undefined,
      },
      relays: handles.relays,
    });

    expect(snapshot).toEqual({ agent: [], relays: [githubSnapshot] });
    expect(failures.map(({ label }) => label)).toEqual([
      "graceful.agentRunner.snapshotRecoverables",
      "graceful.surface.discord.relay.snapshotRelays",
    ]);
    expect(failures[1]?.cause).toBe(panic);
  });

  it("contains rejected snapshot collection and contributes empty entries", async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const rejection = new Error("snapshot rejected");
    const relay = emptyRelayHandle("discord");
    Reflect.set(relay, "snapshotRelays", () => Promise.reject(rejection));
    handles.relays.set("discord", relay);
    const agentRunner = {
      beginDrain: async () => undefined,
      snapshotRecoverables: () => [agentEntry],
      restoreRecoverables: () => undefined,
    };
    Reflect.set(agentRunner, "snapshotRecoverables", () => Promise.reject(rejection));

    const snapshot = await stopIngressAndDrainSurfaceRecovery({
      registry,
      stopAdapterIngress: async () => undefined,
      stopRouterIngress: async () => undefined,
      stopWorkflowRequestProducers: async () => undefined,
      stopRequestIngress: async () => undefined,
      stopRemainingRequestProducers: async () => undefined,
      deadlineMs: 3_000,
      runCleanup: async (label, cleanup) => {
        const [settled] = await Promise.allSettled([Promise.resolve().then(() => cleanup?.())]);
        if (settled?.status === "rejected") failures.push(label);
      },
      agentRunner,
      relays: handles.relays,
    });

    expect(snapshot).toEqual({ agent: [], relays: [] });
    expect(failures).toEqual([
      "graceful.agentRunner.snapshotRecoverables",
      "graceful.surface.discord.relay.snapshotRelays",
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
      "surface.github.relay.stop",
      "github-relay-stopped",
      "surface.github.request-ingress.stop",
      "github-ingress-stopped",
      "surface.discord.relay.stop",
      "discord-relay-stopped",
      "surface.discord.adapter-ingress.stop",
      "discord-ingress-stopped",
      "surface.github.adapter.disconnect",
      "github-disconnected",
      "surface.discord.adapter.disconnect",
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
      "graceful.surface.discord.adapter-ingress.stop",
      "adapter-ingress-stopped",
      "graceful.surface.github.request-ingress.stop",
      "request-ingress-stopped",
    ]);
    expect(handles.adapterIngress.size).toBe(0);
    expect(handles.requestIngress.size).toBe(0);
  });
});
