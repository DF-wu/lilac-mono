import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

import type { SurfaceAdapter } from "../surface/adapter";
import type {
  AgentRecoveryAttempt,
  AgentRecoveryUnavailable,
  AgentRunnerQueueAttempt,
  AgentRunnerRecoveryEntry,
} from "../surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressRegistration,
  SurfaceAdapterIngressHandle,
  SurfaceRelayHandle,
  SurfaceRelayRestoreAttempt,
  SurfaceRelayRestoreRollbackFailed,
  SurfaceRequestIngressHandle,
  SurfaceRuntimeRegistry,
} from "../surface/runtime-descriptor";
import { SurfaceRelayRestoreApplyFailed } from "../surface/runtime-descriptor";
import {
  requireDescriptorPlatform,
  requireSurfaceRelaySnapshot,
} from "../surface/produced-ref-guard";

type AgentRecovery = {
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRecoverables(): AgentRunnerRecoveryEntry[];
  snapshotQueueAttempts(): AgentRunnerQueueAttempt[];
  prepareRecovery(input: {
    readonly entries: readonly AgentRunnerRecoveryEntry[];
    readonly queueAttempts: readonly AgentRunnerQueueAttempt[];
  }): ResultType<AgentRecoveryAttempt, AgentRecoveryUnavailable>;
};

export class SurfaceRecoveryUnavailable extends TaggedError("SurfaceRecoveryUnavailable")<{
  readonly requestId: string;
  readonly platform: AdapterPlatform;
  readonly sessionId: string;
  readonly reason:
    | "descriptor-unavailable"
    | "relay-port-unavailable"
    | "relay-handle-unavailable"
    | "agent-attempt-unavailable"
    | "legacy-queue-proof-ambiguous";
  readonly message: string;
}> {}

export type SurfaceRecoveryPlan = {
  readonly snapshot: {
    readonly createdAt: number;
    readonly deadlineMs: number;
    readonly agent: readonly AgentRunnerRecoveryEntry[];
    readonly queueAttempts: readonly AgentRunnerQueueAttempt[];
    readonly queueAttemptProof: "complete" | "legacy-ambiguous";
    readonly relays: readonly BusToAdapterRelaySnapshot[];
  };
  readonly attempts: readonly SurfaceRelayRestoreAttempt<RegisteredSurfacePlatform>[];
  readonly agentAttempt: AgentRecoveryAttempt;
};

const activatedRecoveryPlans = new WeakSet<SurfaceRecoveryPlan>();

export type PausedSurfaceRecoveryOwnership = {
  readonly plan: SurfaceRecoveryPlan;
  activate(): void;
  rollback(): Promise<void>;
};

export function createPausedSurfaceRecoveryOwnership(
  plan: SurfaceRecoveryPlan,
): PausedSurfaceRecoveryOwnership {
  let state: "pending" | "active" | "rolled-back" = "pending";
  return {
    plan,
    activate: () => {
      if (state !== "pending") return;
      state = "active";
      activateSurfaceRecovery(plan);
    },
    rollback: async () => {
      if (state !== "pending") return;
      state = "rolled-back";
      await rollbackSurfaceRecovery(plan);
    },
  };
}

function signalSurfaceRecoveryRollbackAtomicityUnknown(
  message: string,
  failures: readonly SurfaceRelayRestoreRollbackFailed[],
): never {
  throw new Panic({ message, cause: failures });
}

type CleanupRunner = (label: string, cleanup: (() => Promise<void>) | undefined) => Promise<void>;

export type ConnectedSurfaceAdapters = Map<RegisteredSurfacePlatform, SurfaceAdapter>;
export type SurfaceAdapterIngressHandles = Map<
  RegisteredSurfacePlatform,
  SurfaceAdapterIngressHandle<RegisteredSurfacePlatform>
>;
export type SurfaceRequestIngressHandles = Map<
  RegisteredSurfacePlatform,
  SurfaceRequestIngressHandle
>;
export type SurfaceRelayHandles = Map<
  RegisteredSurfacePlatform,
  SurfaceRelayHandle<RegisteredSurfacePlatform>
