import { createLogger, getCoreConfig } from "@stanley2058/lilac-utils";

import {
  threadMaterializerWorkerRequestSchema,
  type ThreadMaterializerWorkerRequest,
  type ThreadMaterializerWorkerResponse,
} from "./thread-materializer-worker-protocol";
import { ConversationThreadStore } from "./thread-store";

const logger = createLogger({ module: "conversation-thread-materializer-worker-isolate" });
let store: ConversationThreadStore | null = null;
let storeSearchDbPath: string | null = null;
let storeSurfaceDbPath: string | undefined;
let storeBotName: string | undefined;

function respond(response: ThreadMaterializerWorkerResponse): void {
  postMessage(response);
}

function getStore(
  request: ThreadMaterializerWorkerRequest,
  botName?: string,
): ConversationThreadStore {
  const pathChanged =
    storeSearchDbPath !== request.searchDbPath || storeSurfaceDbPath !== request.surfaceDbPath;
  const botNameChanged = botName !== undefined && storeBotName !== botName;
  if (!store || pathChanged || botNameChanged) {
    const replacement = new ConversationThreadStore(request.searchDbPath, {
      surfaceDbPath: request.surfaceDbPath,
      mainAgentUserNames: botName ? [botName] : undefined,
    });
    const previous = store;
    store = replacement;
    storeSearchDbPath = request.searchDbPath;
    storeSurfaceDbPath = request.surfaceDbPath;
    storeBotName = botName;
    previous?.close();
  }
  return store;
}

async function runRequest(request: ThreadMaterializerWorkerRequest): Promise<void> {
  const startedAt = Date.now();
  try {
    if (request.type === "list-channels") {
      const channelIds = getStore(request).listMaterializationChannelIds();
      respond({ id: request.id, ok: true, type: request.type, channelIds: [...channelIds] });
      return;
    }

    const cfg =
      request.kind === "topology" ? await getCoreConfig({ forceReload: true }) : undefined;
    const currentStore = getStore(request, cfg?.surface.discord.botName);
    if (request.kind === "topology") {
      currentStore.refreshInferredChannel({ channelId: request.channelId, cfg });
    } else {
      currentStore.invalidateMaterializedMessages({
        channelId: request.channelId,
        messageIds: request.messageIds ?? [],
      });
    }
    respond({ id: request.id, ok: true, type: request.type });
    logger.debug("conversation thread channel materialized", {
      channelId: request.channelId,
      kind: request.kind,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      "conversation thread channel materialization worker request failed",
      { requestId: request.id, requestType: request.type, durationMs: Date.now() - startedAt },
      error,
    );
    respond({ id: request.id, ok: false, error: message });
  }
}

let requestQueue = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = threadMaterializerWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    respond({ id: "unknown", ok: false, error: "invalid materializer worker request" });
    return;
  }

  const request = parsed.data;
  requestQueue = requestQueue.then(
    () => runRequest(request),
    () => runRequest(request),
  );
});
