import { describe, expect, expectTypeOf, it, spyOn } from "bun:test";
import { Panic, Result } from "better-result";

import type {
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOperationResult,
  SurfaceOutputStream,
  SurfaceSendPreparationInput,
} from "../../src/surface/adapter";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
} from "../../src/surface/adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
  createDiscordWorkflowProgressPort,
  DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
} from "../../src/surface/discord/discord-runtime-descriptor";
import {
  createConfiguredGithubSurfaceRuntimeDescriptor,
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
  createGithubWorkflowProgressPort,
  GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
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
  SurfacePlatform,
  SurfaceMessage,
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

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
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

  async sendMsg(
    sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    return Result.ok(
      (sessionRef.platform === "discord"
        ? { platform: "discord", channelId: sessionRef.channelId, messageId: "message" }
        : { platform: "github", channelId: sessionRef.channelId, messageId: "message" }) as MsgRef,
    );
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    return Result.ok(null);
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }

  async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
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
        prepareRestoreRelays: () =>
          Result.ok({
            platform: "discord",
            apply: async () => Result.ok(undefined),
            rollback: async () => Result.ok(undefined),
            activate: () => undefined,
          }),
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
        prepareRestoreRelays: () =>
          Result.ok({
            platform: "github",
            apply: async () => Result.ok(undefined),
            rollback: async () => Result.ok(undefined),
            activate: () => undefined,
          }),
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
    type GithubCreated = {
      readonly kind: "created";
      readonly ref: {
        readonly platform: "github";
        readonly channelId: string;
        readonly messageId: string;
      };
    };
    type DiscordCreated = {
      readonly kind: "created";
      readonly ref: {
        readonly platform: "discord";
        readonly channelId: string;
        readonly messageId: string;
      };
    };

    expectTypeOf<
      IsAssignable<GithubCreated, WorkflowProgressCheckFailure>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<DiscordCreated, WorkflowProgressSendFailure<"discord">>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsAssignable<GithubCreated, WorkflowProgressSendFailure<"github">>
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
      adapter: descriptor.adapter,
      adapterIngress,
      relay,
      workflowProgress: descriptor.workflowProgress,
    });
    expect(descriptor.adapter).not.toBe(adapter);
    expect("requestIngress" in descriptor).toBe(false);
    expect("health" in descriptor).toBe(false);
    expect("surfaceStore" in descriptor).toBe(false);
    expect("refs" in descriptor.relay!).toBe(true);
  });

  it("exposes GitHub workflow progress independently of ingress and relay", () => {
    for (const requestIngressEnabled of [false, true]) {
      for (const relayEnabled of [false, true]) {
        const descriptor = createGithubSurfaceRuntimeDescriptor({
          adapter: new TestAdapter("github"),
          ...(requestIngressEnabled ? { requestIngress: requestIngress() } : {}),
          ...(relayEnabled ? { relay: githubRelay() } : {}),
        });

        expect("requestIngress" in descriptor).toBe(requestIngressEnabled);
        expect("relay" in descriptor).toBe(relayEnabled);
        expect(descriptor.workflowProgress).toBeDefined();
        expect("workflowProgress" in descriptor).toBe(true);
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
      expect(descriptor.adapter).not.toBe(adapter);
      expect(descriptor.requestIngress).toBe(requestIngressAvailable ? ingress : undefined);
      expect(descriptor.relay).toBe(appCredentialsAvailable ? relay : undefined);
      expect(descriptor.workflowProgress).toBeDefined();
      expect("workflowProgress" in descriptor).toBe(true);
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
  it("uses explicit adapter contract revisions rather than remote credential state", () => {
    expect(
      createDiscordWorkflowProgressPort(new TestAdapter("discord")).configurationRevision,
    ).toBe(DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION);
    expect(createGithubWorkflowProgressPort(new TestAdapter("github")).configurationRevision).toBe(
      GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
    );
  });

  it.each(["discord", "github"] as const)(
    "applies the complete canonical failure policy for %s",
    async (platform) => {
      const createPort = (adapter: TestAdapter) =>
        platform === "discord"
          ? createDiscordWorkflowProgressPort(adapter)
          : createGithubWorkflowProgressPort(adapter);
      const errors = [
        [
          new SurfaceOperationUnsupported({
            platform,
            operation: "send-message",
            message: "unsupported",
          }),
          "permanent",
          "unsupported",
        ],
        [
          new SurfaceInvalidInput({
            platform,
            operation: "send-message",
            field: "channelId",
            message: "invalid",
          }),
          "permanent",
          "invalid-input",
        ],
        [
          new SurfacePlatformMismatch({
            operation: "send-message",
            refRole: "session",
            expectedPlatform: platform,
            receivedPlatform: platform === "discord" ? "github" : "discord",
            message: "platform mismatch",
          }),
          "permanent",
          "platform-mismatch",
        ],
        [
          new SurfaceSessionMismatch({
            operation: "send-message",
            refRole: "replyTo",
            expectedSessionId: "channel",
            receivedSessionId: "other",
            message: "session mismatch",
          }),
          "permanent",
          "session-mismatch",
        ],
        [
          new SurfaceMessageNotFound({
            platform,
            operation: "send-message",
            message: "not found",
          }),
          "permanent",
          "not-found",
        ],
        [
          new SurfacePermissionDenied({
            platform,
            operation: "send-message",
            message: "denied",
          }),
          "retryable",
          "permission-denied",
        ],
        [
          new SurfaceRateLimited({
            platform,
            operation: "send-message",
            retryAfterMs: 100,
            message: "limited",
          }),
          "retryable",
          "rate-limited",
        ],
        [
          new SurfaceUnavailable({
            platform,
            operation: "send-message",
            message: "unavailable",
          }),
          "retryable",
          "unavailable",
        ],
      ] as const;
      for (const [surfaceError, disposition, reason] of errors) {
        const adapter = new TestAdapter(platform);
        spyOn(adapter, "sendMsg").mockResolvedValue(Result.err(surfaceError));
        const sent = await createPort(adapter).send({
          channelId: "channel",
          content: { text: "Queued" },
        });
        expect(sent.status).toBe("error");
        if (sent.status === "error" && sent.error.kind === "failed") {
          expect(sent.error.error).toMatchObject({ disposition, reason, operation: "send" });
          if (reason === "rate-limited") expect(sent.error.error.retryAfterMs).toBe(100);
        }
      }

      const notFoundAdapter = new TestAdapter(platform);
      spyOn(notFoundAdapter, "readMsg").mockResolvedValue(
        Result.err(
          new SurfaceMessageNotFound({
            platform,
            operation: "read-message",
            message: "missing",
          }),
        ),
      );
      spyOn(notFoundAdapter, "editMsg").mockResolvedValue(
        Result.err(
          new SurfaceMessageNotFound({
            platform,
            operation: "edit-message",
            message: "missing",
          }),
        ),
      );
      const notFoundPort = createPort(notFoundAdapter);
      expect(
        await notFoundPort.checkMessage({ channelId: "channel", messageId: "message" }),
      ).toEqual(Result.ok("missing"));
      expect(
        await notFoundPort.edit(
          { channelId: "channel", messageId: "message" },
          { text: "Running" },
        ),
      ).toEqual(Result.err({ kind: "not-found" }));

      const permanentAdapter = new TestAdapter(platform);
      spyOn(permanentAdapter, "readMsg").mockResolvedValue(
        Result.err(
          new SurfacePermissionDenied({
            platform,
            operation: "read-message",
            message: "denied",
          }),
        ),
      );
      spyOn(permanentAdapter, "editMsg").mockResolvedValue(
        Result.err(
          new SurfaceOperationUnsupported({
            platform,
            operation: "edit-message",
            message: "unsupported",
          }),
        ),
      );
      const permanentPort = createPort(permanentAdapter);
      const checked = await permanentPort.checkMessage({
        channelId: "channel",
        messageId: "message",
      });
      expect(checked.status).toBe("error");
      if (checked.status === "error") {
        expect(checked.error.error).toMatchObject({
          operation: "check-message",
          disposition: "retryable",
          reason: "permission-denied",
        });
      }
      const edited = await permanentPort.edit(
        { channelId: "channel", messageId: "message" },
        { text: "Running" },
      );
      expect(edited.status).toBe("error");
      if (edited.status === "error" && edited.error.kind === "failed") {
        expect(edited.error.error).toMatchObject({
          operation: "edit",
          disposition: "permanent",
          reason: "unsupported",
        });
      }

      const partialAdapter = new TestAdapter(platform);
      const created: MsgRef =
        platform === "discord"
          ? { platform: "discord", channelId: "channel", messageId: "created" }
          : { platform: "github", channelId: "channel", messageId: "created" };
      spyOn(partialAdapter, "sendMsg").mockResolvedValue(
        Result.err(
          new SurfaceOperationPartiallyCompleted({
            platform,
            operation: "send-message",
            created,
            message: "partially created",
          }),
        ),
      );
      const partial = await createPort(partialAdapter).send({
        channelId: "channel",
        content: { text: "Queued" },
      });
      expect(partial.status).toBe("error");
      if (partial.status === "error") {
        expect(partial.error.kind).toBe("created");
        if (partial.error.kind === "created") expect(partial.error.ref).toEqual(created);
      }
    },
  );

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

  it("preserves Panic identity through workflow progress ports", async () => {
    const githubAdapter = new TestAdapter("github");
    const githubPort = createGithubWorkflowProgressPort(githubAdapter);
    const panic = new Panic({ message: "workflow progress defect" });
    spyOn(githubAdapter, "readMsg").mockRejectedValue(panic);
    await expect(
      githubPort.checkMessage({ channelId: "octo/repo#1", messageId: "42" }),
    ).rejects.toBe(panic);
  });

  it("preserves unrecognized non-Error rejections as defects", async () => {
    const adapter = new TestAdapter("discord");
    const port = createDiscordWorkflowProgressPort(adapter);
    const rejection = "provider-secret-rejection";
    spyOn(adapter, "sendMsg").mockRejectedValue(rejection);

    await expect(port.send({ channelId: "channel", content: { text: "Queued" } })).rejects.toBe(
      rejection,
    );
  });
});

describe("surface relay policies", () => {
  it("signals Discord skipped-output cleanup failures to the relay host", async () => {
    const adapter = new TestAdapter("discord");
    const failure = new SurfaceUnavailable({
      platform: "discord",
      operation: "delete-message",
      message: "cleanup failed",
    });
    spyOn(adapter, "deleteMsg").mockResolvedValue(Result.err(failure));
    const policy = createDiscordRelayPolicy(adapter);
    const cleanupSkippedOutput = policy.finalization?.cleanupSkippedOutput;
    if (!cleanupSkippedOutput) throw new Error("missing Discord skipped-output cleanup");

    await expect(
      cleanupSkippedOutput({
        ref: { platform: "discord", channelId: "channel", messageId: "message" },
      }),
    ).rejects.toBe(failure);
  });

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
  it("resolves only registered adapters through descriptor-bound facades", async () => {
    const discordAdapter = new TestAdapter("discord");
    const githubAdapter = new TestAdapter("github");
    const created = SurfaceRuntimeRegistry.create([
      { platform: "discord", adapter: discordAdapter },
      { platform: "github", adapter: githubAdapter },
    ]);
    if (created.status === "error") throw created.error;

    const resolver = created.value.adapterResolver();
    expect(resolver.registeredPlatforms()).toEqual(["discord", "github"]);
    expect(resolver.resolve("discord")).toMatchObject({ platform: "discord" });
    expect(resolver.resolve("github")).toMatchObject({ platform: "github" });
    expect(resolver.resolve("slack")).toBeNull();
    expect(resolver.resolve("unknown")).toBeNull();
    expect(resolver.resolve("discord")?.adapter).not.toBe(discordAdapter);
    expect(resolver.resolve("github")?.adapter).not.toBe(githubAdapter);
  });

  it("does not resolve an implemented wire platform unless its descriptor is registered", () => {
    const created = SurfaceRuntimeRegistry.create([discordDescriptor()]);
    if (created.status === "error") throw created.error;

    expect(created.value.adapterResolver().resolve("github")).toBeNull();
  });

  it("exposes only a descriptor-bound adapter facade from direct registrations", async () => {
    const adapter = new TestAdapter("discord");
    spyOn(adapter, "listSessions").mockResolvedValue(
      Result.ok([
        {
          ref: { platform: "github", channelId: "octo/repo#1" },
          kind: "thread",
        },
      ]),
    );
    const created = SurfaceRuntimeRegistry.create([{ platform: "discord", adapter }]);
    if (created.status === "error") throw created.error;
    const [descriptor] = created.value.entries();
    if (!descriptor) throw new Error("missing descriptor");

    expect(descriptor.adapter).not.toBe(adapter);
    const [settled] = await Promise.allSettled([descriptor.adapter.listSessions()]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status !== "rejected") return;
    expect(Panic.is(settled.reason)).toBe(true);
  });

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
      expect(String(settled.reason)).toContain(`for '${descriptorPlatform}'`);
      expect(String(settled.reason)).toContain(`received '${adapterPlatform}'`);
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
