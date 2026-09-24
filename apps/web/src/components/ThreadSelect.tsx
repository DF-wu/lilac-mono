import { Kbd } from "./ui/kbd";
import { useThreadShortcut } from "../shortcuts";
import { LoadingSpinner } from "./ui/loading-spinner";
import { useWorkspace } from "../workspace-context";
import { useQuery } from "@tanstack/react-query";
import { participantOptions, useNativeOnline } from "../queries";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  SquarePen,
  Clock3,
  Cpu,
  MessageSquare,
  UserRound,
  Users,
  CircleCheck,
  Pin,
  CircleAlert,
  MessageCircleQuestion,
} from "lucide-react";
import type { NativeThread, NativeUser } from "@stanley2058/lilac-client-protocol";
import { relativeThreadTime } from "../thread-metadata";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ActorAvatar } from "./ActorAvatar";
import "./thread-card.css";

export type ThreadDisplayState = "idle" | "completed" | "working" | "error" | "input";
const states = {
  idle: { label: "Idle", icon: MessageSquare },
  completed: { label: "Completed, unread", icon: CircleCheck },
  working: { label: "Working", icon: LoadingSpinner },
  error: { label: "Run failed", icon: CircleAlert },
  input: { label: "Needs your input", icon: MessageCircleQuestion },
} satisfies Record<ThreadDisplayState, { label: string; icon: ComponentType }>;

export function ThreadCard({
  title,
  shortcutId,
  starterName,
  starterAvatarUrl,
  updatedAt,
  now,
  state,
  selected,
  pinned,
  draft,
  actions,
  onSelect,
}: {
  title: string;
  shortcutId?: string;
  starterName: string;
  starterAvatarUrl?: string;
  updatedAt?: number;
  now?: number;
  state: ThreadDisplayState;
  selected?: boolean;
  pinned?: boolean;
  draft?: "new" | "reply";
  actions?: ReactNode;
  onSelect: () => void;
}) {
  const shortcut = useThreadShortcut(shortcutId);
  const StatusIcon = states[state].icon;
  return (
    <div
      className={`thread-card relative min-w-0 rounded-md ${selected ? "selected" : ""}`}
      data-state={state}
      data-draft={selected ? undefined : draft}
    >
      <Button
        variant="ghost"
        className="thread-card-select absolute inset-0 w-full h-full rounded-[inherit]"
        onClick={onSelect}
        aria-keyshortcuts={shortcut.aria}
        aria-label={`${title || "Untitled"}, ${states[state].label}${draft && !selected ? ", Draft" : ""}`}
      />
      <span className="thread-card-copy relative pointer-events-none flex min-w-0 flex-col gap-0 pt-[calc(var(--ui-space-unit)*1.5)] px-3 pb-3">
        <span className="thread-card-top flex items-center gap-2 h-[var(--ui-control-compact)] text-xs text-muted-foreground">
          <span className="thread-starter flex min-w-0 items-center gap-1">
            {draft && !selected ? (
              <span
                className="thread-draft-icon text-draft flex-none grid place-items-center"
                aria-label="Draft"
              >
                <SquarePen />
              </span>
            ) : null}
            <ActorAvatar displayName={starterName} avatarUrl={starterAvatarUrl} />
            <span>{starterName}</span>
          </span>
          <span className="thread-card-meta ml-auto flex-none flex items-center gap-1">
            <span className="thread-card-status flex items-center gap-1">
              {pinned ? (
                <span className="thread-pin grid place-items-center flex-none" aria-label="Pinned">
                  <Pin />
                </span>
              ) : null}
              {state !== "idle" ? (
                <span
                  className="thread-state-icon w-[var(--ui-text-lg)] h-[var(--ui-text-lg)] flex-none grid place-items-center text-muted-foreground"
                  aria-label={states[state].label}
                >
                  <StatusIcon />
                </span>
              ) : null}
            </span>
            {actions ? (
              <span
                data-ui="thread-card-actions"
                className="thread-card-actions absolute top-[calc(var(--ui-space-unit)*1.5)] right-2 flex items-center opacity-0 pointer-events-none bg-surface-hover rounded-sm"
              >
                {actions}
              </span>
            ) : null}
            {draft !== "new" && updatedAt !== undefined ? (
              <ThreadTime updatedAt={updatedAt} now={now} />
            ) : null}
          </span>
        </span>
        <span className="thread-card-title overflow-hidden text-ellipsis whitespace-nowrap text-sm">
          {title || "Untitled"}
        </span>
      </span>
      {shortcut.held && shortcut.label ? (
        <Kbd
          data-ui="thread-shortcut"
          className="absolute bottom-2 right-2 bg-popover px-2 text-popover-foreground shadow-sm"
        >
          {shortcut.label}
        </Kbd>
      ) : null}
    </div>
  );
}

