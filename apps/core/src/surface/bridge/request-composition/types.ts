import type { BlobHandleV1, BlobStore } from "@stanley2058/lilac-blob-storage";
import type { BusMessageV2, CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";

import type { MsgRef } from "../../types";
import type {
  DiscordAttachmentCacheAccess,
  DiscordAttachmentMeta,
} from "../../discord/discord-attachment";

import type { TranscriptStore } from "../../../transcript/transcript-store";

export type RequestCompositionResult = {
  messages: BusMessageV2[];
  inputHandles: readonly BlobHandleV1[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
  corePrimaryLineage: CorePrimaryLineageV2;
};

type BlobCompositionOptions = {
  blobStore?: BlobStore;
  attachmentCache?: DiscordAttachmentCacheAccess;
};

export type ComposeRecentChannelMessagesOpts = BlobCompositionOptions & {
  platform: "discord";
  sessionId: string;
  botUserId: string;
  botName: string;
  botMentionNames?: readonly string[];
  limit: number;
  transcriptStore?: TranscriptStore;
  currentRequestId?: string;
  currentMessageIds?: readonly string[];
  discordUserAliasById?: ReadonlyMap<string, string>;
  /** Optional trigger message to force-include (mention/reply). */
  triggerMsgRef?: MsgRef;
  triggerType?: "mention" | "reply";
  /** Optional transform applied to one selected user message id. */
  transformUserTextForMessageId?: string;
  transformUserText?: (text: string) => string;
};

export type ComposeSingleMessageOpts = BlobCompositionOptions & {
  platform: "discord";
  botUserId: string;
  botName: string;
  msgRef: MsgRef;
  discordUserAliasById?: ReadonlyMap<string, string>;
  transcriptStore?: TranscriptStore;
  currentMessageIds?: readonly string[];
  transformUserText?: (text: string) => string;
};

export type ComposeRequestOpts = BlobCompositionOptions & {
  platform: "discord";
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  currentRequestId?: string;
  currentMessageIds?: readonly string[];
  discordUserAliasById?: ReadonlyMap<string, string>;
  trigger: {
    type: "mention" | "reply";
    msgRef: MsgRef;
  };
  maxDepth?: number;
  /** Optional transform applied to one selected user message id. */
  transformUserTextForMessageId?: string;
  transformUserText?: (text: string) => string;
};

export type ReplyChainMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  text: string;
  attachments: DiscordAttachmentMeta[];
  isChat?: boolean;
  replyReference: {
    messageId?: string;
    channelId?: string;
  };
};

export type MergedChunk = {
  messageIds: string[];
  authorId: string;
  authorName: string;
  tsStart: number;
  tsEnd: number;
  text: string;
  attachments: DiscordAttachmentMeta[];
};
