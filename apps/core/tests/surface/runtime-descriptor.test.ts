import { describe, expect, expectTypeOf, it } from "bun:test";
import { Panic, Result } from "better-result";

import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../../src/surface/discord/discord-runtime-descriptor";
import {
  createConfiguredGithubSurfaceRuntimeDescriptor,
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
} from "../../src/surface/github/github-runtime-descriptor";
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
      push: async () => "visible",
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
  const adapter = new TestAdapter("discord");
  return {
    ...createDiscordRelayPolicy(adapter),
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
    ...createGithubRelayPolicy(),
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
    expect("refs" in descriptor.relay!).toBe(true);
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

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "composes production GitHub webhook=%s and App credentials=%s independently",
    (webhookConfigured, appCredentialsAvailable) => {
      const logs: Array<{ level: "info" | "warn"; message: string; context: unknown }> = [];
      const adapter = new TestAdapter("github");
      const ingress = requestIngress();
      const relay = githubRelay();
      const workflowProgress = githubWorkflowProgress();
      const descriptor = createConfiguredGithubSurfaceRuntimeDescriptor({
        adapter,
        webhookSecret: webhookConfigured ? "webhook-secret" : undefined,
        appCredentialsAvailable,
        requestIngress: ingress,
        relay,
        workflowProgress,
        logger: {
          info: (message, context) => logs.push({ level: "info", message, context }),
          warn: (message, context) => logs.push({ level: "warn", message, context }),
        },
      });

      const requestIngressAvailable = webhookConfigured && appCredentialsAvailable;
      expect(descriptor.adapter).toBe(adapter);
      expect(descriptor.requestIngress).toBe(requestIngressAvailable ? ingress : undefined);
      expect(descriptor.relay).toBe(appCredentialsAvailable ? relay : undefined);
      expect(descriptor.workflowProgress).toBe(workflowProgress);
      if (descriptor.relay) expect("refs" in descriptor.relay).toBe(true);
      expect(logs).toEqual([
        ...(requestIngressAvailable
          ? []
          : [
              {
                level: "warn" as const,
                message: "GitHub webhook ingress unavailable",
                context: {
                  subsystem: "request-ingress",
                  reason: webhookConfigured ? "app-credentials-missing" : "webhook-secret-missing",
                },
              },
            ]),
        ...(appCredentialsAvailable
          ? []
          : [
              {
                level: "info" as const,
                message: "GitHub output relay unavailable",
                context: {
                  subsystem: "output-relay",
                  reason: "app-credentials-missing",
                },
              },
            ]),
      ]);
    },
  );
});

describe("surface relay policies", () => {
  it.each([
    ["discord", "req:generic", "channel", "none", undefined],
    ["discord", "discord:channel:message", "channel", "target", undefined],
    ["discord", "discord:channel", "channel", "invalid", "malformed"],
    ["discord", "github:octo/repo#1:10", "channel", "invalid", "platform-mismatch"],
    ["discord", "discord:other:message", "channel", "invalid", "session-mismatch"],
    ["github", "req:generic", "octo/repo#1", "none", undefined],
    ["github", "github:octo/repo#1:10", "octo/repo#1", "target", undefined],
    ["github", "github:octo/repo#1", "octo/repo#1", "invalid", "malformed"],
    ["github", "discord:channel:message", "octo/repo#1", "invalid", "platform-mismatch"],
    ["github", "github:octo/other#2:10", "octo/repo#1", "invalid", "session-mismatch"],
  ] as const)(
    "classifies %s initial target %s as %s",
    (platform, requestId, sessionId, expectedKind, expectedReason) => {
      const adapter = new TestAdapter(platform);
      const policy =
        platform === "discord" ? createDiscordRelayPolicy(adapter) : createGithubRelayPolicy();
      const resolved = policy.refs.resolveInitialReplyTarget({ requestId, sessionId });

      expect(resolved.kind).toBe(expectedKind);
      if (resolved.kind === "invalid") {
        if (expectedReason === undefined) throw new Error("invalid case is missing its reason");
        expect(resolved.error.reason).toBe(expectedReason);
      }
      if (resolved.kind === "target") {
        expect(resolved.ref).toEqual({
          platform,
          channelId: sessionId,
          messageId: platform === "discord" ? "message" : "10",
        });
      }
    },
  );

  it.each(["discord", "github"] as const)(
    "rejects cross-platform and cross-session %s reanchor refs",
    (platform) => {
      const adapter = new TestAdapter(platform);
      const policy =
        platform === "discord" ? createDiscordRelayPolicy(adapter) : createGithubRelayPolicy();
      const otherPlatform = platform === "discord" ? "github" : "discord";
      const crossPlatform = policy.refs.decodeReanchorTarget({
        ref: { platform: otherPlatform, channelId: "session", messageId: "message" },
        expectedSessionId: "session",
      });
      const crossSession = policy.refs.decodeReanchorTarget({
        ref: { platform, channelId: "other", messageId: "message" },
        expectedSessionId: "session",
      });

      expect(crossPlatform.status).toBe("error");
      if (crossPlatform.status === "error") {
        expect(crossPlatform.error.reason).toBe("platform-mismatch");
      }
      expect(crossSession.status).toBe("error");
      if (crossSession.status === "error") {
        expect(crossSession.error.reason).toBe("session-mismatch");
      }
    },
  );
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
