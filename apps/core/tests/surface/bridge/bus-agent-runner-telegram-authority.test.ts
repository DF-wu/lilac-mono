import { describe, expect, it } from "bun:test";

import {
  createLilacBus,
  lilacEventTypes,
  type AdapterPlatform,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";

import { startBusAgentRunner } from "../../../src/surface/bridge/bus-agent-runner";
import type { BuildLevel1ToolsetParams, CoreToolPluginManager } from "../../../src/plugins";
import { RequestControlAuthority } from "../../../src/tool-server/request-control-authority";
import type { SurfacePrincipalPlatform } from "../../../src/surface/types";
import type { TrustedSubagentDelegationRegistration } from "../../../src/tools/subagent";
import type { WorkflowLiveParentBridge } from "../../../src/workflow/workflow-live-parent-bridge";
import type { WorkflowSubagentDispatcher } from "../../../src/workflow/workflow-subagent-dispatcher";

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

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${topics.get(opts.topic)?.length ?? 0}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      topics.set(opts.topic, [...(topics.get(opts.topic) ?? []), stored]);
      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }
      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      _opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        handler: handler as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);
      return { stop: async () => void subs.delete(entry) };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({ msg: m as unknown as Message<TData>, cursor: m.id })),
        ...(existing.length > 0 ? { next: existing[existing.length - 1]?.id } : {}),
      };
    },

    close: async () => {},
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
    buildLevel1Toolset: async (params) => {
      onBuild(params);
      return {
        tools: {},
        specs: new Map(),
        directToolNames: new Set<string>(),
        catalog: [],
        catalogMetadata: {},
        updateActiveBatchTools: () => {},
        genericOutputNormalizerBypassTools: new Set<string>(),
        aggregateOutputBudgetExemptTools: new Set<string>(),
      };
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

type IssuedCapabilityCall = {
  requestId: string;
  sessionId: string;
  originSessionId?: string;
  requestClient: AdapterPlatform;
  canonicalCwd: string;
  principal?: { platform: SurfacePrincipalPlatform; userId: string };
};

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
  /** When set, the runner is told the request has an authenticated actor. */
  principal?: { platform: SurfacePrincipalPlatform; userId: string };
}): Promise<RunObservation> {
  const bus = createLilacBus(createInMemoryRawBus());
  const authority = new RequestControlAuthority();
  const issued: IssuedCapabilityCall[] = [];
  const builds: BuildLevel1ToolsetParams[] = [];
  const delegations: TrustedSubagentDelegationRegistration[] = [];

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
    config: parseCoreConfigV1ToUniversal({}),
    pluginManager: recordingPluginManager((params) => builds.push(params)),
    cwd: "/workspace",
    workflowLiveParentBridge: stubLiveParentBridge(),
    workflowSubagentDispatcher: dispatcher as WorkflowSubagentDispatcher,
    issueControlCapability: (callInput) => {
      issued.push(callInput);
      // Issue through the real authority so the token is a genuine one and the
      // principal is whatever the server would actually record.
      const principal = callInput.principal ?? input.principal ?? null;
      const capability = authority.issue({
        kind: "primary",
        requestId: callInput.requestId,
        sessionId: callInput.sessionId,
        originSessionId: callInput.originSessionId,
        platform: callInput.requestClient,
        principal,
        allowedCallables: null,
        profile: callInput.profile,
        canonicalCwd: callInput.canonicalCwd,
        safetyMode: callInput.safetyMode,
        expiresAt: callInput.expiresAt,
      });
      return { capability, originSessionId: callInput.originSessionId, principal };
    },
  });

  try {
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "who am I talking to?" }],
        raw: {},
      },
      {
        headers: {
          request_id: input.requestId,
          session_id: input.sessionId,
          request_client: input.requestClient,
        },
      },
    );

    // Rejection-only guard; it never delays the successful path. The run is
    // complete once the toolset has been built, which is strictly after the
    // capability decision.
    const deadline = Date.now() + 10_000;
    while (builds.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

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
    });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
      originSessionId: TELEGRAM_CHAT,
      canonicalCwd: "/workspace",
    });
  });

  it("threads the issued capability into the run's tool execution context", async () => {
    // Regression guard for the original defect: the run proceeded, but with
    // `controlCapability === null`, so capability-gated Level-2 tools failed.
    const { issued, builds } = await runRequest({
      requestClient: "telegram",
      requestId: TELEGRAM_REQUEST_ID,
      sessionId: TELEGRAM_CHAT,
    });

    expect(builds).toHaveLength(1);
    const capability = controlCapabilityOf(builds[0]);
    expect(typeof capability).toBe("string");
    expect(capability).not.toBe("");
    expect(issued).toHaveLength(1);
    expect(builds[0]?.requestContext).toMatchObject({
      requestClient: "telegram",
      sessionId: TELEGRAM_CHAT,
      originSessionId: TELEGRAM_CHAT,
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
      principal: { platform: "telegram", userId: TELEGRAM_ACTOR_ID },
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
      principal: { platform: "telegram", userId: TELEGRAM_ACTOR_ID },
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
