import { describe, expect, expectTypeOf, it } from "bun:test";
import { Panic, Result } from "better-result";

import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import { createDiscordSurfaceRuntimeDescriptor } from "../../src/surface/discord/discord-runtime-descriptor";
import { createGithubSurfaceRuntimeDescriptor } from "../../src/surface/github/github-runtime-descriptor";
import {
  type RegisteredSurfacePlatform,
  type SurfaceAdapterIngress,
  type SurfaceRelayDescriptor,
  type SurfaceRelayHandle,
  type SurfaceRelayLifecyclePort,
  type SurfaceRequestIngress,
  type SurfaceRuntimeDescriptor,
  SurfaceRuntimeRegistry,
  type SurfaceWorkflowProgressPort,
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

class TestAdapter implements SurfaceAdapter {
  constructor(
    private readonly selfPlatform: SurfacePlatform,
    private readonly selfFailure?: Error,
  ) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    if (this.selfFailure) throw this.selfFailure;
    return { platform: this.selfPlatform, userId: "bot", userName: "bot" };
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

function discordAdapterIngress(): SurfaceAdapterIngress<"discord"> {
  return {
    start: async () => ({ platform: "discord", stop: async () => undefined }),
  };
}

function requestIngress(): SurfaceRequestIngress {
  return { start: async () => ({ stop: async () => undefined }) };
}

function discordRelay(): SurfaceRelayDescriptor<"discord"> {
  return {
    refs: {
      createSessionRef: (sessionId) => ({ platform: "discord", channelId: sessionId }),
      resolveInitialReplyTarget: () => ({ kind: "none" }),
      decodeReanchorTarget: (input) =>
        Result.ok({
          platform: "discord",
          channelId: input.expectedSessionId,
          messageId: input.ref.messageId,
        }),
    },
    lifecycle: {
      platform: "discord",
      start: async () => ({
        platform: "discord",
        beginDrain: async () => undefined,
        snapshotRelays: () => [],
        restoreRelays: async () => undefined,
        stop: async () => undefined,
      }),
    },
  };
}

function githubRelay(): SurfaceRelayDescriptor<"github"> {
  return {
    refs: {
      createSessionRef: (sessionId) => ({ platform: "github", channelId: sessionId }),
      resolveInitialReplyTarget: () => ({ kind: "none" }),
      decodeReanchorTarget: (input) =>
        Result.ok({
          platform: "github",
          channelId: input.expectedSessionId,
          messageId: input.ref.messageId,
        }),
    },
    lifecycle: {
      platform: "github",
      start: async () => ({
        platform: "github",
        beginDrain: async () => undefined,
        snapshotRelays: () => [],
        restoreRelays: async () => undefined,
        stop: async () => undefined,
      }),
    },
  };
}

function discordWorkflowProgress(): SurfaceWorkflowProgressPort<"discord"> {
  return {
    checkMessage: async () => Result.ok("found"),
    send: async (session) =>
      Result.ok({ platform: "discord", channelId: session.channelId, messageId: "message" }),
    edit: async () => Result.ok(undefined),
  };
}

function githubWorkflowProgress(): SurfaceWorkflowProgressPort<"github"> {
  return {
    checkMessage: async () => Result.ok("found"),
    send: async (session) =>
      Result.ok({ platform: "github", channelId: session.channelId, messageId: "message" }),
    edit: async () => Result.ok(undefined),
  };
}

function discordDescriptor(
  adapter: SurfaceAdapter = new TestAdapter("discord"),
): SurfaceRuntimeDescriptor<"discord"> {
  return createDiscordSurfaceRuntimeDescriptor({
    adapter,
    adapterIngress: discordAdapterIngress(),
    relay: discordRelay(),
    workflowProgress: discordWorkflowProgress(),
  });
}

function githubDescriptor(
  adapter: SurfaceAdapter = new TestAdapter("github"),
): SurfaceRuntimeDescriptor<"github"> {
  return createGithubSurfaceRuntimeDescriptor({
    adapter,
    requestIngress: requestIngress(),
    relay: githubRelay(),
    workflowProgress: githubWorkflowProgress(),
  });
}

describe("surface runtime descriptor factories", () => {
  type IsAssignable<From, To> = From extends To ? true : false;

  it("keys the closed registry platform set from the existing session refs", () => {
    expectTypeOf<RegisteredSurfacePlatform>().toEqualTypeOf<SessionRef["platform"]>();
    expectTypeOf<RegisteredSurfacePlatform>().toEqualTypeOf<"discord" | "github">();
  });

  it("does not allow GitHub relay lifecycle values in Discord descriptors", () => {
    type DiscordFactoryRelay = Parameters<typeof createDiscordSurfaceRuntimeDescriptor>[0]["relay"];

    expectTypeOf<
      IsAssignable<SurfaceRelayLifecyclePort<"github">, SurfaceRelayLifecyclePort<"discord">>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<SurfaceRelayHandle<"github">, SurfaceRelayHandle<"discord">>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<SurfaceRelayDescriptor<"github">, DiscordFactoryRelay>
    >().toEqualTypeOf<false>();
  });

  it("assembles every existing Discord subsystem without adding generic sidecars", () => {
    const adapter = new TestAdapter("discord");
    const adapterIngress = discordAdapterIngress();
    const relay = discordRelay();
    const workflowProgress = discordWorkflowProgress();
    const descriptor = createDiscordSurfaceRuntimeDescriptor({
      adapter,
      adapterIngress,
      relay,
      workflowProgress,
    });

    expect(descriptor).toEqual({
      platform: "discord",
      adapter,
      adapterIngress,
      relay,
      workflowProgress,
    });
    expect("requestIngress" in descriptor).toBe(false);
    expect("health" in descriptor).toBe(false);
    expect("surfaceStore" in descriptor).toBe(false);
  });

  it("keeps GitHub request ingress, relay, and workflow progress independently optional", () => {
    for (const requestIngressEnabled of [false, true]) {
      for (const relayEnabled of [false, true]) {
        for (const workflowProgressEnabled of [false, true]) {
          const descriptor = createGithubSurfaceRuntimeDescriptor({
            adapter: new TestAdapter("github"),
            ...(requestIngressEnabled ? { requestIngress: requestIngress() } : {}),
            ...(relayEnabled ? { relay: githubRelay() } : {}),
            ...(workflowProgressEnabled ? { workflowProgress: githubWorkflowProgress() } : {}),
          });

          expect("requestIngress" in descriptor).toBe(requestIngressEnabled);
          expect("relay" in descriptor).toBe(relayEnabled);
          expect("workflowProgress" in descriptor).toBe(workflowProgressEnabled);
          expect("adapterIngress" in descriptor).toBe(false);
        }
      }
    }
  });
});

describe("surface runtime registry", () => {
  it("preserves registration order and platform-correlated lookup", () => {
    const discord = discordDescriptor();
    const github = githubDescriptor();
    const created = SurfaceRuntimeRegistry.create([discord, github]);

    expect(created.status).toBe("ok");
    if (created.status === "error") return;
    expect(created.value.entries()).toEqual([discord, github]);
    expect(created.value.get("discord")).toBe(discord);
    expect(created.value.get("github")).toBe(github);
  });

  it.each(["discord", "github"] as const)(
    "rejects a duplicate %s registration as an owned failure",
    (platform) => {
      const descriptor = platform === "discord" ? discordDescriptor() : githubDescriptor();
      const created = SurfaceRuntimeRegistry.create([descriptor, descriptor]);

      expect(created.status).toBe("error");
      if (created.status === "ok") return;
      expect(created.error._tag).toBe("SurfaceRuntimeRegistrationDuplicate");
      expect(created.error.platform).toBe(platform);
      expect(created.error.message).toContain(platform);
    },
  );

  it("accepts adapter-reported platforms that match every descriptor", async () => {
    const created = SurfaceRuntimeRegistry.create([discordDescriptor(), githubDescriptor()]);
    if (created.status === "error") throw created.error;

    await expect(created.value.validateAdapterPlatforms()).resolves.toBeUndefined();
  });

  it.each([
    ["discord", "github"],
    ["github", "discord"],
    ["discord", "slack"],
    ["github", "unknown"],
  ] as const)(
    "raises Panic when the %s descriptor adapter reports %s",
    async (descriptorPlatform, adapterPlatform) => {
      const descriptor =
        descriptorPlatform === "discord"
          ? discordDescriptor(new TestAdapter(adapterPlatform))
          : githubDescriptor(new TestAdapter(adapterPlatform));
      const created = SurfaceRuntimeRegistry.create([descriptor]);
      if (created.status === "error") throw created.error;

      const [settled] = await Promise.allSettled([created.value.validateAdapterPlatforms()]);
      expect(settled?.status).toBe("rejected");
      if (settled?.status !== "rejected") return;
      expect(Panic.is(settled.reason)).toBe(true);
      expect(String(settled.reason)).toContain(`descriptor=${descriptorPlatform}`);
      expect(String(settled.reason)).toContain(`adapter=${adapterPlatform}`);
    },
  );

  it("does not convert an adapter getSelf rejection into a registry mismatch", async () => {
    const failure = new Error("getSelf failed");
    const created = SurfaceRuntimeRegistry.create([
      discordDescriptor(new TestAdapter("discord", failure)),
    ]);
    if (created.status === "error") throw created.error;

    await expect(created.value.validateAdapterPlatforms()).rejects.toBe(failure);
  });
});
