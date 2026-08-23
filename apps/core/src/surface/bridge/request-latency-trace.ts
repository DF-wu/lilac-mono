import { parseRequestId } from "./request-ids";

const TRACE_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_TRACES = 2_048;

export type RequestLatencyStage =
  | "adapterEventPublishedAt"
  | "routerReceivedAt"
  | "requestPublishedAt"
  | "runnerReceivedAt"
  | "replyPublishedAt"
  | "relayReceivedAt"
  | "typingRequestedAt";

type RequestLatencyTrace = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly discordReceivedAt: number;
  adapterEventPublishedAt?: number;
  routerReceivedAt?: number;
  requestPublishedAt?: number;
  runnerReceivedAt?: number;
  replyPublishedAt?: number;
  relayReceivedAt?: number;
  typingRequestedAt?: number;
};

export type DiscordMessageToTypingTiming = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly totalMs: number;
  readonly discordIngressMs: number;
  readonly adapterEventBusMs: number;
  readonly routerCompositionMs: number;
  readonly requestBusMs: number;
  readonly runnerAdmissionAndQueueMs: number;
  readonly replyBusMs: number;
  readonly relaySetupMs: number;
  readonly discordTypingApiMs: number;
};

const activeTraces = new Map<string, RequestLatencyTrace>();

function pruneTraces(now: number): void {
  for (const [requestId, trace] of activeTraces) {
    if (now - trace.discordReceivedAt <= TRACE_TTL_MS) continue;
    activeTraces.delete(requestId);
  }

  while (activeTraces.size >= MAX_ACTIVE_TRACES) {
    const oldestRequestId = activeTraces.keys().next().value;
    if (typeof oldestRequestId !== "string") return;
    activeTraces.delete(oldestRequestId);
  }
}

export function beginDiscordMessageLatencyTrace(input: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly receivedAt?: number;
}): void {
  const parsed = parseRequestId(input.requestId);
  if (parsed?.kind !== "discord_message") return;
  if (parsed.channelId !== input.sessionId || parsed.messageId !== input.messageId) return;

  const receivedAt = input.receivedAt ?? Date.now();
  pruneTraces(receivedAt);
  activeTraces.set(input.requestId, {
    requestId: input.requestId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    discordReceivedAt: receivedAt,
  });
}

export function recordRequestLatencyStage(
  requestId: string,
  stage: RequestLatencyStage,
  at: number = Date.now(),
): void {
  const trace = activeTraces.get(requestId);
  if (!trace || trace[stage] !== undefined) return;
  trace[stage] = at;
}

export function finishDiscordMessageLatencyTrace(
  requestId: string,
  typingConfirmedAt: number = Date.now(),
): DiscordMessageToTypingTiming | null {
  const trace = activeTraces.get(requestId);
  activeTraces.delete(requestId);
  if (!trace) return null;

  const {
    adapterEventPublishedAt,
    routerReceivedAt,
    requestPublishedAt,
    runnerReceivedAt,
    replyPublishedAt,
    relayReceivedAt,
    typingRequestedAt,
  } = trace;
  if (
    adapterEventPublishedAt === undefined ||
    routerReceivedAt === undefined ||
    requestPublishedAt === undefined ||
    runnerReceivedAt === undefined ||
    replyPublishedAt === undefined ||
    relayReceivedAt === undefined ||
    typingRequestedAt === undefined
  ) {
    return null;
  }

  return {
    requestId: trace.requestId,
    sessionId: trace.sessionId,
    messageId: trace.messageId,
    totalMs: typingConfirmedAt - trace.discordReceivedAt,
    discordIngressMs: adapterEventPublishedAt - trace.discordReceivedAt,
    adapterEventBusMs: routerReceivedAt - adapterEventPublishedAt,
    routerCompositionMs: requestPublishedAt - routerReceivedAt,
    requestBusMs: runnerReceivedAt - requestPublishedAt,
    runnerAdmissionAndQueueMs: replyPublishedAt - runnerReceivedAt,
    replyBusMs: relayReceivedAt - replyPublishedAt,
    relaySetupMs: typingRequestedAt - relayReceivedAt,
    discordTypingApiMs: typingConfirmedAt - typingRequestedAt,
  };
}
