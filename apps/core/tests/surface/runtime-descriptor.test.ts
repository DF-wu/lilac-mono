import { describe, expect, expectTypeOf, it, spyOn } from "bun:test";
import { Panic, Result } from "better-result";

import { GithubApiError } from "../../src/github/github-api";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import { SurfaceMessageNotFoundError } from "../../src/surface/adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
  createDiscordWorkflowProgressPort,
} from "../../src/surface/discord/discord-runtime-descriptor";
import { GithubMessageCreatedError } from "../../src/surface/github/github-adapter";
import {
  createConfiguredGithubSurfaceRuntimeDescriptor,
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
  createGithubWorkflowProgressPort,
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
  type WorkflowProgressCheckFailure,
  type WorkflowProgressSendFailure,
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
    return sessionRef.platform === "discord"
      ? { platform: "discord", channelId: sessionRef.channelId, messageId: "message" }
      : { platform: "github", channelId: sessionRef.channelId, messageId: "message" };
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

function discordDescriptor(
  adapter: SurfaceAdapter = new TestAdapter("discord"),
): SurfaceRuntimeDescriptor<"discord"> {
  return createDiscordSurfaceRuntimeDescriptor({
    adapter,
    adapterIngress: discordAdapterIngress(),
    relay: discordRelay(),
  });
}

function githubDescriptor(
  adapter: SurfaceAdapter = new TestAdapter("github"),
): SurfaceRuntimeDescriptor<"github"> {
  return createGithubSurfaceRuntimeDescriptor({
    adapter,
    requestIngress: requestIngress(),
    relay: githubRelay(),
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

  it("excludes operation outcomes that protocol ports cannot produce", () => {
    type Created = {
      readonly kind: "created";
      readonly ref: {
        readonly platform: "github";
        readonly channelId: string;
        readonly messageId: string;
      };
    };

    expectTypeOf<IsAssignable<Created, WorkflowProgressCheckFailure>>().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<Created, WorkflowProgressSendFailure<"discord">>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<Created, WorkflowProgressSendFailure<"github">>
    >().toEqualTypeOf<true>();
  });

  it("assembles every existing Discord subsystem without adding generic sidecars", () => {
    const adapter = new TestAdapter("discord");
    const adapterIngress = discordAdapterIngress();
    const relay = discordRelay();
    const descriptor = createDiscordSurfaceRuntimeDescriptor({
      adapter,
      adapterIngress,
      relay,
    });

    expect(descriptor).toEqual({
      platform: "discord",
      adapter,
      adapterIngress,
      relay,
      workflowProgress: descriptor.workflowProgress,
    });
    expect("requestIngress" in descriptor).toBe(false);
    expect("health" in descriptor).toBe(false);
    expect("surfaceStore" in descriptor).toBe(false);
    expect("refs" in descriptor.relay!).toBe(true);
  });

  it("exposes GitHub workflow progress only with authenticated request ingress", () => {
    for (const requestIngressEnabled of [false, true]) {
      for (const relayEnabled of [false, true]) {
        const descriptor = createGithubSurfaceRuntimeDescriptor({
          adapter: new TestAdapter("github"),
          ...(requestIngressEnabled ? { requestIngress: requestIngress() } : {}),
          ...(relayEnabled ? { relay: githubRelay() } : {}),
        });

        expect("requestIngress" in descriptor).toBe(requestIngressEnabled);
        expect("relay" in descriptor).toBe(relayEnabled);
        expect(descriptor.workflowProgress === undefined).toBe(!requestIngressEnabled);
        expect("workflowProgress" in descriptor).toBe(requestIngressEnabled);
        expect("adapterIngress" in descriptor).toBe(false);
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
      const descriptor = createConfiguredGithubSurfaceRuntimeDescriptor({
        adapter,
        webhookSecret: webhookConfigured ? "webhook-secret" : undefined,
        appCredentialsAvailable,
        requestIngress: ingress,
        relay,
        logger: {
          info: (message, context) => logs.push({ level: "info", message, context }),
          warn: (message, context) => logs.push({ level: "warn", message, context }),
        },
      });

      const requestIngressAvailable = webhookConfigured && appCredentialsAvailable;
      expect(descriptor.adapter).toBe(adapter);
      expect(descriptor.requestIngress).toBe(requestIngressAvailable ? ingress : undefined);
      expect(descriptor.relay).toBe(appCredentialsAvailable ? relay : undefined);
      expect("workflowProgress" in descriptor).toBe(requestIngressAvailable);
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

describe("surface workflow progress ports", () => {
  it("constructs protocol refs and preserves action content and silent reply options", async () => {
    const adapter = new TestAdapter("discord");
    const send = spyOn(adapter, "sendMsg");
    const port = createDiscordWorkflowProgressPort(adapter);
    const content = {
      text: "Queued",
      actions: [{ actionId: "action-token", label: "Cancel", style: "danger" as const }],
    };

    const sent = await port.send({
      channelId: "channel",
      content,
      replyToMessageId: "origin",
      silent: true,
    });

    expect(sent).toEqual(
      Result.ok({ platform: "discord", channelId: "channel", messageId: "message" }),
    );
    expect(send).toHaveBeenCalledWith({ platform: "discord", channelId: "channel" }, content, {
      replyTo: { platform: "discord", channelId: "channel", messageId: "origin" },
      silent: true,
    });
  });

  it("returns closed Discord and GitHub failure outcomes and preserves Panic", async () => {
    const discordAdapter = new TestAdapter("discord");
    const discordPort = createDiscordWorkflowProgressPort(discordAdapter);
    spyOn(discordAdapter, "editMsg").mockRejectedValue(
      new SurfaceMessageNotFoundError("discord", 10008, "missing"),
    );
    expect(
      await discordPort.edit({ channelId: "channel", messageId: "missing" }, { text: "edit" }),
    ).toEqual(Result.err({ kind: "not-found" }));

    const githubAdapter = new TestAdapter("github");
    const githubPort = createGithubWorkflowProgressPort(githubAdapter);
    const createdRef = { platform: "github" as const, channelId: "octo/repo#1", messageId: "42" };
    spyOn(githubAdapter, "sendMsg").mockRejectedValue(
      new GithubMessageCreatedError(createdRef, new Error("action edit failed")),
    );
    expect(
      await githubPort.send({ channelId: "octo/repo#1", content: { text: "Queued" } }),
    ).toEqual(Result.err({ kind: "created", ref: createdRef }));

    spyOn(githubAdapter, "editMsg").mockRejectedValue(
      new GithubApiError(404, "/repos/octo/repo/issues/comments/42", "missing"),
    );
    expect(
      await githubPort.edit({ channelId: "octo/repo#1", messageId: "42" }, { text: "edit" }),
    ).toEqual(Result.err({ kind: "not-found" }));

    const panic = new Panic({ message: "workflow progress defect" });
    spyOn(githubAdapter, "readMsg").mockRejectedValue(panic);
    await expect(
      githubPort.checkMessage({ channelId: "octo/repo#1", messageId: "42" }),
    ).rejects.toBe(panic);
  });

  it("maps non-Error rejections to an opaque local failure", async () => {
    const adapter = new TestAdapter("discord");
    const port = createDiscordWorkflowProgressPort(adapter);
    spyOn(adapter, "sendMsg").mockRejectedValue("provider-secret-rejection");

    const sent = await port.send({ channelId: "channel", content: { text: "Queued" } });

    expect(sent.status).toBe("error");
    if (sent.status === "error") {
      switch (sent.error.kind) {
        case "failed":
          expect(sent.error.error.message).toBe("Opaque workflow progress surface failure");
          expect(sent.error.error.message).not.toContain("provider-secret-rejection");
          break;
      }
    }
  });
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
  it("preserves registration order", () => {
    const discord = discordDescriptor();
    const github = githubDescriptor();
    const created = SurfaceRuntimeRegistry.create([discord, github]);

    expect(created.status).toBe("ok");
    if (created.status === "error") return;
    expect(created.value.entries()).toEqual([discord, github]);
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
