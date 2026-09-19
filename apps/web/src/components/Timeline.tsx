import {
  memo,
  useContext,
  useId,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, RotateCcw, Copy, Brain, Wrench, Workflow, LoaderCircle } from "lucide-react";
import type { NativeClient, NativeThreadStore } from "@stanley2058/lilac-client";
import type {
  DisplayMessage,
  ReadyTurnSlot,
  DisplayPart,
} from "@stanley2058/lilac-client-protocol";
import { IconButton, attempt } from "./ui";
import { ResourceAttachment } from "./ResourceAttachment";
import { ActorAvatar } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";
import { MessageResourcesContext } from "./message-resources";
import { Bubble, BubbleContent } from "./ui/bubble";
import "./message-presentation.css";
import { Markdown } from "./Markdown";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Message as ChatMessage, MessageContent, MessageAvatar } from "./ui/message";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function useSlot(store: NativeThreadStore, slotId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (slotId ? store.subscribeSlot(slotId, listener) : () => {}),
    [store, slotId],
  );
  const snapshot = useCallback(() => (slotId ? store.get(slotId) : undefined), [store, slotId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function useSlotIds(store: NativeThreadStore) {
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe((change) => {
        if (change.structure) listener();
      }),
    [store],
  );
  const snapshot = useCallback(() => store.slotIds, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type TimelineProps = {
  header?: ReactNode;
  footer?: ReactNode;
  client: NativeClient;
  threadId: string;
  canEdit: boolean;
  resourceUrl: (id: string) => string;
  upload?: (
    resourceId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ) => Promise<void>;
  onRewind: (turnId: string) => void;
  onAction: (
    messageId: string,
    part: Extract<DisplayPart, { type: "data-actions" }>,
    actionId: string,
  ) => void;
  onReaction: (messageId: string, emoji: string, active: boolean) => void;
  positions: Map<string, number>;
  onLatestVisibleChange?: (visible: boolean) => void;
};

export const Timeline = memo(function Timeline(props: TimelineProps) {
  const store = props.client.thread(props.threadId);
  const ids = useSlotIds(store);
  const parent = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const top = headerRef.current?.offsetHeight ?? 0;
      const bottom = footerRef.current?.offsetHeight ?? 0;
      setInsets((current) =>
        current.top === top && current.bottom === bottom ? current : { top, bottom },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (headerRef.current) observer.observe(headerRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, []);
  const atTail = useRef(!props.positions.has(props.threadId));
  const userScroll = useRef(false);
  const touchY = useRef<number | undefined>(undefined);
  const previousCount = useRef(ids.length);
  const pendingAnchor = useRef<{ id: string; delta: number } | undefined>(undefined);
  const getItemKey = useCallback((index: number) => ids[index]!, [ids]);
  const virtual = useVirtualizer({
    count: ids.length,
    scrollMargin: insets.top,
    scrollPaddingStart: insets.top,
    scrollPaddingEnd: insets.bottom,
    getScrollElement: () => parent.current,
    estimateSize: () => 240,
    getItemKey,
    overscan: 3,
  });
  useEffect(
    () =>
      store.subscribe((change) => {
        if (!change.structure || atTail.current || !parent.current) return;
        const offset = parent.current.scrollTop;
        const anchor = virtual
          .getVirtualItems()
          .find(
            (row) =>
              row.end >= offset + insets.top && store.get(ids[row.index] ?? "")?.kind === "ready",
          );
        if (anchor)
          pendingAnchor.current = {
            id: ids[anchor.index]!,
            delta: offset - anchor.start + insets.top,
          };
      }),
    [store, ids, virtual, insets.top],
  );
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    pendingAnchor.current = undefined;
    const index = ids.indexOf(anchor.id);
    if (index < 0) return;
    const offset = virtual.getOffsetForIndex(index, "start");
    if (offset) virtual.scrollToOffset(offset[0] + anchor.delta);
  }, [ids, virtual]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scheduled = 0;
    const observer = new ResizeObserver(() => {
      if (!atTail.current || !ids.length) return;
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (atTail.current) virtual.scrollToIndex(ids.length - 1, { align: "end" });
      });
    });
    observer.observe(canvas);
    if (parent.current) observer.observe(parent.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scheduled);
    };
  }, [ids, virtual]);
  useLayoutEffect(() => {
    const saved = props.positions.get(props.threadId);
    if (saved !== undefined) virtual.scrollToOffset(saved);
    else if (ids.length) virtual.scrollToIndex(ids.length - 1, { align: "end" });
  }, [props.threadId]);
  useLayoutEffect(() => {
    if (ids.length > previousCount.current && atTail.current)
      virtual.scrollToIndex(ids.length - 1, { align: "end" });
    previousCount.current = ids.length;
  }, [ids.length, virtual]);
  const rows = virtual.getVirtualItems();
  useLayoutEffect(() => {
    const viewport = parent.current;
    const latest = rows.find((row) => row.index === ids.length - 1);
    const visible =
      !!viewport &&
      !!latest &&
      latest.end > viewport.scrollTop + insets.top &&
      latest.start < viewport.scrollTop + viewport.clientHeight - insets.bottom;
    props.onLatestVisibleChange?.(visible);
  }, [rows, ids.length, insets, props.onLatestVisibleChange]);
  const rememberScroll = () => {
    const element = parent.current;
    if (!element) return;
    props.positions.set(props.threadId, element.scrollTop);
    if (userScroll.current) {
      atTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      userScroll.current = false;
    }
  };
  return (
    <div
      className="timeline chat-scroll"
      ref={parent}
      onScroll={rememberScroll}
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-slot=collapsible-trigger], .message-expand")
        )
          atTail.current = false;
      }}
      onFocusCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('.message-card-preview[data-collapsed="true"]')
        )
          atTail.current = false;
      }}
      onWheel={(event) => {
        const editor =
          event.target instanceof Element ? event.target.closest(".composer-editor") : null;
        if (
          editor &&
          ((event.deltaY < 0 && editor.scrollTop > 0) ||
            (event.deltaY > 0 && editor.scrollTop + editor.clientHeight < editor.scrollHeight))
        )
          return;
        userScroll.current = true;
        if (event.deltaY < 0) atTail.current = false;
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY;
      }}
      onTouchMove={(event) => {
        userScroll.current = true;
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY.current !== undefined && next > touchY.current)
          atTail.current = false;
        touchY.current = next;
      }}
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest(".chat-sticky-footer")) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
          userScroll.current = true;
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) atTail.current = false;
      }}
      onPointerDown={(event) => {
        if (event.nativeEvent.offsetX >= event.currentTarget.clientWidth) {
          userScroll.current = true;
          atTail.current = false;
        }
      }}
      role="region"
      aria-label="Conversation"
      tabIndex={0}
    >
      {props.header ? (
        <div ref={headerRef} className="chat-sticky-header">
          {props.header}
        </div>
      ) : null}
      <div
        ref={canvasRef}
        className="virtual-canvas timeline-canvas"
        style={{
          height: virtual.getTotalSize(),
          minHeight: `calc(100% - ${insets.top + insets.bottom}px)`,
        }}
      >
        {rows.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtual.measureElement}
            className="virtual-row"
            style={{ transform: `translateY(${row.start - insets.top}px)` }}
          >
            <SlotRow {...props} slotId={ids[row.index]!} store={store} />
          </div>
        ))}
        {ids.length === 0 ? <div className="empty-chat">Start a conversation.</div> : null}
      </div>
      {props.footer ? (
        <div ref={footerRef} className="chat-sticky-footer">
          {props.footer}
        </div>
      ) : null}
    </div>
  );
});

