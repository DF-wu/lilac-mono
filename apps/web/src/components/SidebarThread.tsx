import { useState } from "react";
import { useStore } from "zustand";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import type { NativeThread, NativeUser } from "@stanley2058/lilac-client-protocol";
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
}: {
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
  const actions = editable ? (
    <>
      <IconButton
        label={`Rename ${title || "conversation"}`}
        tooltip="Rename"
        onClick={() => onRename(id, title)}
      >
        <Pencil />
      </IconButton>
      {thread ? (
        <IconButton
          label={`${thread.archived ? "Unarchive" : "Archive"} ${title || "conversation"}`}
          tooltip={thread.archived ? "Unarchive" : "Archive"}
          onClick={() => onArchive(id, !thread.archived)}
        >
          {thread.archived ? <ArchiveRestore /> : <Archive />}
        </IconButton>
      ) : null}
      <IconButton
        className="destructive-action"
        label={`Delete ${title || "conversation"}`}
        tooltip="Delete"
        onClick={() => onDelete(id)}
      >
        <Trash2 />
      </IconButton>
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
            state="idle"
            updatedAt={now}
            now={now}
            selected={selected}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        )}
      </ContextMenuTrigger>
      {editable ? (
        <ContextMenuContent>
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
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
