import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type DisplayMessage,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";

export function sameMessageAuthor(
  left: DisplayMessage | undefined,
  right: DisplayMessage | undefined,
): boolean {
  if (!left || !right || left.role !== right.role) return false;
  if (left.role !== "assistant" && left.role !== "user") return false;
  const leftId = left.metadata?.authorId ?? (left.role === "assistant" ? "lilac" : undefined);
  const rightId = right.metadata?.authorId ?? (right.role === "assistant" ? "lilac" : undefined);
  return (
    leftId !== undefined &&
    leftId === rightId &&
    left.metadata?.authorDisplayName === right.metadata?.authorDisplayName
  );
}

export function lastTurnMessageTime(slot: TurnSlot | undefined): number | undefined {
  if (slot?.kind !== "ready") return undefined;
  return slot.messages.at(-1)?.metadata?.createdAt ?? slot.settledAt ?? slot.startedAt;
}

export function joinMessageTurns(
  left: TurnSlot | undefined,
  right: TurnSlot | undefined,
  contextStart?: number | null,
  gapMs = DEFAULT_DM_TIMESTAMP_GAP_MS,
): boolean {
  if (left?.kind !== "ready" || right?.kind !== "ready") return false;
  if (
    left.state !== "complete" ||
    left.partsCursor ||
    right.partsCursor ||
    right.position === contextStart
  )
    return false;
  if (
    [left, right].some((slot) =>
      slot.messages.some((message) => message.parts.some((part) => part.type === "data-workflow")),
    )
  )
    return false;
  const last = left.messages.at(-1);
  const first = right.messages[0];
  if (!sameMessageAuthor(last, first)) return false;
  const before = lastTurnMessageTime(left);
  const after = first?.metadata?.createdAt ?? right.startedAt;
  if (before === undefined || after === undefined) return false;
  return (
    after >= before &&
    after - before < gapMs &&
    new Date(before).toDateString() === new Date(after).toDateString()
  );
}
