import { describe, expect, it } from "bun:test";

import {
  createLilacBus,
  lilacEventTypes,
  type AdapterPlatform,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Result } from "better-result";

import { startBusAgentRunner } from "../../../src/surface/bridge/bus-agent-runner";
import { getBuiltinSurfaceProtocol } from "../../../src/surface/builtin-surface-protocols";
import type { BuildLevel1ToolsetParams, CoreToolPluginManager } from "../../../src/plugins";
import { RequestControlAuthority } from "../../../src/tool-server/request-control-authority";
import type {
  ResolvedSurfaceProtocol,
  SurfaceProtocolResolver,
} from "../../../src/surface/runtime-descriptor";
import type { TrustedSubagentDelegationRegistration } from "../../../src/tools/subagent";
import type { WorkflowLiveParentBridge } from "../../../src/workflow/workflow-live-parent-bridge";
import type { WorkflowSubagentDispatcher } from "../../../src/workflow/workflow-subagent-dispatcher";
import { createInMemoryDeliveryBus } from "../../helpers/in-memory-delivery-bus";

/**
 * Capability issuance used to be gated on `discord | github`, so a Telegram
 * primary request ran with `controlCapability === null` and every
 * capability-gated Level-2 tool was rejected. The gate is now
 * `isSurfacePrincipalPlatform`, which admits telegram.
 *
 * These tests drive the real runner over an in-memory bus and observe the two
 * places the capability is externally visible: the `issueControlCapability`
 * callback, and `requestContext.metadata.controlCapability` on the toolset the
 * runner builds for the run.
 */

/** A Telegram identity distinct from anything a Discord fallback would produce. */
const TELEGRAM_CHAT = "1001";
const TELEGRAM_REQUEST_ID = `telegram:${TELEGRAM_CHAT}:10`;
const TELEGRAM_ACTOR_ID = "8792842071";
const TELEGRAM_AUTHENTICATED_ORIGIN = {
  platform: "telegram" as const,
  userId: TELEGRAM_ACTOR_ID,
  messageRef: {
    platform: "telegram" as const,
    channelId: TELEGRAM_CHAT,
    messageId: "10",
  },
};
const TEST_SURFACE_PROTOCOL_RESOLVER: SurfaceProtocolResolver = {
  resolve: (platform) => {
    const protocol = getBuiltinSurfaceProtocol(platform);
    return protocol ? ({ platform: protocol.platform, protocol } as ResolvedSurfaceProtocol) : null;
  },
};

function completedTextStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: "done" },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ],
    }),
  };
}

/**
 * The runner only ever calls `buildLevel1Toolset`. Every other member throws,
 * so a change that starts depending on one shows up as a failure rather than
 * as a silently-undefined value.
 */
function unexpectedCall(member: string): () => never {
  return () => {
    throw new Error(`bus-agent-runner unexpectedly called pluginManager.${member}`);
  };
}

function recordingPluginManager(
  onBuild: (params: BuildLevel1ToolsetParams) => void,
): CoreToolPluginManager {
  return {
    init: unexpectedCall("init"),
    destroy: unexpectedCall("destroy"),
    reload: unexpectedCall("reload"),
    ensureFresh: unexpectedCall("ensureFresh"),
    getStatuses: unexpectedCall("getStatuses"),
    getLevel2Tools: unexpectedCall("getLevel2Tools"),
    getLevel2ContributionInfo: unexpectedCall("getLevel2ContributionInfo"),
    buildLevel1ToolsetResult: async (params) => {
      onBuild(params);
      return Result.ok({
        tools: {},
        specs: new Map(),
        contributionInfo: new Map(),
        directToolNames: new Set<string>(),
        catalog: [],
        catalogMetadata: {},
        updateActiveBatchTools: () => {},
        genericOutputNormalizerBypassTools: new Set<string>(),
        aggregateOutputBudgetExemptTools: new Set<string>(),
      });
    },
  };
}

/**
 * A live-parent registration is required before the runner will expose the
 * subagent delegation hook, which is where the resolved principal surfaces.
 * The run under test never delegates for real, so every member reports "no
 * work pending".
 */
function stubLiveParentBridge(): WorkflowLiveParentBridge {
  const bridge: Pick<WorkflowLiveParentBridge, "registerParent"> = {
    registerParent: () => ({
      ready: Promise.resolve(),
      snapshot: () => ({
        signalVersion: 0,
        hasPendingCompletions: false,
        hasOutstandingRuns: false,
      }),
      listPending: () => [],
      isPending: () => false,
      listPendingAsync: async () => [],
      listPendingIdentities: () => [],
      listPendingSettledAsync: async () => [],
      acknowledge: async () => {},
      recordMaterializationFailure: () => null,
      clearMaterializationFailure: () => false,
      waitForSignalSince: async () => {},
      cancelAll: async () => {},
      close: async () => {},
    }),
  };
  return bridge as WorkflowLiveParentBridge;
}

