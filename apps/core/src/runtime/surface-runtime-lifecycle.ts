import type { SurfaceAdapter } from "../surface/adapter";
import type { AgentRunnerRecoveryEntry } from "../surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressPort,
  SurfaceAdapterIngressHandle,
  SurfaceRelayHandle,
  SurfaceRequestIngressHandle,
  SurfaceRuntimeRegistry,
} from "../surface/runtime-descriptor";

type AgentRecovery = {
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRecoverables(): AgentRunnerRecoveryEntry[];
  restoreRecoverables(entries: readonly AgentRunnerRecoveryEntry[]): void;
};

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

function relayDrainLabel(platform: RegisteredSurfacePlatform): string {
  switch (platform) {
    case "discord":
      return "graceful.discordBridge.beginDrain";
    case "github":
      return "graceful.githubBridge.beginDrain";
  }
}

function relayStopLabel(platform: RegisteredSurfacePlatform): string {
  switch (platform) {
    case "discord":
      return "bridgeBusToAdapter.stop";
    case "github":
      return "bridgeGithubBusToAdapter.stop";
  }
}

function requestIngressStopLabel(platform: RegisteredSurfacePlatform, graceful: boolean): string {
  switch (platform) {
    case "discord":
      return graceful
        ? "graceful.ingress.discordRequestIngress.stop"
        : "discordRequestIngress.stop";
    case "github":
      return graceful ? "graceful.ingress.githubWebhook.stop" : "githubWebhook.stop";
  }
}

function adapterDisconnectLabel(platform: RegisteredSurfacePlatform): string {
  switch (platform) {
    case "discord":
      return "adapter.disconnect";
    case "github":
      return "githubAdapter.disconnect";
  }
}

function adapterIngressStopLabel(platform: RegisteredSurfacePlatform, graceful: boolean): string {
  switch (platform) {
    case "discord":
      return graceful ? "graceful.ingress.bridgeAdapterToBus.stop" : "bridgeAdapterToBus.stop";
    case "github":
      return graceful ? "graceful.ingress.githubAdapterToBus.stop" : "githubAdapterToBus.stop";
  }
}

export function createSurfaceWorkflowProgressPortMap(
  registry: SurfaceRuntimeRegistry,
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>();
  for (const descriptor of registry.entries()) {
    if (descriptor.workflowProgress) {
      ports.set(descriptor.platform, descriptor.workflowProgress);
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
      input.relays.set(descriptor.platform, handle);
    }
  }
}

export async function restoreSurfaceRecovery(input: {
  readonly registry: SurfaceRuntimeRegistry;
  readonly snapshot: {
    readonly agent: readonly AgentRunnerRecoveryEntry[];
    readonly relays: readonly BusToAdapterRelaySnapshot[];
  };
  readonly relays: SurfaceRelayHandles;
  readonly agentRunner: Pick<AgentRecovery, "restoreRecoverables"> | null;
}): Promise<void> {
  for (const descriptor of input.registry.entries()) {
    const relay = input.relays.get(descriptor.platform);
    if (!relay) continue;
    await relay.restoreRelays(
      input.snapshot.relays.filter((snapshot) => snapshot.platform === descriptor.platform),
    );
  }
  input.agentRunner?.restoreRecoverables(input.snapshot.agent);
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
    await input.runCleanup(adapterIngressStopLabel(descriptor.platform, input.graceful), () =>
      handle.stop(),
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
    await input.runCleanup(requestIngressStopLabel(descriptor.platform, input.graceful), () =>
      handle.stop(),
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
    await input.runCleanup(relayDrainLabel(descriptor.platform), () =>
      relay.beginDrain({ deadlineMs: input.deadlineMs }),
    );
  }

  const agent = input.agentRunner.snapshotRecoverables();
  const relays: BusToAdapterRelaySnapshot[] = [];
  for (const descriptor of input.registry.entries()) {
    relays.push(...(input.relays.get(descriptor.platform)?.snapshotRelays() ?? []));
  }
  return {
    agent,
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
      await input.runCleanup(relayStopLabel(descriptor.platform), () => relay.stop());
      input.relays.delete(descriptor.platform);
    }
    const ingress = input.requestIngress.get(descriptor.platform);
    if (ingress) {
      await input.runCleanup(requestIngressStopLabel(descriptor.platform, false), () =>
        ingress.stop(),
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
    await input.runCleanup(adapterDisconnectLabel(descriptor.platform), () => adapter.disconnect());
    input.connected.delete(descriptor.platform);
  }
}