>;

function reverseEntries(registry: SurfaceRuntimeRegistry) {
  return registry.entries().toReversed();
}

function surfaceCleanupLabel(input: {
  readonly platform: RegisteredSurfacePlatform;
  readonly resource: "adapter" | "adapter-ingress" | "relay" | "request-ingress";
  readonly operation: "beginDrain" | "disconnect" | "snapshotRelays" | "stop";
  readonly graceful?: boolean;
}): string {
  return `${input.graceful ? "graceful." : ""}surface.${input.platform}.${input.resource}.${input.operation}`;
}

export function createSurfaceWorkflowProgressPortMap(
  registry: SurfaceRuntimeRegistry,
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration>();
  for (const descriptor of registry.entries()) {
    if (descriptor.workflowProgress) {
      ports.set(descriptor.platform, {
        platform: descriptor.platform,
        protocol: descriptor.protocol,
        port: descriptor.workflowProgress,
      } as RegisteredSurfaceWorkflowProgressRegistration);
    }
  }
  return ports;
}

export async function startSurfaceAdapterIngress(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly handles: SurfaceAdapterIngressHandles;
}): Promise<void> {
  for (const descriptor of input.registry.entries()) {
    if (!descriptor.adapterIngress) continue;
    const handle = await descriptor.adapterIngress.start();
    input.handles.set(descriptor.platform, handle);
  }
}

export async function connectAndValidateSurfaceAdapters(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly connected: ConnectedSurfaceAdapters;
}): Promise<void> {
  for (const descriptor of input.registry.entries()) {
    input.connected.set(descriptor.platform, descriptor.adapter);
    await descriptor.adapter.connect();
  }
  await input.registry.validateAdapterPlatforms();
}

export async function startSurfaceOutputs(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly requestIngress: SurfaceRequestIngressHandles;
  readonly relays: SurfaceRelayHandles;
}): Promise<void> {
  for (const descriptor of input.registry.entries()) {
    if (descriptor.requestIngress) {
      const handle = await descriptor.requestIngress.start();
      input.requestIngress.set(descriptor.platform, handle);
    }
    if (descriptor.relay) {
      const handle = await descriptor.relay.lifecycle.start();
      requireDescriptorPlatform(
        descriptor.platform,
        handle.platform,
        "surfaceRelay.lifecycle.start",
      );
      input.relays.set(descriptor.platform, handle);
    }
  }
}

export function prepareSurfaceRecovery(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly snapshot: {
    readonly createdAt: number;
    readonly deadlineMs: number;
    readonly agent: readonly AgentRunnerRecoveryEntry[];
    readonly queueAttempts: readonly AgentRunnerQueueAttempt[];
    readonly queueAttemptProof: "complete" | "legacy-ambiguous";
    readonly relays: readonly BusToAdapterRelaySnapshot[];
  };
  readonly relays: SurfaceRelayHandles;
  readonly agentRunner: Pick<AgentRecovery, "prepareRecovery">;
}): ResultType<
  SurfaceRecoveryPlan,
  SurfaceRecoveryUnavailable | SurfaceRelayRestoreApplyFailed | AgentRecoveryUnavailable