type IssuedCapabilityCall = Parameters<
  NonNullable<Parameters<typeof startBusAgentRunner>[0]["issueControlCapability"]>
>[0];

type RunObservation = {
  issued: IssuedCapabilityCall[];
  builds: BuildLevel1ToolsetParams[];
  delegations: TrustedSubagentDelegationRegistration[];
  authority: RequestControlAuthority;
};

/**
 * Runs one `cmd.request.message` through a real `startBusAgentRunner` and
 * returns everything observable about the authority it was granted.
 *
 * The model call itself is never reached with a usable provider, and that is
 * fine: capability issuance happens strictly before the agent starts, so the
 * assertions below do not depend on a model response.
 */
async function runRequest(input: {
  requestClient: AdapterPlatform;
  requestId: string;
  sessionId: string;
  authenticatedOrigin?: typeof TELEGRAM_AUTHENTICATED_ORIGIN;
}): Promise<RunObservation> {
  const bus = createLilacBus(createInMemoryDeliveryBus());
  const authority = new RequestControlAuthority();
  const issued: IssuedCapabilityCall[] = [];
  const builds: BuildLevel1ToolsetParams[] = [];
  const delegations: TrustedSubagentDelegationRegistration[] = [];
  const config = parseCoreConfigV1ToUniversal({});
  config.models.main = { model: "openai/telegram-authority" };

  const dispatcher: Pick<WorkflowSubagentDispatcher, "delegate"> = {
    delegate: async (registration) => {
      delegations.push(registration);
      // The dispatcher's real work is out of scope; stop as soon as the
      // registration (and its fallback surface) has been captured.
      throw new Error("delegation captured by test");
    },
  };

  const runner = await startBusAgentRunner({
    bus,
    subscriptionId: `telegram-authority-${input.requestClient}`,
    config,
    pluginManager: recordingPluginManager((params) => builds.push(params)),
    cwd: "/workspace",
    surfaceProtocolResolver: TEST_SURFACE_PROTOCOL_RESOLVER,
    workflowLiveParentBridge: stubLiveParentBridge(),
    workflowSubagentDispatcher: dispatcher as WorkflowSubagentDispatcher,
    reportFatalPanic: () => undefined,
    issueControlCapability: (callInput) => {
      issued.push(callInput);
      const authenticatedOrigin = callInput.authenticatedOrigin ?? null;
      const principal = authenticatedOrigin
        ? { platform: authenticatedOrigin.platform, userId: authenticatedOrigin.userId }
        : null;
      const capability = authority.issue({
        kind: "primary",
        requestId: callInput.requestId,
        sessionId: callInput.sessionId,
        originSessionId: authenticatedOrigin?.sessionRef.channelId,
        platform: callInput.requestClient,
        principal,
        authenticatedOrigin,
        allowedCallables: null,
        profile: callInput.profile,
        canonicalCwd: callInput.canonicalCwd,
        safetyMode: callInput.safetyMode,
        expiresAt: callInput.expiresAt,
      });
      return {
        capability,
        principal,
        authenticatedOrigin,
        safetyMode: callInput.safetyMode,
      };
    },
    createAgent: (options) =>
      new AiSdkPiAgent({
        ...options,
        model: new MockLanguageModelV4({
          modelId: "telegram-authority",
          doStream: async () => completedTextStep(),
        }),
      }),
  });

  try {
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "who am I talking to?" }],
        raw: input.authenticatedOrigin ? { authenticatedOrigin: input.authenticatedOrigin } : {},
      },
      {
        headers: {
          request_id: input.requestId,
          session_id: input.sessionId,
          request_client: input.requestClient,
        },
      },
    );

    await runner.getActiveDrainOperation();

    // The delegation hook is what a `subagent_delegate` call would reach. The
    // model never gets that far here, so invoke it directly to read back the
    // trusted fallback surface the runner bound to this run.
    await invokeDelegationHook(builds[0]);
  } finally {
    await runner.stop();
  }

  return { issued, builds, delegations, authority };
}

function controlCapabilityOf(build: BuildLevel1ToolsetParams | undefined): unknown {
  return build?.requestContext?.metadata?.["controlCapability"];
}

/**
 * The runner exposes subagent delegation as `metadata.onSubagentDelegate`, and
 * only when it has a trusted fallback surface for the run. Calling it is the
 * only way to observe the principal the run was bound to.
 */