const SlotRow = memo(function SlotRow(
  props: TimelineProps & { store: NativeThreadStore; slotId: string },
) {
  const slot = useSlot(props.store, props.slotId);
  useEffect(() => {
    if (slot?.kind === "deferred") void props.client.hydrate(props.threadId, props.slotId);
  }, [slot?.kind, props.client, props.threadId, props.slotId]);
  if (!slot) return null;
  if (slot.kind !== "ready")
    return (
      <div className="history-placeholder">
        {slot.kind === "failed" ? (
          <>
            <span>{slot.message}</span>
            <Button
              type="button"
              onClick={() => void props.client.hydrate(props.threadId, slot.slotId)}
            >
              Retry history
            </Button>
          </>
        ) : (
          <span>Earlier messages</span>
        )}
      </div>
    );
  return <Turn {...props} slot={slot} />;
});

export const Turn = memo(function Turn(
  props: Omit<TimelineProps, "positions"> & { slot: ReadyTurnSlot },
) {
  const { slot } = props;
  const [expanded, setExpanded] = useState(false);
  const firstUser = slot.messages.find(
    (message) => message.role === "user" && message.metadata?.inputMode !== "steer",
  );
  const settled = slot.state === "complete" || slot.state === "failed" || slot.state === "canceled";
  const finalIds = useMemo(
    () =>
      new Set(
        slot.messages
          .filter((message) => message.metadata?.phase === "final")
          .map((message) => message.id),
      ),
    [slot.messages],
  );
  const intermediate = groupActivityMessages(
    slot.messages.filter((message) => message.id !== firstUser?.id && !finalIds.has(message.id)),
  );
  const finals = slot.messages.filter((message) => finalIds.has(message.id));
  const duration =
    slot.startedAt !== undefined && slot.settledAt !== undefined
      ? Math.max(0, slot.settledAt - slot.startedAt)
      : undefined;
  return (
    <article className="turn" data-turn-id={slot.turnId}>
      {firstUser ? (
        <div className="user-turn">
          <Message
            {...props}
            message={firstUser}
            controls={
              <>
                {firstUser.metadata?.createdAt ? (
                  <time dateTime={new Date(firstUser.metadata.createdAt).toISOString()}>
                    {new Date(firstUser.metadata.createdAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                ) : null}
                {props.canEdit ? (
                  <IconButton
                    label="Rewind to this turn"
                    onClick={() => props.onRewind(slot.turnId)}
                  >
                    <RotateCcw />
                  </IconButton>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
      {settled && intermediate.length ? (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                className="work-summary h-auto justify-start rounded-none px-0 aria-expanded:bg-transparent hover:bg-transparent"
              />
            }
          >
            <Marker render={<span />}>
              <MarkerIcon>
                <ChevronRight className={expanded ? "rotated" : ""} />
              </MarkerIcon>
              <MarkerContent>
                {duration === undefined ? "Work" : `Worked for ${formatDuration(duration)}`}
              </MarkerContent>
              {slot.state !== "complete" ? <span className="badge">{slot.state}</span> : null}
            </Marker>
          </CollapsibleTrigger>
          <CollapsibleContent className="expanded-work">
            {intermediate.map((message) => (
              <Message key={message.id} {...props} message={message} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        intermediate.map((message) => <Message key={message.id} {...props} message={message} />)
      )}
      {finals.map((message) => (
        <Message key={message.id} {...props} message={message} />
      ))}
      {settled && !intermediate.length && slot.state !== "complete" ? (
        <Marker className="turn-status">
          <MarkerContent>{slot.state}</MarkerContent>
        </Marker>
      ) : null}
      {slot.partsCursor ? (
        <Button
          variant="ghost"
          className="text-button"
          type="button"
          onClick={() => void props.client.loadTurnPage(props.threadId, slot.slotId)}
        >
          Load more of this turn
        </Button>
      ) : null}
    </article>
  );
});

export function groupActivityMessages(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const grouped: DisplayMessage[] = [];
  const activityOnly = (message: DisplayMessage) =>
    message.role === "assistant" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "data-activity");
  for (const message of messages) {
    const previous = grouped.at(-1);
    if (previous && activityOnly(previous) && activityOnly(message)) {
      grouped[grouped.length - 1] = { ...previous, parts: [...previous.parts, ...message.parts] };
      continue;
    }
    grouped.push(message);
  }
  return grouped;
}

export function messageText(message: DisplayMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
function formatDuration(duration: number): string {
  const seconds = Math.floor(duration / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
type MessageProps = Pick<
  TimelineProps,
  "canEdit" | "resourceUrl" | "upload" | "onAction" | "onReaction"
> & {
  message: DisplayMessage;
  controls?: ReactNode;
};
type Group =
  | { kind: "text"; text: string }
  | { kind: "activity"; parts: Extract<DisplayPart, { type: "data-activity" }>[] }
  | { kind: "part"; part: Exclude<DisplayPart, { type: "text" | "data-activity" }> };
export function groupParts(parts: readonly DisplayPart[]): Group[] {
  const groups: Group[] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (part.type === "text") {
      if (previous?.kind === "text") previous.text += part.text;
      else groups.push({ kind: "text", text: part.text });
      continue;
    }
    if (part.type === "data-activity") {
      if (previous?.kind === "activity") previous.parts.push(part);
      else groups.push({ kind: "activity", parts: [part] });
      continue;
    }
    groups.push({ kind: "part", part });
  }
  return groups;
}

type MessageCardGroup = {
  kind: "content";
  texts: string[];
  attachments: Extract<DisplayPart, { type: "data-resource" }>[];
};
type CardGroup =
  | MessageCardGroup
  | Extract<Group, { kind: "activity" }>
  | {
      kind: "part";
      part: Exclude<DisplayPart, { type: "text" | "data-activity" | "data-resource" }>;
    };

function groupMessageCards(groups: readonly Group[]): CardGroup[] {
  const cards: CardGroup[] = [];
  let content: MessageCardGroup | undefined;
  for (const group of groups) {
    if (group.kind === "activity") {
      content = undefined;
      cards.push(group);
      continue;
    }
    if (group.kind === "part" && group.part.type !== "data-resource") {
      content = undefined;
      cards.push({ kind: "part", part: group.part });
      continue;
    }
    if (!content) {
      content = { kind: "content", texts: [], attachments: [] };
      cards.push(content);
    }
    if (group.kind === "text") {
      content.texts.push(group.text);
      continue;
    }
    if (group.part.type === "data-resource") content.attachments.push(group.part);
  }
  return cards;
}

function MessageCard({
  content,
  self,
  collapsible,
  resourceUrl,
  canEdit,
  upload,
}: Pick<MessageProps, "resourceUrl" | "canEdit" | "upload"> & {
  content: MessageCardGroup;
  self: boolean;
  collapsible: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!collapsible || !element) return;
    const measure = () =>
      setLong(
        element.getBoundingClientRect().height >
          24 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsible]);
  const collapsed = collapsible && long && !expanded;
  const images = content.attachments.filter((part) => part.data.mediaType.startsWith("image/"));
  const files = content.attachments.filter((part) => !part.data.mediaType.startsWith("image/"));
  return (
    <Bubble variant={self ? "tinted" : "muted"} className="message-bubble">
      <BubbleContent>
        <div
          id={previewId}
          className="message-card-preview"
          data-collapsed={collapsed}
          onFocusCapture={() => {
            if (collapsed) setExpanded(true);
          }}
        >
          <div ref={contentRef} className="message-card-body">
            {images.length > 0 ? (
              <div className="message-attachments message-image-attachments">
                {images.map((part) => (
                  <ResourceAttachment
                    key={part.id}
                    part={part}
                    resourceUrl={resourceUrl}
                    canEdit={canEdit}
                    upload={upload}
                  />
                ))}
              </div>
            ) : null}
            {content.texts.map((text, index) => (
              <Markdown key={index} text={text} />
            ))}
            {files.length > 0 ? (
              <div className="message-attachments">
                {files.map((part) => (
                  <ResourceAttachment
                    key={part.id}
                    part={part}
                    resourceUrl={resourceUrl}
                    canEdit={canEdit}
                    upload={upload}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {collapsible && long ? (
          <Button
            variant="ghost"
            className="message-expand"
            aria-expanded={expanded}
            aria-controls={previewId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        ) : null}
      </BubbleContent>
    </Bubble>
  );
}

export const Message = memo(function Message(props: MessageProps) {
  const { message } = props;
  const [copyError, setCopyError] = useState<string>();
  const groups = useMemo(() => groupParts(message.parts), [message.parts]);
  const cards = useMemo(() => groupMessageCards(groups), [groups]);
  const identities = useContext(MessageIdentityContext);
  const authorId = message.role === "user" ? message.metadata?.authorId : undefined;
  const authorResolved = authorId !== undefined && identities.users.has(authorId);
  const onUnknownAuthor = identities.onUnknownAuthor;
  useEffect(() => {
    if (authorId === undefined || authorResolved) return;
    onUnknownAuthor?.(authorId);
  }, [authorId, authorResolved, onUnknownAuthor]);
  const author =
    message.role === "assistant"
      ? identities.agent
      : (identities.users.get(message.metadata?.authorId ?? "") ?? { displayName: "Participant" });
  const conversational = groups.some(
    (group) =>
      group.kind === "text" || (group.kind === "part" && group.part.type === "data-resource"),
  );
  let authorRole = "Participant";
  if (message.role === "assistant") authorRole = "Agent";
  else if (authorId !== undefined && authorId === identities.viewerId) authorRole = "You";
  const self =
    message.role === "user" && authorId !== undefined && authorId === identities.viewerId;
  const attachments = useMemo(
    () => message.parts.filter((part) => part.type === "data-resource"),
    [message.parts],
  );
  const resources = useMemo(
    () =>
      new Map(
        attachments.map((part) => [
          `/api/resources/${encodeURIComponent(part.data.resourceId)}`,
          { resource: part.data, href: props.resourceUrl(part.data.resourceId) },
        ]),
      ),
    [attachments, props.resourceUrl],
  );
  return (
    <ChatMessage
      align={self ? "end" : "start"}
      className={`message message-${message.role} native-message text-base`}
      data-message-id={message.id}
    >
      {conversational ? (
        <MessageAvatar>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="message-avatar-trigger"
                  aria-label={`About ${author.displayName}`}
                />
              }
            >
              <ActorAvatar {...author} />
            </TooltipTrigger>
            <TooltipContent
              className="message-author-details"
              side={self ? "left" : "right"}
              align="center"
            >
              <span className="message-author-name">{author.displayName}</span>
              <span>{authorRole}</span>
              {message.metadata?.inputMode === "steer" ? <span>Steering</span> : null}
              {message.metadata?.createdAt !== undefined ? (
                <time dateTime={new Date(message.metadata.createdAt).toISOString()}>
                  {new Date(message.metadata.createdAt).toLocaleString()}
                </time>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </MessageAvatar>
      ) : null}
      <MessageResourcesContext value={resources}>
        <MessageContent>
          {cards.map((group, index) => {
            if (group.kind === "content")
              return (
                <MessageCard
                  key={index}
                  content={group}
                  self={self}
                  collapsible={message.role === "user"}
                  resourceUrl={props.resourceUrl}
                  canEdit={props.canEdit}
                  upload={props.upload}
                />
              );
            if (group.kind === "activity")
              return (
                <Activity key={index} parts={group.parts} createdAt={message.metadata?.createdAt} />
              );
            const part = group.part;
            switch (part.type) {
              case "data-compaction":
                return (
                  <Marker variant="separator" className="compaction" key={part.id}>
                    <MarkerContent>
                      Context compaction {part.data.state}
                      {part.data.beforeCount !== undefined && part.data.afterCount !== undefined
                        ? ` · ${part.data.beforeCount} → ${part.data.afterCount}`
                        : ""}
                    </MarkerContent>
                  </Marker>
                );
              case "data-input-state":
                return part.data.state === "admitted" ? null : (
                  <Marker className="input-state" key={part.id}>
                    <MarkerContent>{part.data.reason ?? part.data.state}</MarkerContent>
                  </Marker>
                );
              case "data-actions":
                return (
                  <div className="action-list" key={part.id}>
                    {part.data.actions.map((action) => (
                      <Button
                        key={action.actionId}
                        type="button"
                        disabled={!props.canEdit || action.disabled}
                        variant={action.style === "danger" ? "destructive" : "secondary"}
                        onClick={() => props.onAction(message.id, part, action.actionId)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                );
              case "data-reactions":
                return (
                  <div className="reaction-list" key={part.id}>
                    {part.data.items.map((reaction) => (
                      <Button
                        key={reaction.emoji}
                        type="button"
                        disabled={!props.canEdit}
                        aria-pressed={reaction.reacted}
                        variant="secondary"
                        className="badge"
                        onClick={() =>
                          props.onReaction(message.id, reaction.emoji, !reaction.reacted)
                        }
                      >
                        {reaction.emoji} {reaction.count}
                      </Button>
                    ))}
                  </div>
                );
            }
          })}
        </MessageContent>
      </MessageResourcesContext>
      {conversational ? (
        <div className="message-controls">
          {messageText(message) ? (
            <IconButton
              label="Copy message"
              onClick={() =>
                void attempt(
                  () => navigator.clipboard.writeText(messageText(message)),
                  () => setCopyError("Copy unavailable"),
                )
              }
            >
              <Copy />
            </IconButton>
          ) : null}
          {copyError ? <span role="status">{copyError}</span> : null}
          {props.controls}
        </div>
      ) : null}
    </ChatMessage>
  );
});

type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;

export function activitySummary(parts: readonly ActivityPart[]): string {
  const running = parts.find((part) => part.data.state === "running");
  if (running) return running.data.label;
  if (parts.length === 1) return parts[0]!.data.label;
  const tools = parts.filter((part) => part.data.kind === "tool").length;
  const workflows = parts.filter((part) => part.data.kind === "workflow").length;
  const thinking = parts.some((part) => part.data.kind === "thinking");
  const labels = [];
  if (thinking) labels.push("Thought");
  if (tools)
    labels.push(`${thinking ? "used" : "Used"} ${tools} ${tools === 1 ? "tool" : "tools"}`);
  if (workflows)
    labels.push(
      `${labels.length ? "ran" : "Ran"} ${workflows} ${workflows === 1 ? "workflow" : "workflows"}`,
    );
  return labels.join(" and ");
}

function ActivityIcon({ part }: { part: ActivityPart }) {
  if (part.data.state === "running") return <LoaderCircle className="animate-spin" />;
  if (part.data.kind === "thinking") return <Brain />;
  if (part.data.kind === "workflow") return <Workflow />;
  return <Wrench />;
}

export function Activity({ parts, createdAt }: { parts: ActivityPart[]; createdAt?: number }) {
  const [open, setOpen] = useState(false);
  const representative =
    parts.find((part) => part.data.state === "running") ??
    parts.find((part) => part.data.kind === "tool") ??
    parts[0];
  if (!representative) return null;
  return (
    <Collapsible className="activity-block" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" className="activity-summary h-auto justify-start px-2 py-1" />
        }
      >
        <Marker render={<span />}>
          <MarkerIcon>
            <ActivityIcon part={representative} />
          </MarkerIcon>
          <MarkerContent className="activity-label">{activitySummary(parts)}</MarkerContent>
          {createdAt !== undefined ? (
            <time className="activity-time" dateTime={new Date(createdAt).toISOString()}>
              {new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
          ) : null}
          <ChevronRight className={open ? "rotated" : ""} />
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-details">
        {parts.map((part) => (
          <ActivityItem key={part.id} part={part} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ActivityItem({ part }: { part: ActivityPart }) {
  const [open, setOpen] = useState(false);
  const row = (
    <Marker render={<span />}>
      <MarkerIcon>
        <ActivityIcon part={part} />
      </MarkerIcon>
      <MarkerContent className="activity-label">{part.data.label}</MarkerContent>
      {part.data.state === "failed" ? <span className="activity-state">Failed</span> : null}
      {part.data.durationMs !== undefined ? (
        <span className="activity-time">{formatDuration(part.data.durationMs)}</span>
      ) : null}
      {part.data.detail ? <ChevronRight className={open ? "rotated" : ""} /> : null}
    </Marker>
  );
  if (!part.data.detail) return <div className="activity-item activity-item-trigger">{row}</div>;
  return (
    <Collapsible className="activity-item" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="activity-item-trigger h-auto justify-start px-2 py-1"
          />
        }
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="activity-detail">{part.data.detail}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