> {
  if (input.snapshot.queueAttemptProof === "legacy-ambiguous" && input.snapshot.agent.length > 0) {
    const first = input.snapshot.agent[0];
    return Result.err(
      new SurfaceRecoveryUnavailable({
        requestId: first?.requestId ?? "legacy-recovery",
        platform: first?.requestClient ?? "unknown",
        sessionId: first?.sessionId ?? "legacy-recovery",
        reason: "legacy-queue-proof-ambiguous",
        message: "Legacy recovery cannot prove the absence of parked queue reservations",
      }),
    );
  }
  const unsafeAttempt = input.snapshot.queueAttempts.find(
    (attempt) => attempt.kind === "buffered-absorption" && !attempt.controlApplied,
  );
  if (unsafeAttempt) {
    return Result.err(
      new SurfaceRecoveryUnavailable({
        requestId: unsafeAttempt.controlRequestId,
        platform: unsafeAttempt.controlRequestClient,
        sessionId: unsafeAttempt.sessionId,
        reason: "agent-attempt-unavailable",
        message: "Buffered queue control was not durably applied before process replacement",
      }),
    );
  }
  const requiredAgentSurfaces = new Map<
    RegisteredSurfacePlatform,
    { readonly requestId: string; readonly sessionId: string }
  >();
  for (const entry of input.snapshot.agent) {
    if (entry.requestClient === "discord" || entry.requestClient === "github") {
      requiredAgentSurfaces.set(entry.requestClient, {
        requestId: entry.requestId,
        sessionId: entry.sessionId,
      });
    }
    const identity = entry.identity;
    if (identity?.state === "durable" && identity.projection.authenticatedOrigin) {
      const origin = identity.projection.authenticatedOrigin;
      requiredAgentSurfaces.set(origin.platform, {
        requestId: entry.requestId,
        sessionId: origin.sessionRef.channelId,
      });
    }
  }
  for (const [platform, required] of requiredAgentSurfaces) {
    const descriptor = input.registry.entries().find((entry) => entry.platform === platform);
    if (!descriptor) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          ...required,
          platform,
          reason: "descriptor-unavailable",
          message: "Recovery agent surface descriptor is unavailable",
        }),
      );
    }
    if (!descriptor.relay) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          ...required,
          platform,
          reason: "relay-port-unavailable",
          message: "Recovery agent surface relay port is unavailable",
        }),
      );
    }
    if (!input.relays.has(platform)) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          ...required,
          platform,
          reason: "relay-handle-unavailable",
          message: "Recovery agent surface relay handle is unavailable",
        }),
      );
    }
  }
  const agentAttempt = input.agentRunner.prepareRecovery({
    entries: input.snapshot.agent,
    queueAttempts: input.snapshot.queueAttempts,
  });
  if (agentAttempt.status === "error") return Result.err(agentAttempt.error);
  const identities = new Set<string>();
  for (const snapshot of input.snapshot.relays) {
    const identity = `${snapshot.requestId}\u0000${snapshot.platform}\u0000${snapshot.sessionId}`;
    if (identities.has(identity)) {
      return Result.err(
        new SurfaceRelayRestoreApplyFailed({
          platform: snapshot.platform,
          requestId: snapshot.requestId,
          message: "Graceful restart snapshot contains a duplicate relay identity",
        }),
      );
    }
    identities.add(identity);
    const descriptor = input.registry
      .entries()
      .find((candidate) => candidate.platform === snapshot.platform);
    if (!descriptor) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          requestId: snapshot.requestId,
          platform: snapshot.platform,
          sessionId: snapshot.sessionId,
          reason: "descriptor-unavailable",
          message: "Graceful restart surface descriptor is unavailable",
        }),
      );
    }
    if (!descriptor.relay) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          requestId: snapshot.requestId,
          platform: snapshot.platform,
          sessionId: snapshot.sessionId,
          reason: "relay-port-unavailable",
          message: "Graceful restart surface relay port is unavailable",
        }),
      );
    }
    const relay = input.relays.get(snapshot.platform);
    if (!relay) {
      return Result.err(
        new SurfaceRecoveryUnavailable({
          requestId: snapshot.requestId,
          platform: snapshot.platform,
          sessionId: snapshot.sessionId,
          reason: "relay-handle-unavailable",
          message: "Graceful restart surface relay handle is unavailable",
        }),
      );
    }
    requireDescriptorPlatform(
      snapshot.platform,
      relay.platform,
      "gracefulRestart.restoreRelayHandle",
    );
    requireSurfaceRelaySnapshot(
      snapshot.platform,
      snapshot,
      "gracefulRestart.prepareRestoreRelays",
    );
  }

  const attempts: SurfaceRelayRestoreAttempt<RegisteredSurfacePlatform>[] = [];
  for (const descriptor of input.registry.entries()) {
    const snapshots = input.snapshot.relays.filter(
      (snapshot) => snapshot.platform === descriptor.platform,
    );
    if (snapshots.length === 0) continue;
    const relay = input.relays.get(descriptor.platform);
    if (!relay) continue;
    const prepared = relay.prepareRestoreRelays(snapshots);
    if (prepared.status === "error") return Result.err(prepared.error);
    attempts.push(prepared.value);
  }
  return Result.ok({ snapshot: input.snapshot, attempts, agentAttempt: agentAttempt.value });
}