async function invokeDelegationHook(build: BuildLevel1ToolsetParams | undefined): Promise<void> {
  const hook = build?.requestContext?.metadata?.["onSubagentDelegate"];
  if (typeof hook !== "function") return;
  const delegate: (registration: { profile: string }) => Promise<unknown> = hook as (registration: {
    profile: string;
  }) => Promise<unknown>;
  // The stub dispatcher throws once it has recorded the registration.
  await delegate({ profile: "general" }).catch(() => {});
}

describe("level-2 control authority for a telegram primary request", () => {
  it("issues a capability for a request tagged as telegram", async () => {
    const { issued } = await runRequest({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      authenticatedOrigin: TELEGRAM_AUTHENTICATED_ORIGIN,
    });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      canonicalCwd: "/workspace",
      authenticatedOrigin: {
        platform: "telegram",
        userId: TELEGRAM_ACTOR_ID,
        sessionRef: { platform: "telegram", channelId: TELEGRAM_CHAT },
      },
    });
  });

  it("threads the issued capability into the run's tool execution context", async () => {
    // Regression guard for the original defect: the run proceeded, but with
    // `controlCapability === null`, so capability-gated Level-2 tools failed.
    const { issued, builds } = await runRequest({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      authenticatedOrigin: TELEGRAM_AUTHENTICATED_ORIGIN,
    });

    expect(builds).toHaveLength(1);
    const capability = controlCapabilityOf(builds[0]);
    expect(typeof capability).toBe("string");
    expect(capability).not.toBe("");
    expect(issued).toHaveLength(1);
    expect(builds[0]?.requestContext).toMatchObject({
      requestClient: "telegram",
      sessionId: TELEGRAM_CHAT,
      requestInitiator: { platform: "telegram", userId: TELEGRAM_ACTOR_ID },
      requestInitiatorSessionId: TELEGRAM_CHAT,
      safetyMode: "trusted",
    });
  });

  it("hands the run a capability the server authority actually accepts", async () => {
    // The token in the run context must be the same one the tool server will
    // validate; a stale or fabricated token would leave Level-2 tools rejected
    // exactly as they were before the fix.
    const { builds, authority } = await runRequest({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      authenticatedOrigin: TELEGRAM_AUTHENTICATED_ORIGIN,
    });

    const capability = controlCapabilityOf(builds[0]);
    if (typeof capability !== "string") {
      throw new Error("run received no control capability");
    }

    const policy = authority.authorize({
      token: capability,
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      platform: "telegram",
      now: Date.now(),
    });

    expect(policy).not.toBeNull();
    expect(policy?.kind).toBe("primary");
    expect(policy?.principal).toEqual({ platform: "telegram", userId: TELEGRAM_ACTOR_ID });
    expect(policy?.authenticatedOrigin).toEqual({
      platform: "telegram",
      userId: TELEGRAM_ACTOR_ID,
      sessionRef: { platform: "telegram", channelId: TELEGRAM_CHAT },
      messageRef: {
        platform: "telegram",
        channelId: TELEGRAM_CHAT,
        messageId: "10",
      },
    });
    // A capability is scoped to its platform; the same token must not authorize
    // a Discord-labelled call.
    expect(
      authority.authorize({
        token: capability,
        requestId: TELEGRAM_REQUEST_ID,
        sessionId: TELEGRAM_CHAT,
        platform: "discord",
        now: Date.now(),
      }),
    ).toBeNull();
  });

  it("carries platform telegram on the principal when an authenticated actor is present", async () => {
    const { delegations } = await runRequest({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      authenticatedOrigin: TELEGRAM_AUTHENTICATED_ORIGIN,
    });

    // The principal returned by issuance is recorded as the run's trusted
    // fallback surface, which is what a delegated subagent inherits.
    expect(delegations).toHaveLength(1);
    expect(delegations[0]?.fallbackSurface).toEqual({
      platform: "telegram",
      sessionId: TELEGRAM_CHAT,
      userId: TELEGRAM_ACTOR_ID,
    });
  });

  it("does not issue a capability for a surface that cannot be a principal", async () => {
    // Negative control. `slack` is a valid AdapterPlatform but is deliberately
    // absent from SurfacePrincipalPlatform, so it must run without authority.
    // If telegram were removed from that union, the telegram cases above would
    // look exactly like this one — which is what makes them non-vacuous.
    const { issued, builds, delegations } = await runRequest({
      requestClient: "slack",
      requestId: `slack:${TELEGRAM_CHAT}:10`,
      sessionId: TELEGRAM_CHAT,
    });

    expect(issued).toHaveLength(0);
    expect(builds).toHaveLength(1);
    expect(controlCapabilityOf(builds[0])).toBeUndefined();
    expect(delegations).toHaveLength(0);
  });
});
