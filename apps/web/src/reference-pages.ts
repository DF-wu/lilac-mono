import type { InfiniteData } from "@tanstack/react-query";
import { updateDisplayMessage } from "@stanley2058/lilac-client";
import type {
  DisplayMessage,
  LiveUpdate,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";

export type ReferencePage = NativeRpcOutputs["references"]["read"];
export type ReferenceCursor = { cursor: string; direction: "before" | "after" } | undefined;
export type ReferencePages = InfiniteData<ReferencePage, ReferenceCursor>;
export const olderReferencePage = (page: ReferencePage): ReferenceCursor =>
  page.nextCursor ? { cursor: page.nextCursor, direction: "before" } : undefined;
export const newerReferencePage = (page: ReferencePage): ReferenceCursor =>
  page.nextAfter ? { cursor: page.nextAfter, direction: "after" } : undefined;

function positioned(message: DisplayMessage, position: number): DisplayMessage {
  return { ...message, metadata: { ...message.metadata, position } };
}

function changePage(
  page: ReferencePage,
  changes: LiveUpdate["changes"],
): ReferencePage | undefined {
  let messages = page.messages;
  for (const change of changes) {
    if (change.kind === "turn-state") continue;
    if (change.kind === "remove") {
      messages = messages.filter((message) => message.metadata?.position !== change.position);
      continue;
    }
    if (change.kind === "remove-message") {
      messages = messages.filter((message) => message.id !== change.messageId);
      continue;
    }
    if (change.kind === "insert") {
      if (!page.nextAfter)
        messages = [
          ...messages,
          ...change.slot.messages.map((message) => positioned(message, change.slot.position)),
        ];
      continue;
    }
    if (change.kind === "append-message") {
      if (messages.some((message) => message.id === change.message.id)) continue;
      const before = messages.findIndex((message) => message.id === change.beforeMessageId);
      if (before >= 0) {
        messages = messages.toSpliced(before, 0, positioned(change.message, change.position));
        continue;
      }
      const firstPosition = messages[0]?.metadata?.position ?? change.position;
      if (!page.nextAfter && !change.beforeMessageId && change.position >= firstPosition) {
        const nextTurn = messages.findIndex(
          (message) => (message.metadata?.position ?? 0) > change.position,
        );
        const index = nextTurn < 0 ? messages.length : nextTurn;
        messages = messages.toSpliced(index, 0, positioned(change.message, change.position));
      }
      continue;
    }
    const index = messages.findIndex((message) => message.id === change.messageId);
    if (index < 0) continue;
    const updated = updateDisplayMessage(messages[index]!, change);
    if (!updated) return;
    messages = messages.with(index, updated);
  }
  return { ...page, messages };
}

export function updateReferencePages(
  data: ReferencePages,
  update: LiveUpdate,
  fromRevision: number,
): ReferencePages | undefined {
  const pages: ReferencePage[] = [];
  for (const page of data.pages) {
    const checkpoint = page.checkpoint;
    if (!checkpoint || checkpoint.historyGeneration !== update.checkpoint.historyGeneration) return;
    if (checkpoint.projectionRevision >= update.checkpoint.projectionRevision) {
      pages.push(page);
      continue;
    }
    if (checkpoint.projectionRevision !== fromRevision) return;
    const next = changePage(page, update.changes);
    if (!next) return;
    pages.push({ ...next, checkpoint: update.checkpoint });
  }
  return { ...data, pages };
}
