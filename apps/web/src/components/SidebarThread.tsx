import { useState } from "react";
import { useStore } from "zustand";
import { Archive, ArchiveRestore, Pencil, Trash2, Check, Undo2 } from "lucide-react";
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
  section,
  onSettle,
  settleDisabled,
}: {
  section?: SidebarSection;
  onSettle?: () => void;
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
}) {
  const { drafts } = useWorkspace();
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
        {section === "settled" ? <Undo2 /> : <Check />}
      </IconButton>
    ) : null;
  const actions =
    settleAction || editable ? (
      <>
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
            viewer={viewer}
            modelLabel={modelLabel}
            selected={selected}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        ) : (
          <ThreadCard
            title={title}
            starterName={`${viewer.displayName} · Draft`}
            starterAvatarUrl={viewer.avatarUrl}
            state="idle"
            updatedAt={now}
            now={now}
            selected={selected}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        )}
      </ContextMenuTrigger>
      {editable || settleAction ? (
        <ContextMenuContent>
          {settleAction ? (
            <ContextMenuItem disabled={settleDisabled} onClick={onSettle}>
              {section === "settled" ? <Undo2 /> : <Check />}
              {section === "settled" ? "Unsettle" : "Settle"}
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
