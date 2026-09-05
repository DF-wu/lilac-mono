import type { SurfaceAdapter } from "../surface/adapter";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressRegistration,
  SurfaceAdapterIngressHandle,
  SurfaceRelayHandle,
  SurfaceRequestIngressHandle,
  SurfaceRuntimeRegistry,
} from "../surface/runtime-descriptor";
import { requireDescriptorPlatform } from "../surface/produced-ref-guard";

type AgentDrain = {
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
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

function surfaceCleanupLabel(input: {
  readonly platform: RegisteredSurfacePlatform;
  readonly resource: "adapter" | "adapter-ingress" | "relay" | "request-ingress";
  readonly operation: "beginDrain" | "disconnect" | "stop";
  readonly graceful?: boolean;
}): string {
  return `${input.graceful ? "graceful." : ""}surface.${input.platform}.${input.resource}.${input.operation}`;
}

export function createSurfaceWorkflowProgressPortMap(
  registry: SurfaceRuntimeRegistry,
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration>();
  for (const descriptor of registry.entries()) {
    if (!descriptor.workflowProgress) continue;
    ports.set(descriptor.platform, {
      platform: descriptor.platform,
      protocol: descriptor.protocol,
      port: descriptor.workflowProgress,
    } as RegisteredSurfaceWorkflowProgressRegistration);
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
    if (!descriptor.relay) continue;
    const handle = await descriptor.relay.lifecycle.start();
    requireDescriptorPlatform(descriptor.platform, handle.platform, "surfaceRelay.lifecycle.start");
    input.relays.set(descriptor.platform, handle);
  }
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

export async function stopIngressAndDrainSurfaces(input: {
  readonly stopAdapterIngress: () => Promise<void>;
  readonly stopRouterIngress: () => Promise<void>;
  readonly stopWorkflowRequestProducers: () => Promise<void>;
  readonly stopRequestIngress: () => Promise<void>;
  readonly stopRemainingRequestProducers: () => Promise<void>;
  readonly registry: SurfaceRuntimeRegistry;
  readonly deadlineMs: number;
  readonly now?: () => number;
  readonly runCleanup: CleanupRunner;
  readonly agentRunner: AgentDrain;
  readonly relays: SurfaceRelayHandles;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const drainDeadlineAtMs = now() + input.deadlineMs;
  const remainingDrainMs = (): number => Math.max(0, drainDeadlineAtMs - now());
  await input.stopAdapterIngress();
  await input.stopRouterIngress();
  await input.stopWorkflowRequestProducers();
  await input.stopRequestIngress();
  await input.stopRemainingRequestProducers();

  await input.runCleanup("graceful.agentRunner.beginDrain", () =>
    input.agentRunner.beginDrain({ deadlineMs: remainingDrainMs() }),
  );
  for (const descriptor of input.registry.entries()) {
    const relay = input.relays.get(descriptor.platform);
    if (!relay) continue;
    requireDescriptorPlatform(descriptor.platform, relay.platform, "surfaceRelay.drainHandle");
    await input.runCleanup(
      surfaceCleanupLabel({
        platform: descriptor.platform,
        resource: "relay",
        operation: "beginDrain",
        graceful: true,
      }),
      () => relay.beginDrain({ deadlineMs: remainingDrainMs() }),
    );
  }
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
    if (!ingress) continue;
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