function ThreadTime({ updatedAt, now }: { updatedAt: number; now?: number }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  return (
    <time dateTime={new Date(updatedAt).toISOString()}>
      {relativeThreadTime(updatedAt, now ?? clock)}
    </time>
  );
}

export function ThreadSelect({
  thread,
  viewer,
  modelLabel,
  now,
  onSelect,
  actions,
  selected,
  pinned,
  draft,
  participantNames,
}: {
  participantNames?: string[];
  thread: NativeThread;
  viewer: NativeUser;
  modelLabel?: string;
  now?: number;
  onSelect: () => void;
  actions?: ReactNode;
  selected?: boolean;
  pinned?: boolean;
  draft?: "new" | "reply";
}) {
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const online = useNativeOnline(client);
  const { data, error } = useQuery({
    ...participantOptions(client, thread.id),
    enabled: online && open && !participantNames,
  });
  const names = participantNames ?? data?.items.map(({ user }) => user.displayName);
  const starter =
    thread.starterId === viewer.id
      ? viewer.displayName
      : (thread.starterDisplayName ?? "Participant");
  const state = thread.displayStatus ?? (thread.activeRunId ? "working" : "idle");
  return (
    <Tooltip onOpenChange={setOpen}>
      <TooltipTrigger render={<div className="thread-card-trigger block min-w-0 w-full" />}>
        <ThreadCard
          shortcutId={thread.id}
          title={thread.title}
          starterName={starter}
          starterAvatarUrl={
            thread.starterId === viewer.id ? viewer.avatarUrl : thread.starterAvatarUrl
          }
          updatedAt={thread.updatedAt}
          now={now}
          state={state}
          selected={selected}
          pinned={pinned}
          draft={draft}
          actions={actions}
          onSelect={onSelect}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="thread-details-tooltip shadow-overlay bg-popover text-popover-foreground p-3 [&>[aria-hidden=true]]:hidden"
      >
        <div className="thread-details flex flex-col gap-2 text-sm wrap-anywhere">
          <strong>{thread.title || "Untitled"}</strong>
          <span>
            <UserRound />
            Started by {starter}
          </span>
          <span>
            <Clock3 />
            Last active {new Date(thread.updatedAt).toLocaleString()}
          </span>
          {modelLabel || thread.modelId ? (
            <span>
              <Cpu />
              {modelLabel ?? thread.modelId}
            </span>
          ) : null}
          {draft && !selected ? (
            <span>
              <SquarePen />
              Unsent draft
            </span>
          ) : null}
          <span>
            <MessageSquare />
            {thread.archived ? "Archived" : states[state].label}
            {!thread.capabilities.edit ? " · Read-only" : ""}
          </span>
          {names ? (
            <span>
              <Users />
              {names.slice(0, 6).join(", ")}
              {names.length > 6 ? ` and ${names.length - 6} more` : ""}
            </span>
          ) : null}
          {error ? (
            <span className="muted text-muted-foreground">Participants unavailable</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
