import { createLogger, formatTaggedErrorForLog, getCoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  decodeThreadMaterializerWorkerRequest,
  type ThreadMaterializerWorkerRequest,
  type ThreadMaterializerWorkerResponse,
} from "./thread-materializer-worker-protocol";
import { ConversationThreadStore } from "./thread-store";

const logger = createLogger({ module: "conversation-thread-materializer-worker-isolate" });

class ThreadMaterializerWorkerRequestFailed extends TaggedError(
  "ThreadMaterializerWorkerRequestFailed",
)<{ readonly message: string }> {}
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

async function executeRequest(request: ThreadMaterializerWorkerRequest): Promise<void> {
  if (request.type === "list-channels") {
    const channelIds = getStore(request).listMaterializationChannelIds();
    respond({ id: request.id, ok: true, type: request.type, channelIds: [...channelIds] });
    return;
  }

  const cfg = request.kind === "topology" ? await getCoreConfig({ forceReload: true }) : undefined;
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
}

async function runRequest(request: ThreadMaterializerWorkerRequest): Promise<void> {
  const startedAt = Date.now();
  const [settled] = await Promise.allSettled([executeRequest(request)]);
  if (settled.status === "fulfilled") {
    if (request.type === "repair-channel") {
      logger.debug("conversation thread channel materialized", {
        channelId: request.channelId,
        kind: request.kind,
        durationMs: Date.now() - startedAt,
      });
    }
    return;
  }
  if (Panic.is(settled.reason)) return adaptToolResultToHost(Result.err(settled.reason));
  if (!(settled.reason instanceof Error)) {
    return adaptToolResultToHost(
      Result.err(
        new Panic({
          message: "Conversation thread materializer worker defect",
          cause: settled.reason,
        }),
      ),
    );
  }
  const failure = new ThreadMaterializerWorkerRequestFailed({
    message: "Conversation thread materializer worker request failed",
  });
  logger.error("conversation thread channel materialization worker request failed", {
    requestId: request.id,
    requestType: request.type,
    durationMs: Date.now() - startedAt,
    ...formatTaggedErrorForLog(failure),
  });
  respond({ id: request.id, ok: false, error: failure.message });
}

let requestQueue = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const decoded = decodeThreadMaterializerWorkerRequest(event.data);
  if (decoded.status === "error") {
    respond({ id: "unknown", ok: false, error: "invalid materializer worker request" });
    return;
  }

  const request = decoded.value;
  requestQueue = requestQueue.then(() => runRequest(request));
});
