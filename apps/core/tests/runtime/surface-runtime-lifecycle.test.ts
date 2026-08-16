import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";

import {
  activateSurfaceRecovery,
  applySurfaceRecovery,
  connectAndValidateSurfaceAdapters,
  createPausedSurfaceRecoveryOwnership,
  createSurfaceWorkflowProgressPortMap,
  disconnectSurfaceAdapters,
  prepareSurfaceRecovery,
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
  SurfaceSendPreparationInput,
} from "../../src/surface/adapter";
import {
  AgentRecoveryUnavailable,
  type AgentRunnerRecoveryEntry,
} from "../../src/surface/bridge/bus-agent-runner";
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
  SurfaceRelayRestoreApplyFailed,
  SurfaceRelayRestoreRollbackFailed,
  SurfaceRuntimeRegistry,
  type SurfaceRelayHandle,
  type SurfaceRelaySnapshotFor,
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
  queueEntryId: "agent-entry",
  kind: "active",
  requestId: "discord:session:request",
  sessionId: "session",
  requestClient: "discord",
  queue: "prompt",
  messages: [],
};

function recoverySnapshot(
  agent: readonly AgentRunnerRecoveryEntry[],
  relays: readonly BusToAdapterRelaySnapshot[],
) {
  return {
    createdAt: 1,
    deadlineMs: 1_000,
    queueAttemptProof: "complete" as const,
    agent,
    queueAttempts: [],
    relays,
  };
}

