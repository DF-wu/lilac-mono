import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";

import type { ThreadMaterializer } from "../../conversation/thread-materializer";
import { classifyConversationThreadMessageUpdate } from "../../conversation/thread-store";
import type { SurfaceAdapter } from "../adapter";
import type { AdapterEvent } from "../events";
import type { DiscordSearchService } from "../store/discord-search-store";

type DiscordSearchIndexerService = Pick<
  DiscordSearchService,
  "onMessageCreated" | "onMessageUpdated" | "onMessageDeleted"
>;

export async function startDiscordSearchIndexer(params: {
  adapter: SurfaceAdapter;
  search: DiscordSearchIndexerService;
  getConfig: () => Promise<CoreConfig>;
  materializer?: Pick<ThreadMaterializer, "markDirty">;
}) {
  const logger = createLogger({
    module: "surface:discord-search-indexer",
  });

  const handleEvent = async (evt: AdapterEvent): Promise<void> => {
    if (evt.platform !== "discord") return;

    switch (evt.type) {
      case "adapter.message.created": {
        await params.search.onMessageCreated(evt.message);
        params.materializer?.markDirty({
          channelId: evt.message.session.channelId,
          kind: "topology",
        });
        return;
      }
      case "adapter.message.updated": {
        const mutation = params.search.onMessageUpdated(evt.message);
        if (!mutation?.changed || !mutation.after) return;

        const kind = classifyConversationThreadMessageUpdate(
          mutation.before,
          mutation.after,
          await params.getConfig(),
        );
        if (kind === "topology") {
          params.materializer?.markDirty({
            channelId: evt.message.session.channelId,
            kind,
          });
        } else if (kind === "content") {
          params.materializer?.markDirty({
            channelId: evt.message.session.channelId,
            messageId: evt.message.ref.messageId,
            kind,
          });
        }
        return;
      }
      case "adapter.message.deleted": {
        params.search.onMessageDeleted({
          platform: evt.platform,
          channelId: evt.session.channelId,
          messageId: evt.messageRef.messageId,
        });
        params.materializer?.markDirty({
          channelId: evt.session.channelId,
          kind: "topology",
        });
        return;
      }
      case "adapter.reaction.added":
      case "adapter.reaction.removed": {
        return;
      }
      case "adapter.request.cancel": {
        return;
      }
      case "adapter.command.invoked": {
        return;
      }
      case "adapter.action.invoked": {
        return;
      }
      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  };

  const inFlight = new Set<Promise<void>>();
  const subscription = await params.adapter.subscribe((evt) => {
    let task: Promise<void>;
    task = handleEvent(evt)
      .catch((e) => {
        logger.error("discord search indexer handler failed", e);
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
    return task;
  });

  return {
    async stop() {
      await subscription.stop();
      await Promise.allSettled(inFlight);
    },
  };
}
