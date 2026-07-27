import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
  type LilacDataForType,
} from "@stanley2058/lilac-event-bus";

export const AGENT_OUTPUT_FLUSH_INTERVAL_MS = 40;
export const AGENT_OUTPUT_FLUSH_BYTES = 4 * 1024;

type TextData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputDeltaText>;
type ReasoningData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputDeltaReasoning>;
type ToolCallData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputToolCall>;
type ResponseTextData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputResponseText>;
type ActivityData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputActivity>;

type PendingOutput =
  | { type: "text"; data: TextData; bytes: number }
  | { type: "reasoning"; data: ReasoningData; bytes: number };

export type AgentOutputFlushScheduler = (callback: () => void, delayMs: number) => () => void;

function defaultScheduleFlush(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createAgentOutputPublisher(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
    workflow_dispatch_epoch?: string;
    router_session_mode?: "mention" | "active";
  };
  scheduleFlush?: AgentOutputFlushScheduler;
  onError?: (label: string, error: unknown) => void;
}) {
  const scheduleFlush = params.scheduleFlush ?? defaultScheduleFlush;
  let pending: PendingOutput | null = null;
  let cancelScheduledFlush: (() => void) | null = null;
  let publicationTail = Promise.resolve();

  const enqueue = (label: string, publish: () => Promise<unknown>): Promise<void> => {
    const publication = publicationTail.then(async () => {
      await publish();
    });
    publicationTail = publication.catch((error: unknown) => {
      params.onError?.(label, error);
    });
    return publication;
  };

  const clearScheduledFlush = (): void => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
  };

  const flushPending = (): void => {
    clearScheduledFlush();
    const output = pending;
    pending = null;
    if (!output) return;

    if (output.type === "text") {
      void enqueue("text delta", async () => {
        await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, output.data, {
          headers: params.headers,
        });
      });
      return;
    }

    void enqueue("reasoning snapshot", async () => {
      await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, output.data, {
        headers: params.headers,
      });
    });
  };

  const schedulePendingFlush = (): void => {
    if (cancelScheduledFlush) return;
    cancelScheduledFlush = scheduleFlush(() => {
      cancelScheduledFlush = null;
      flushPending();
    }, AGENT_OUTPUT_FLUSH_INTERVAL_MS);
  };

  const flushAtSizeLimit = (): void => {
    if (pending && pending.bytes >= AGENT_OUTPUT_FLUSH_BYTES) flushPending();
  };

  const publishText = (delta: string): void => {
    if (pending?.type === "text") {
      pending.data.delta += delta;
      pending.bytes += Buffer.byteLength(delta);
    } else {
      flushPending();
      pending = {
        type: "text",
        data: { delta },
        bytes: Buffer.byteLength(delta),
      };
    }
    schedulePendingFlush();
    flushAtSizeLimit();
  };

  const publishReasoningSnapshot = (data: ReasoningData, newDeltaBytes: number): void => {
    if (pending?.type === "reasoning") {
      pending.data = data;
      pending.bytes += newDeltaBytes;
    } else {
      flushPending();
      pending = {
        type: "reasoning",
        data,
        bytes: newDeltaBytes,
      };
    }
    schedulePendingFlush();
    flushAtSizeLimit();
  };

  const publishReasoningBoundary = (data: ReasoningData): Promise<void> => {
    flushPending();
    return enqueue("reasoning boundary", async () => {
      await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, data, {
        headers: params.headers,
      });
    });
  };

  const publishToolCall = (data: ToolCallData): Promise<void> => {
    flushPending();
    return enqueue("tool status", async () => {
      await params.bus.publish(lilacEventTypes.EvtAgentOutputToolCall, data, {
        headers: params.headers,
      });
    });
  };

  const publishActivity = (data: ActivityData): Promise<void> => {
    flushPending();
    return enqueue("activity", async () => {
      await params.bus.publish(lilacEventTypes.EvtAgentOutputActivity, data, {
        headers: params.headers,
      });
    });
  };

  const publishResponseText = (data: ResponseTextData): Promise<void> => {
    flushPending();
    return enqueue("final response", async () => {
      await params.bus.publish(lilacEventTypes.EvtAgentOutputResponseText, data, {
        headers: params.headers,
      });
    });
  };

  const drain = async (): Promise<void> => {
    flushPending();
    await publicationTail;
  };

  return {
    publishText,
    publishReasoningSnapshot,
    publishReasoningBoundary,
    publishToolCall,
    publishActivity,
    publishResponseText,
    flush: flushPending,
    drain,
  };
}