export async function applySurfaceRecovery(
  plan: SurfaceRecoveryPlan,
): Promise<ResultType<void, SurfaceRelayRestoreApplyFailed>> {
  const applied: SurfaceRelayRestoreAttempt<RegisteredSurfacePlatform>[] = [];
  const rollbackApplied = async (): Promise<void> => {
    const failures: SurfaceRelayRestoreRollbackFailed[] = [];
    for (const rollback of applied.toReversed()) {
      const rolledBack = await rollback.rollback();
      if (rolledBack.status === "error") failures.push(rolledBack.error);
    }
    plan.agentAttempt.rollback();
    if (failures.length > 0) {
      signalSurfaceRecoveryRollbackAtomicityUnknown(
        "Graceful relay restore rollback left recovery atomicity unknown",
        failures,
      );
    }
  };
  for (const attempt of plan.attempts) {
    applied.push(attempt);
    const result = await attempt.apply();
    if (result.status === "ok") continue;
    await rollbackApplied();
    return Result.err(result.error);
  }
  const agentApplied = plan.agentAttempt.apply();
  if (agentApplied.status === "error") {
    await rollbackApplied();
    return Result.err(
      new SurfaceRelayRestoreApplyFailed({
        platform: plan.snapshot.relays[0]?.platform ?? "discord",
        requestId: agentApplied.error.requestId,
        message: agentApplied.error.message,
      }),
    );
  }
  return Result.ok(undefined);
}

export async function rollbackSurfaceRecovery(plan: SurfaceRecoveryPlan): Promise<void> {
  const failures: SurfaceRelayRestoreRollbackFailed[] = [];
  for (const attempt of plan.attempts.toReversed()) {
    const rolledBack = await attempt.rollback();
    if (rolledBack.status === "error") failures.push(rolledBack.error);
  }
  plan.agentAttempt.rollback();
  if (failures.length > 0) {
    signalSurfaceRecoveryRollbackAtomicityUnknown(
      "Graceful paused recovery rollback left atomicity unknown",
      failures,
    );
  }
}

export function activateSurfaceRecovery(plan: SurfaceRecoveryPlan): void {
  if (activatedRecoveryPlans.has(plan)) return;
  activatedRecoveryPlans.add(plan);
  for (const attempt of plan.attempts) attempt.activate();
  plan.agentAttempt.activate();
}

export async function stopSurfaceAdapterIngress(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly handles: SurfaceAdapterIngressHandles;
  readonly runCleanup: CleanupRunner;
  readonly graceful: boolean;
}): Promise<void> {
  for (const descriptor of reverseEntries(input.registry)) {
    const handle = input.handles.get(descriptor.platform);
    if (!handle) continue;
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "adapter-ingress",
        operation: "stop",
        graceful: input.graceful,
      }),
      () => handle.stop(),
    );
    input.handles.delete(descriptor.platform);
  }
}

export async function stopSurfaceRequestIngress(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly handles: SurfaceRequestIngressHandles;
  readonly runCleanup: CleanupRunner;
  readonly graceful: boolean;
}): Promise<void> {
  for (const descriptor of reverseEntries(input.registry)) {
    const handle = input.handles.get(descriptor.platform);
    if (!handle) continue;
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "request-ingress",
        operation: "stop",
        graceful: input.graceful,
      }),
      () => handle.stop(),
    );
    input.handles.delete(descriptor.platform);
  }
}