function testAgentRecovery(
  onActivate: (entries: readonly AgentRunnerRecoveryEntry[]) => void = () => undefined,
) {
  return {
    prepareRecovery: (input: { readonly entries: readonly AgentRunnerRecoveryEntry[] }) =>
      Result.ok({
        apply: () => Result.ok(undefined),
        rollback: () => undefined,
        activate: () => onActivate(input.entries),
      }),
  };
}

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

  async prepareSendMsg(
    _sessionRef: SessionRef,
    _input: SurfaceSendPreparationInput,
    _opts?: SendOpts,
  ) {
    return Result.ok(undefined);
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

function relaySnapshot<P extends "discord" | "github">(
  platform: P,
  requestId: string,
): SurfaceRelaySnapshotFor<P> {
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
  restore: (snapshots: readonly BusToAdapterRelaySnapshot[]) => Promise<void> = async () =>
    undefined,
): SurfaceRelayHandle<P> {
  return {
    platform,
    beginDrain: async () => undefined,
    snapshotRelays: () => [],
    prepareRestoreRelays: (snapshots) =>
      Result.ok({
        platform,
        apply: async () => {
          await restore(snapshots);
          return Result.ok(undefined);
        },
        rollback: async () => Result.ok(undefined),
        activate: () => undefined,
      }),
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
  const githubRelayStart = input.githubRelayStart;
  const created = SurfaceRuntimeRegistry.create([
    createDiscordSurfaceRuntimeDescriptor({
      adapter: discordAdapter,
      adapterIngress: {
        start:
          input.adapterIngressStart ??
          (async () => ({ platform: "discord", stop: async () => undefined })),
      },
      createRelay: (guardedAdapter) => ({
        ...createDiscordRelayPolicy(guardedAdapter),
        lifecycle: {
          platform: "discord",
          start: input.discordRelayStart ?? (async () => emptyRelayHandle("discord")),
        },
      }),
    }),
    createGithubSurfaceRuntimeDescriptor({
      adapter: githubAdapter,
      ...(input.githubRequestIngressStart
        ? { requestIngress: { start: input.githubRequestIngressStart } }
        : {}),
      ...(githubRelayStart
        ? {
            createRelay: () => ({
              ...createGithubRelayPolicy(),
              lifecycle: { platform: "github" as const, start: githubRelayStart },
            }),
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

    const discordRegistration = ports.get("discord");
    const githubRegistration = ports.get("github");
    expect(discordRegistration?.platform).toBe("discord");
    expect(discordRegistration?.protocol).toBe(discord.protocol);
    expect(discordRegistration?.port).toBe(discord.workflowProgress);
    expect(githubRegistration?.platform).toBe("github");
    expect(githubRegistration?.protocol).toBe(github.protocol);
    expect(githubRegistration?.port).toBe(github.workflowProgress);
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
    const registry = createRegistry({
      calls,
      githubRelayStart: async () => emptyRelayHandle("github"),
    });
    const handles = maps();
    const discordSnapshot = relaySnapshot("discord", "discord-request");
    const githubSnapshot = relaySnapshot("github", "github-request");
    const relay = <P extends "discord" | "github">(
      platform: P,
      snapshot: SurfaceRelaySnapshotFor<P>,
    ): SurfaceRelayHandle<P> => ({
      platform,
      beginDrain: async ({ deadlineMs }) => {
        calls.push(`${platform}-drain:${deadlineMs}`);
      },
      snapshotRelays: () => {
        calls.push(`${platform}-snapshot`);
        return [snapshot];
      },
      prepareRestoreRelays: (snapshots) =>
        Result.ok({
          platform,
          apply: async () => {
            await Promise.resolve(snapshots);
            return Result.ok(undefined);
          },
          rollback: async () => Result.ok(undefined),
          activate: () => undefined,
        }),
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
        snapshotQueueAttempts: () => [],
        prepareRecovery: testAgentRecovery().prepareRecovery,
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
      queueAttempts: [],
      relays: [discordSnapshot, githubSnapshot],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
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
        snapshotQueueAttempts: () => [],
        prepareRecovery: testAgentRecovery().prepareRecovery,
      },
      relays: handles.relays,
    });

    expect(snapshot).toEqual({ agent: [], queueAttempts: [], relays: [githubSnapshot] });
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
      snapshotQueueAttempts: () => [],
      prepareRecovery: testAgentRecovery().prepareRecovery,
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

    expect(snapshot).toEqual({ agent: [], queueAttempts: [], relays: [] });
    expect(failures).toEqual([
      "graceful.agentRunner.snapshotRecoverables",
      "graceful.surface.discord.relay.snapshotRelays",
    ]);
  });

  it("activates every admitted relay and the agent synchronously in one total transition", () => {
    const calls: string[] = [];
    const plan = {
      snapshot: recoverySnapshot([], []),
      attempts: ["discord", "github"].map((platform) => ({
        platform: platform as "discord" | "github",
        apply: async () => Result.ok(undefined),
        rollback: async () => Result.ok(undefined),
        activate: () => {
          calls.push(`${platform}-active`);
        },
      })),
      agentAttempt: {
        apply: () => Result.ok(undefined),
        rollback: () => undefined,
        activate: () => {
          calls.push("agent-active");
        },
      },
    };

    expect(activateSurfaceRecovery(plan)).toBeUndefined();
    expect(calls).toEqual(["discord-active", "github-active", "agent-active"]);
    activateSurfaceRecovery(plan);
    expect(calls).toEqual(["discord-active", "github-active", "agent-active"]);
  });

  it("rolls back paused recovery when startup fails before disposition", async () => {
    const calls: string[] = [];
    const ownership = createPausedSurfaceRecoveryOwnership({
      snapshot: recoverySnapshot([], []),
      attempts: ["discord", "github"].map((platform) => ({
        platform: platform as "discord" | "github",
        apply: async () => Result.ok(undefined),
        rollback: async () => {
          calls.push(`${platform}-rollback`);
          return Result.ok(undefined);
        },
        activate: () => {
          calls.push(`${platform}-active`);
        },
      })),
      agentAttempt: {
        apply: () => Result.ok(undefined),
        rollback: () => {
          calls.push("agent-rollback");
        },
        activate: () => {
          calls.push("agent-active");
        },
      },
    });

    await ownership.rollback();
    await ownership.rollback();
    ownership.activate();
    expect(calls).toEqual(["github-rollback", "discord-rollback", "agent-rollback"]);
  });

  it("performs successful final ownership activation synchronously and exactly once", () => {
    const calls: string[] = [];
    const ownership = createPausedSurfaceRecoveryOwnership({
      snapshot: recoverySnapshot([], []),
      attempts: [
        {
          platform: "discord",
          apply: async () => Result.ok(undefined),
          rollback: async () => Result.ok(undefined),
          activate: () => {
            calls.push("relay-active");
          },
        },
      ],
      agentAttempt: {
        apply: () => Result.ok(undefined),
        rollback: () => undefined,
        activate: () => {
          calls.push("agent-active");
        },
      },
    });

    expect(ownership.activate()).toBeUndefined();
    ownership.activate();
    expect(calls).toEqual(["relay-active", "agent-active"]);
  });

  it("preflights every descriptor and relay handle before applying any restore", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", emptyRelayHandle("discord"));
    const unavailable = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot(
        [],
        [relaySnapshot("discord", "discord-request"), relaySnapshot("github", "github-request")],
      ),
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });

    expect(unavailable.status).toBe("error");
    if (unavailable.status === "error") {
      expect(unavailable.error._tag).toBe("SurfaceRecoveryUnavailable");
    }
    expect(calls).toEqual([]);
  });

  it("rejects ambiguous legacy agent queues before relay preparation", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", emptyRelayHandle("discord"));
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: {
        ...recoverySnapshot(
          [{ ...agentEntry, kind: "queued" }],
          [relaySnapshot("discord", "discord-request")],
        ),
        queueAttemptProof: "legacy-ambiguous",
      },
      relays: handles.relays,
      agentRunner: {
        prepareRecovery: () => {
          calls.push("agent-prepared");
          return testAgentRecovery().prepareRecovery({ entries: [] });
        },
      },
    });
    expect(prepared.status).toBe("error");
    if (prepared.status === "error") expect(prepared.error._tag).toBe("SurfaceRecoveryUnavailable");
    expect(calls).toEqual([]);
  });

  it("allows principal-less active-only legacy recovery while retaining legacy queues", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", emptyRelayHandle("discord"));
    const active = prepareSurfaceRecovery({
      registry,
      snapshot: {
        ...recoverySnapshot(
          [
            {
              ...agentEntry,
              identity: { state: "restricted", reason: "legacy-no-durable-proof" },
            },
          ],
          [],
        ),
        queueAttemptProof: "complete",
      },
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });
    expect(active.status).toBe("ok");

    const queued = prepareSurfaceRecovery({
      registry,
      snapshot: {
        ...recoverySnapshot(
          [
            {
              ...agentEntry,
              kind: "queued",
              identity: { state: "restricted", reason: "legacy-no-durable-proof" },
            },
          ],
          [],
        ),
        queueAttemptProof: "legacy-ambiguous",
      },
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });
    expect(queued.status).toBe("error");
  });

  it("rejects an agent-only unavailable surface before agent or relay mutation", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot([agentEntry], []),
      relays: handles.relays,
      agentRunner: {
        prepareRecovery: () => {
          calls.push("agent-prepared");
          return testAgentRecovery().prepareRecovery({ entries: [] });
        },
      },
    });
    expect(prepared.status).toBe("error");
    if (prepared.status === "error") {
      expect(prepared.error).toMatchObject({
        _tag: "SurfaceRecoveryUnavailable",
        reason: "relay-handle-unavailable",
      });
    }
    expect(calls).toEqual([]);
  });

  it("requires a catalog surface descriptor even when it is absent from the registry", () => {
    const calls: string[] = [];
    const created = SurfaceRuntimeRegistry.create([
      createDiscordSurfaceRuntimeDescriptor({
        adapter: new TestAdapter("discord", calls),
        adapterIngress: {
          start: async () => ({ platform: "discord", stop: async () => undefined }),
        },
        createRelay: (guardedAdapter) => ({
          ...createDiscordRelayPolicy(guardedAdapter),
          lifecycle: {
            platform: "discord",
            start: async () => emptyRelayHandle("discord"),
          },
        }),
      }),
    ]);
    if (created.status === "error") throw created.error;
    const handles = maps();
    const prepared = prepareSurfaceRecovery({
      registry: created.value,
      snapshot: recoverySnapshot(
        [
          {
            ...agentEntry,
            requestId: "github:octo/repo:1:request",
            sessionId: "octo/repo#1",
            requestClient: "github",
          },
        ],
        [],
      ),
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });

    expect(prepared.status).toBe("error");
    if (prepared.status === "error") {
      expect(prepared.error).toMatchObject({
        _tag: "SurfaceRecoveryUnavailable",
        platform: "github",
        reason: "descriptor-unavailable",
      });
    }
    expect(calls).toEqual([]);
  });

  it("rejects an agent-only cache conflict before relay preparation or apply", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      prepareRestoreRelays: () => {
        calls.push("relay-prepared");
        return emptyRelayHandle("discord").prepareRestoreRelays([]);
      },
    });
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot([agentEntry], [relaySnapshot("discord", "discord-request")]),
      relays: handles.relays,
      agentRunner: {
        prepareRecovery: () =>
          Result.err(
            new AgentRecoveryUnavailable({
              requestId: agentEntry.requestId,
              reason: "cache-conflict",
              message: "injected cache conflict",
            }),
          ),
      },
    });
    expect(prepared.status).toBe("error");
    if (prepared.status === "error")
      expect(prepared.error).toBeInstanceOf(AgentRecoveryUnavailable);
    expect(calls).toEqual([]);
  });

  it("rolls back every relay attempt when a later apply fails and does not restore agents", async () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      githubRelayStart: async () => emptyRelayHandle("github"),
    });
    const handles = maps();
    const attemptHandle = (
      platform: "discord" | "github",
      failApply: boolean,
    ): SurfaceRelayHandle<"discord" | "github"> => ({
      platform,
      beginDrain: async () => undefined,
      snapshotRelays: () => [],
      prepareRestoreRelays: (snapshots) =>
        Result.ok({
          platform,
          apply: async () => {
            calls.push(`${platform}-apply`);
            return failApply
              ? Result.err(
                  new SurfaceRelayRestoreApplyFailed({
                    platform,
                    requestId: snapshots[0]?.requestId ?? "missing",
                    message: "injected apply failure",
                  }),
                )
              : Result.ok(undefined);
          },
          rollback: async () => {
            calls.push(`${platform}-rollback`);
            return Result.ok(undefined);
          },
          activate: () => undefined,
        }),
      stop: async () => undefined,
    });
    handles.relays.set("discord", attemptHandle("discord", false));
    handles.relays.set("github", attemptHandle("github", true));
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot(
        [agentEntry],
        [relaySnapshot("discord", "discord-request"), relaySnapshot("github", "github-request")],
      ),
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });
    if (prepared.status === "error") throw prepared.error;

    const applied = await applySurfaceRecovery(prepared.value);
    expect(applied.status).toBe("error");
    expect(calls).toEqual(["discord-apply", "github-apply", "github-rollback", "discord-rollback"]);
  });

  it("reports the failed agent platform instead of the first relay platform", async () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      githubRelayStart: async () => emptyRelayHandle("github"),
    });
    const handles = maps();
    handles.relays.set("discord", emptyRelayHandle("discord"));
    handles.relays.set("github", emptyRelayHandle("github"));
    const githubEntry: AgentRunnerRecoveryEntry = {
      ...agentEntry,
      requestId: "github:octo/repo#1:request",
      sessionId: "octo/repo#1",
      requestClient: "github",
    };
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot([githubEntry], [relaySnapshot("discord", "discord-request")]),
      relays: handles.relays,
      agentRunner: {
        prepareRecovery: () =>
          Result.ok({
            apply: () =>
              Result.err(
                new AgentRecoveryUnavailable({
                  requestId: githubEntry.requestId,
                  reason: "cache-conflict",
                  message: "injected agent apply failure",
                }),
              ),
            rollback: () => undefined,
            activate: () => undefined,
          }),
      },
    });
    if (prepared.status === "error") throw prepared.error;

    const applied = await applySurfaceRecovery(prepared.value);
    expect(applied.status).toBe("error");
    if (applied.status === "error") {
      expect(applied.error).toMatchObject({
        platform: "github",
        requestId: githubEntry.requestId,
        message: "injected agent apply failure",
      });
    }
  });

  it("raises the registered Panic when relay rollback leaves atomicity unknown", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      prepareRestoreRelays: (snapshots) =>
        Result.ok({
          platform: "discord",
          apply: async () =>
            Result.err(
              new SurfaceRelayRestoreApplyFailed({
                platform: "discord",
                requestId: snapshots[0]?.requestId ?? "missing",
                message: "injected apply failure",
              }),
            ),
          rollback: async () =>
            Result.err(
              new SurfaceRelayRestoreRollbackFailed({
                platform: "discord",
                message: "injected rollback failure",
              }),
            ),
          activate: () => undefined,
        }),
    });
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot([], [relaySnapshot("discord", "discord-request")]),
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });
    if (prepared.status === "error") throw prepared.error;

    const [settled] = await Promise.allSettled([applySurfaceRecovery(prepared.value)]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });

  it("continues reverse rollback after one relay cleanup fails", async () => {
    const calls: string[] = [];
    const registry = createRegistry({
      calls,
      githubRelayStart: async () => emptyRelayHandle("github"),
    });
    const handles = maps();
    const attemptHandle = (
      platform: "discord" | "github",
      failApply: boolean,
      failRollback: boolean,
    ): SurfaceRelayHandle<"discord" | "github"> => ({
      ...emptyRelayHandle(platform),
      prepareRestoreRelays: (snapshots) =>
        Result.ok({
          platform,
          apply: async () => {
            calls.push(`${platform}-apply`);
            return failApply
              ? Result.err(
                  new SurfaceRelayRestoreApplyFailed({
                    platform,
                    requestId: snapshots[0]?.requestId ?? "missing",
                    message: "injected apply failure",
                  }),
                )
              : Result.ok(undefined);
          },
          rollback: async () => {
            calls.push(`${platform}-rollback`);
            return failRollback
              ? Result.err(
                  new SurfaceRelayRestoreRollbackFailed({
                    platform,
                    message: "injected rollback failure",
                  }),
                )
              : Result.ok(undefined);
          },
          activate: () => undefined,
        }),
    });
    handles.relays.set("discord", attemptHandle("discord", false, false));
    handles.relays.set("github", attemptHandle("github", true, true));
    const prepared = prepareSurfaceRecovery({
      registry,
      snapshot: recoverySnapshot(
        [],
        [relaySnapshot("discord", "discord-request"), relaySnapshot("github", "github-request")],
      ),
      relays: handles.relays,
      agentRunner: testAgentRecovery(),
    });
    if (prepared.status === "error") throw prepared.error;

    const [settled] = await Promise.allSettled([applySurfaceRecovery(prepared.value)]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    expect(calls).toEqual(["discord-apply", "github-apply", "github-rollback", "discord-rollback"]);
  });

  it("rejects a faulty relay snapshot before it can be persisted", async () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    const invalid = {
      ...relaySnapshot("discord", "discord-request"),
      createdOutputRefs: [
        { platform: "discord" as const, channelId: "other", messageId: "invalid" },
      ],
    };
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      snapshotRelays: () => [invalid],
    });
    let persisted = false;

    const collected = stopIngressAndDrainSurfaceRecovery({
      registry,
      stopAdapterIngress: async () => undefined,
      stopRouterIngress: async () => undefined,
      stopWorkflowRequestProducers: async () => undefined,
      stopRequestIngress: async () => undefined,
      stopRemainingRequestProducers: async () => undefined,
      deadlineMs: 3_000,
      runCleanup: async (_label, cleanup) => cleanup?.(),
      agentRunner: {
        beginDrain: async () => undefined,
        snapshotRecoverables: () => [],
        snapshotQueueAttempts: () => [],
        prepareRecovery: testAgentRecovery().prepareRecovery,
      },
      relays: handles.relays,
    }).then(() => {
      persisted = true;
    });

    const [settled] = await Promise.allSettled([collected]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status !== "rejected") return;
    expect(Panic.is(settled.reason)).toBe(true);
    expect(persisted).toBe(false);
  });

  it("rejects faulty recovery refs before relay or agent restoration", () => {
    const calls: string[] = [];
    const registry = createRegistry({ calls });
    const handles = maps();
    handles.relays.set("discord", {
      ...emptyRelayHandle("discord"),
      prepareRestoreRelays: () => {
        calls.push("relay-prepared");
        return emptyRelayHandle("discord").prepareRestoreRelays([]);
      },
    });
    const invalid = {
      ...relaySnapshot("discord", "discord-request"),
      activeOutputRefs: [
        { platform: "github" as const, channelId: "session", messageId: "invalid" },
      ],
    };

    expect(() =>
      prepareSurfaceRecovery({
        registry,
        snapshot: recoverySnapshot([agentEntry], [invalid]),
        relays: handles.relays,
        agentRunner: testAgentRecovery(() => {
          calls.push("agent-restored");
        }),
      }),
    ).toThrow(Panic);

    expect(calls).not.toContain("relay-prepared");
    expect(calls).not.toContain("agent-restored");
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
