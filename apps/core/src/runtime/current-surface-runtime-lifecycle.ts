import type { SurfaceAdapter } from "../surface/adapter";
import type { AgentRunnerRecoveryEntry } from "../surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";

type CurrentSurfaceRelay = {
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRelays(): BusToAdapterRelaySnapshot[];
  restoreRelays(snapshots: readonly BusToAdapterRelaySnapshot[]): Promise<void>;
};

type CurrentAgentRecovery = {
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRecoverables(): AgentRunnerRecoveryEntry[];
  restoreRecoverables(entries: readonly AgentRunnerRecoveryEntry[]): void;
};

type CleanupRunner = (label: string, cleanup: (() => Promise<void>) | undefined) => Promise<void>;

export function createCurrentWorkflowAdapterMap<T>(input: {
  readonly discordAdapter: T;
  readonly githubAdapter: T;
}): Map<"discord" | "github", T> {
  return new Map([
    ["discord", input.discordAdapter],
    ["github", input.githubAdapter],
  ]);
}

export async function connectCurrentSurfaceAdapters(input: {
  readonly discordAdapter: Pick<SurfaceAdapter, "connect">;
  readonly githubAdapter: Pick<SurfaceAdapter, "connect">;
}): Promise<void> {
  await input.discordAdapter.connect();
  await input.githubAdapter.connect();
}

export async function startCurrentSurfaceOutputs(input: {
  readonly startDiscordRelay: () => Promise<void>;
  readonly resolveGithubOperations: () => Promise<{
    readonly startRequestIngress?: () => Promise<void>;
    readonly startRelay?: () => Promise<void>;
  }>;
}): Promise<void> {
  await input.startDiscordRelay();
  const github = await input.resolveGithubOperations();
  await github.startRequestIngress?.();
  await github.startRelay?.();
}

export async function restoreCurrentSurfaceRecovery(input: {
  readonly snapshot: {
    readonly agent: readonly AgentRunnerRecoveryEntry[];
    readonly relays: readonly BusToAdapterRelaySnapshot[];
  };
  readonly discordRelay: Pick<CurrentSurfaceRelay, "restoreRelays"> | null;
  readonly githubRelay: Pick<CurrentSurfaceRelay, "restoreRelays"> | null;
  readonly agentRunner: Pick<CurrentAgentRecovery, "restoreRecoverables"> | null;
}): Promise<void> {
  await input.discordRelay?.restoreRelays(
    input.snapshot.relays.filter((relay) => relay.platform === "discord"),
  );
  await input.githubRelay?.restoreRelays(
    input.snapshot.relays.filter((relay) => relay.platform === "github"),
  );
  input.agentRunner?.restoreRecoverables(input.snapshot.agent);
}

async function drainAndSnapshotCurrentSurfaceRecovery(input: {
  readonly deadlineMs: number;
  readonly runCleanup: CleanupRunner;
  readonly agentRunner: CurrentAgentRecovery;
  readonly discordRelay: CurrentSurfaceRelay | null;
  readonly githubRelay: CurrentSurfaceRelay | null;
}): Promise<{
  readonly agent: AgentRunnerRecoveryEntry[];
  readonly relays: BusToAdapterRelaySnapshot[];
}> {
  await input.runCleanup("graceful.agentRunner.beginDrain", () =>
    input.agentRunner.beginDrain({ deadlineMs: input.deadlineMs }),
  );
  await input.runCleanup(
    "graceful.discordBridge.beginDrain",
    () => input.discordRelay?.beginDrain({ deadlineMs: input.deadlineMs }) ?? Promise.resolve(),
  );
  await input.runCleanup(
    "graceful.githubBridge.beginDrain",
    () => input.githubRelay?.beginDrain({ deadlineMs: input.deadlineMs }) ?? Promise.resolve(),
  );

  return {
    agent: input.agentRunner.snapshotRecoverables(),
    relays: [
      ...(input.discordRelay?.snapshotRelays() ?? []),
      ...(input.githubRelay?.snapshotRelays() ?? []),
    ],
  };
}

export async function stopIngressAndDrainCurrentSurfaceRecovery(input: {
  readonly stopAdapterIngress: () => Promise<void>;
  readonly stopRouterIngress: () => Promise<void>;
  readonly stopWorkflowRequestProducers: () => Promise<void>;
  readonly stopGithubRequestIngress: () => Promise<void>;
  readonly stopRemainingRequestProducers: () => Promise<void>;
  readonly deadlineMs: number;
  readonly runCleanup: CleanupRunner;
  readonly agentRunner: CurrentAgentRecovery;
  readonly discordRelay: CurrentSurfaceRelay | null;
  readonly githubRelay: CurrentSurfaceRelay | null;
}): Promise<{
  readonly agent: AgentRunnerRecoveryEntry[];
  readonly relays: BusToAdapterRelaySnapshot[];
}> {
  await input.stopAdapterIngress();
  await input.stopRouterIngress();
  await input.stopWorkflowRequestProducers();
  await input.stopGithubRequestIngress();
  await input.stopRemainingRequestProducers();
  return await drainAndSnapshotCurrentSurfaceRecovery(input);
}

export async function stopCurrentSurfaceOutputs(input: {
  readonly runCleanup: CleanupRunner;
  readonly discordRelay: { stop(): Promise<void> } | null;
  readonly githubRelay: { stop(): Promise<void> } | null;
  readonly githubRequestIngress: { stop(): Promise<void> } | null;
}): Promise<void> {
  await input.runCleanup(
    "bridgeGithubBusToAdapter.stop",
    () => input.githubRelay?.stop() ?? Promise.resolve(),
  );
  await input.runCleanup(
    "githubWebhook.stop",
    () => input.githubRequestIngress?.stop() ?? Promise.resolve(),
  );
  await input.runCleanup(
    "bridgeBusToAdapter.stop",
    () => input.discordRelay?.stop() ?? Promise.resolve(),
  );
}

export async function disconnectCurrentSurfaceAdapters(input: {
  readonly runCleanup: CleanupRunner;
  readonly discordAdapter: Pick<SurfaceAdapter, "disconnect">;
  readonly githubAdapter: Pick<SurfaceAdapter, "disconnect">;
}): Promise<void> {
  await input.runCleanup("githubAdapter.disconnect", () => input.githubAdapter.disconnect());
  await input.runCleanup("adapter.disconnect", () => input.discordAdapter.disconnect());
}