export async function stopIngressAndDrainSurfaceRecovery(input: {
  readonly stopAdapterIngress: () => Promise<void>;
  readonly stopRouterIngress: () => Promise<void>;
  readonly stopWorkflowRequestProducers: () => Promise<void>;
  readonly stopRequestIngress: () => Promise<void>;
  readonly stopRemainingRequestProducers: () => Promise<void>;
  readonly registry: SurfaceRuntimeRegistry;
  readonly deadlineMs: number;
  readonly runCleanup: CleanupRunner;
  readonly agentRunner: AgentRecovery;
  readonly relays: SurfaceRelayHandles;
}): Promise<{
  readonly agent: AgentRunnerRecoveryEntry[];
  readonly relays: BusToAdapterRelaySnapshot[];
  readonly queueAttempts: AgentRunnerQueueAttempt[];
}> {
  await input.stopAdapterIngress();
  await input.stopRouterIngress();
  await input.stopWorkflowRequestProducers();
  await input.stopRequestIngress();
  await input.stopRemainingRequestProducers();

  await input.runCleanup("graceful.agentRunner.beginDrain", () =>
    input.agentRunner.beginDrain({ deadlineMs: input.deadlineMs }),
  );
  for (const descriptor of input.registry.entries()) {
    const relay = input.relays.get(descriptor.platform);
    if (!relay) continue;
    requireDescriptorPlatform(
      descriptor.platform,
      relay.platform,
      "gracefulRestart.drainRelayHandle",
    );
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "relay",
        operation: "beginDrain",
        graceful: true,
      }),
      () => relay.beginDrain({ deadlineMs: input.deadlineMs }),
    );
  }

  let agent: AgentRunnerRecoveryEntry[] = [];
  let queueAttempts: AgentRunnerQueueAttempt[] = [];
  await input.runCleanup("graceful.agentRunner.snapshotRecoverables", async () => {
    const capturedAgent = await input.agentRunner.snapshotRecoverables();
    const capturedQueueAttempts = await input.agentRunner.snapshotQueueAttempts();
    agent = capturedAgent;
    queueAttempts = capturedQueueAttempts;
  });
  const relays: BusToAdapterRelaySnapshot[] = [];
  for (const descriptor of input.registry.entries()) {
    const relay = input.relays.get(descriptor.platform);
    if (!relay) continue;
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "relay",
        operation: "snapshotRelays",
        graceful: true,
      }),
      async () => {
        requireDescriptorPlatform(
          descriptor.platform,
          relay.platform,
          "gracefulRestart.snapshotRelayHandle",
        );
        const snapshots = await relay.snapshotRelays();
        for (const snapshot of snapshots) {
          requireSurfaceRelaySnapshot(
            descriptor.platform,
            snapshot,
            "gracefulRestart.snapshotRelays",
          );
          relays.push(snapshot);
        }
      },
    );
  }
  return {
    agent,
    queueAttempts,
    relays,
  };
}

export async function stopSurfaceOutputs(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly requestIngress: SurfaceRequestIngressHandles;
  readonly relays: SurfaceRelayHandles;
  readonly runCleanup: CleanupRunner;
}): Promise<void> {
  for (const descriptor of reverseEntries(input.registry)) {
    const relay = input.relays.get(descriptor.platform);
    if (relay) {
      await input.runCleanup(
        surfaceCleanupLabel({
          platform: descriptor.platform,
          resource: "relay",
          operation: "stop",
        }),
        () => relay.stop(),
      );
      input.relays.delete(descriptor.platform);
    }
    const ingress = input.requestIngress.get(descriptor.platform);
    if (ingress) {
      await input.runCleanup(
        surfaceCleanupLabel({
          platform: descriptor.platform,
          resource: "request-ingress",
          operation: "stop",
        }),
        () => ingress.stop(),
      );
      input.requestIngress.delete(descriptor.platform);
    }
  }
}

export async function disconnectSurfaceAdapters(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly connected: ConnectedSurfaceAdapters;
  readonly runCleanup: CleanupRunner;
}): Promise<void> {
  for (const descriptor of reverseEntries(input.registry)) {
    const adapter = input.connected.get(descriptor.platform);
    if (!adapter) continue;
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "adapter",
        operation: "disconnect",
      }),
      () => adapter.disconnect(),
    );
    input.connected.delete(descriptor.platform);
  }
}
