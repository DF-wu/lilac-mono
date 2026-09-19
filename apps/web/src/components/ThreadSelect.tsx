import { useEffect, useState } from "react";
import { Clock3, Cpu, MessageSquare, UserRound, Users } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeThread, NativeUser, Participant } from "@stanley2058/lilac-client-protocol";
import { relativeThreadTime } from "../thread-metadata";
import { attempt } from "./ui";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function ThreadSelect({
  thread,
  viewer,
  client,
  modelLabel,
  now,
  onSelect,
}: {
  thread: NativeThread;
  viewer: NativeUser;
  client: NativeClient;
  modelLabel?: string;
  now: number;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const rpc = client.rpc;
    if (!open || !rpc) return;
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
  const startedByViewer = thread.starterId === viewer.id;
  const starter = startedByViewer
    ? viewer.displayName
    : participants?.find(({ user }) => user.id === thread.starterId)?.user.displayName;
  const settledActivity = thread.archived ? "Archived" : "Idle";
  const activity = thread.activeRunId ? "Working" : settledActivity;
  const exactTime = new Date(thread.updatedAt).toLocaleString();
  const title = thread.title || "Untitled";
  return (
    <Tooltip onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="thread-select thread-select-details h-auto flex-1 min-w-0 shrink justify-start"
            onClick={onSelect}
          />
        }
      >
        <MessageSquare aria-hidden="true" />
        <span className="thread-copy">
          <span className="thread-title">{title}</span>
          <span className="thread-meta">
            <span>{startedByViewer ? "You" : (starter ?? "Shared")}</span>
            {thread.activeRunId ? <span className="thread-working">Working</span> : null}
            {!thread.capabilities.edit ? <span>Read-only</span> : null}
            <time dateTime={new Date(thread.updatedAt).toISOString()} title={exactTime}>
              {relativeThreadTime(thread.updatedAt, now)}
            </time>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="thread-details-tooltip bg-popover text-popover-foreground p-3 [&>[aria-hidden=true]]:hidden"
      >
        <div className="thread-details">
          <strong>{title}</strong>
          <span>
            <UserRound aria-hidden="true" />
            Started by {starter ?? "another participant"}
          </span>
          <span>
            <Clock3 aria-hidden="true" />
            Last active {exactTime}
          </span>
          {modelLabel || thread.modelId ? (
            <span>
              <Cpu aria-hidden="true" />
              {modelLabel ?? thread.modelId}
            </span>
          ) : null}
          <span>
            <MessageSquare aria-hidden="true" />
            {activity}
          </span>
          {participants ? (
            <span>
              <Users aria-hidden="true" />
              Access:{" "}
              {participants
                .slice(0, 6)
                .map(({ user }) => user.displayName)
                .join(", ")}
              {participants.length > 6 ? ` and ${participants.length - 6} more` : ""}
            </span>
          ) : null}
          {error ? <span className="muted">Participants unavailable</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
