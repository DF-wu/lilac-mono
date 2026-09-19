import { useEffect, useState, type ReactNode } from "react";
import {
  Clock3,
  Cpu,
  MessageSquare,
  UserRound,
  Users,
  CircleCheck,
  LoaderCircle,
  CircleAlert,
  MessageCircleQuestion,
  type LucideIcon,
} from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeThread, NativeUser, Participant } from "@stanley2058/lilac-client-protocol";
import { relativeThreadTime } from "../thread-metadata";
import { attempt } from "./ui";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ActorAvatar } from "./ActorAvatar";
import "./thread-card.css";

export type ThreadDisplayState = "idle" | "completed" | "working" | "error" | "input";
const states = {
  idle: { label: "Idle", icon: MessageSquare },
  completed: { label: "Completed, unread", icon: CircleCheck },
  working: { label: "Working", icon: LoaderCircle },
  error: { label: "Run failed", icon: CircleAlert },
  input: { label: "Needs your input", icon: MessageCircleQuestion },
} satisfies Record<ThreadDisplayState, { label: string; icon: LucideIcon }>;

export function ThreadCard({
  title,
  starterName,
  updatedAt,
  now,
  state,
  selected,
  actions,
  onSelect,
}: {
  title: string;
  starterName: string;
  updatedAt: number;
  now: number;
  state: ThreadDisplayState;
  selected?: boolean;
  actions?: ReactNode;
  onSelect: () => void;
}) {
  const StatusIcon = states[state].icon;
  return (
    <div className={`thread-card ${selected ? "selected" : ""}`} data-state={state}>
      <Button
        variant="ghost"
        className="thread-card-select"
        onClick={onSelect}
        aria-label={`${title || "Untitled"}, ${states[state].label}`}
      >
        <span className="thread-state-icon" aria-label={states[state].label}>
          <StatusIcon />
        </span>
        <span className="thread-card-copy">
          <span className="thread-card-top">
            <span className="thread-starter">
              <ActorAvatar displayName={starterName} />
              <span>{starterName}</span>
            </span>
            <time dateTime={new Date(updatedAt).toISOString()}>
              {relativeThreadTime(updatedAt, now)}
            </time>
          </span>
          <span className="thread-card-title">{title || "Untitled"}</span>
        </span>
      </Button>
      {actions ? <span className="thread-card-actions">{actions}</span> : null}
    </div>
  );
}

export function ThreadSelect({
  thread,
  viewer,
  client,
  modelLabel,
  now,
  onSelect,
  actions,
  selected,
  participantNames,
}: {
  participantNames?: string[];
  thread: NativeThread;
  viewer: NativeUser;
  client: NativeClient;
  modelLabel?: string;
  now: number;
  onSelect: () => void;
  actions?: ReactNode;
  selected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const rpc = client.rpc;
    if (!open || !rpc || participantNames || participants) return;
    let canceled = false;
    setError(undefined);
    void attempt(
      () => rpc.participants.list({ threadId: thread.id }),
      (message) => {
        if (!canceled) setError(message);
      },
    ).then((reply) => {
      if (!canceled && reply) setParticipants(reply.items);
    });
    return () => {
      canceled = true;
    };
  }, [open, client, thread.id]);
  const names = participantNames ?? participants?.map(({ user }) => user.displayName);
  const starter =
    thread.starterDisplayName ??
    (thread.starterId === viewer.id ? viewer.displayName : "Participant");
  const state = thread.displayStatus ?? (thread.activeRunId ? "working" : "idle");
  return (
    <Tooltip onOpenChange={setOpen}>
      <TooltipTrigger render={<div className="thread-card-trigger" />}>
        <ThreadCard
          title={thread.title}
          starterName={starter}
          updatedAt={thread.updatedAt}
          now={now}
          state={state}
          selected={selected}
          actions={actions}
          onSelect={onSelect}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="thread-details-tooltip bg-popover text-popover-foreground p-3 [&>[aria-hidden=true]]:hidden"
      >
        <div className="thread-details">
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
          {error ? <span className="muted">Participants unavailable</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
