import { useState } from "react";
import { useStore } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { composerDraftOptions } from "../queries";
import type { Draft } from "./Chat";
import {
  X,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  CircleCheck,
  Undo2,
  Pin,
  PinOff,
} from "lucide-react";
import type { NativeThread, NativeUser, SidebarSection } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { IconButton } from "./ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { ThreadCard, ThreadSelect } from "./ThreadSelect";

function hasUnsentDraft(draft: Draft) {
  return !!(
    draft.text.trim() ||
    draft.attachments.length ||
    draft.skillIds.length ||
    draft.commandId
  );
}

export function SidebarThread({
  id,
  thread,
  viewer,
  modelLabel,
  selected,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onDiscardDraft,
  section,
  onSettle,
  onPin,
  settleDisabled,
}: {
  section?: SidebarSection;
  onSettle?: () => void;
  onPin?: () => void;
  settleDisabled?: boolean;
  id: string;
  thread?: NativeThread;
  viewer: NativeUser;
  modelLabel?: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onDiscardDraft: (id: string) => void;
}) {
  const { drafts, scope, draftCache } = useWorkspace();
  const { data: hasReplyDraft } = useQuery({
    ...composerDraftOptions(scope, id, draftCache),
    enabled: !!thread,
    select: hasUnsentDraft,
  });
  const draft = useStore(drafts, (state) =>
    thread ? undefined : state.summaries.find((item) => item.id === id),
  );
  const title = thread?.title ?? draft?.title ?? "";
  const editable = thread?.capabilities.edit ?? draft?.editable ?? false;
  const settleAction =
    thread && !thread.archived && onSettle ? (
      <IconButton
        label={`${section === "settled" ? "Unsettle" : "Settle"} ${title || "conversation"}`}
        tooltip={section === "settled" ? "Unsettle" : "Settle"}
        onClick={onSettle}
        disabled={settleDisabled}
      >
        {section === "settled" ? <Undo2 /> : <CircleCheck />}
      </IconButton>
    ) : null;
  const showDiscard = !selected && (thread ? hasReplyDraft : !!draft);
  const actions =
    showDiscard || settleAction || editable ? (
      <>
        {showDiscard ? (
          <IconButton
            label={`Discard draft for ${title || "conversation"}`}
            tooltip="Discard draft"
            disabled={!thread && !draft?.editable}
            onClick={() => onDiscardDraft(id)}
          >
            <X />
          </IconButton>
        ) : null}
        {settleAction}
        {editable ? (
          <IconButton
            label={`Rename ${title || "conversation"}`}
            tooltip="Rename"
            onClick={() => onRename(id, title)}
          >
            <Pencil />
          </IconButton>
        ) : null}
      </>
    ) : undefined;
  const [now] = useState(Date.now);
  return (
    <ContextMenu>
      <ContextMenuTrigger className="thread-row-card">
        {thread ? (
          <ThreadSelect
            thread={thread}
            draft={hasReplyDraft ? "reply" : undefined}
            viewer={viewer}
            modelLabel={modelLabel}
            selected={selected}
            pinned={section === "pinned"}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        ) : (
          <ThreadCard
            title={title}
            starterName={viewer.displayName}
            draft="new"
            starterAvatarUrl={viewer.avatarUrl}
            state="idle"
            updatedAt={now}
            now={now}
            selected={selected}
            pinned={section === "pinned"}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        )}
      </ContextMenuTrigger>
      {editable || settleAction ? (
        <ContextMenuContent>
          {settleAction ? (
            <ContextMenuItem disabled={settleDisabled} onClick={onSettle}>
              {section === "settled" ? <Undo2 /> : <CircleCheck />}
              {section === "settled" ? "Unsettle" : "Settle"}
            </ContextMenuItem>
          ) : null}
          {thread && !thread.archived && onPin ? (
            <ContextMenuItem disabled={settleDisabled} onClick={onPin}>
              {section === "pinned" ? <PinOff /> : <Pin />}
              {section === "pinned" ? "Unpin" : "Pin"}
            </ContextMenuItem>
          ) : null}
          {editable ? (
            <>
              <ContextMenuItem onClick={() => onRename(id, title)}>
                <Pencil />
                Rename
              </ContextMenuItem>
              {thread ? (
                <ContextMenuItem onClick={() => onArchive(id, !thread.archived)}>
                  {thread.archived ? <ArchiveRestore /> : <Archive />}
                  {thread.archived ? "Unarchive" : "Archive"}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem variant="destructive" onClick={() => onDelete(id)}>
                <Trash2 />
                Delete
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
