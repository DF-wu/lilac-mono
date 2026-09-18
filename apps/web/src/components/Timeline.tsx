import {
  memo,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, RotateCcw, FileText, ExternalLink, Copy } from "lucide-react";
import type { NativeClient, NativeThreadStore } from "@stanley2058/lilac-client";
import type {
  DisplayMessage,
  ReadyTurnSlot,
  DisplayPart,
} from "@stanley2058/lilac-client-protocol";
import { IconButton, VirtualList, Modal, attempt } from "./ui";
import { UploadProgressContext } from "../upload-context";
import { Markdown } from "./Markdown";

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
};

export const Timeline = memo(function Timeline(props: TimelineProps) {
  const store = props.client.thread(props.threadId);
  const ids = useSlotIds(store);
  const parent = useRef<HTMLDivElement>(null);
  const atTail = useRef(!props.positions.has(props.threadId));
  const userScroll = useRef(false);
  const touchY = useRef<number | undefined>(undefined);
  const previousCount = useRef(ids.length);
  const pendingAnchor = useRef<{ id: string; delta: number } | undefined>(undefined);
  const getItemKey = useCallback((index: number) => ids[index]!, [ids]);
  const virtual = useVirtualizer({
    count: ids.length,
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
          .find((row) => row.end >= offset && store.get(ids[row.index] ?? "")?.kind === "ready");
        if (anchor)
          pendingAnchor.current = { id: ids[anchor.index]!, delta: offset - anchor.start };
      }),
    [store, ids, virtual],
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
    const canvas = parent.current?.firstElementChild;
    if (!canvas) return;
    let scheduled = 0;
    const observer = new ResizeObserver(() => {
      if (!atTail.current || !ids.length) return;
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() =>
        virtual.scrollToIndex(ids.length - 1, { align: "end" }),
      );
    });
    observer.observe(canvas);
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
      className="timeline"
      ref={parent}
      onScroll={rememberScroll}
      onWheel={(event) => {
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
      <div className="virtual-canvas timeline-canvas" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtual.measureElement}
            className="virtual-row"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <SlotRow {...props} slotId={ids[row.index]!} store={store} />
          </div>
        ))}
      </div>
      {ids.length === 0 ? <div className="empty-chat">Start a conversation.</div> : null}
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
            <button
              type="button"
              onClick={() => void props.client.hydrate(props.threadId, slot.slotId)}
            >
              Retry history
            </button>
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
  const [copyError, setCopyError] = useState<string>();
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
          <Message {...props} message={firstUser} />
          <div className="message-controls">
            {firstUser.metadata?.createdAt ? (
              <time dateTime={new Date(firstUser.metadata.createdAt).toISOString()}>
                {new Date(firstUser.metadata.createdAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            ) : null}
            <IconButton
              label="Copy message"
              onClick={() =>
                void attempt(
                  () => navigator.clipboard.writeText(messageText(firstUser)),
                  () => setCopyError("Copy unavailable"),
                )
              }
            >
              <Copy />
            </IconButton>
            {copyError ? <span role="status">{copyError}</span> : null}
            {props.canEdit ? (
              <IconButton label="Rewind to this turn" onClick={() => props.onRewind(slot.turnId)}>
                <RotateCcw />
              </IconButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {settled && intermediate.length ? (
        <>
          <button
            type="button"
            className="work-summary"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight className={expanded ? "rotated" : ""} />
            <span>
              {duration === undefined ? "Work" : `Worked for ${formatDuration(duration)}`}
            </span>
            {slot.state !== "complete" ? <span className="badge">{slot.state}</span> : null}
          </button>
          {expanded ? (
            <VirtualList
              items={intermediate}
              itemKey={(message) => message.id}
              label="Turn activity"
              className="expanded-work"
              estimate={96}
              render={(message) => <Message {...props} message={message} />}
            />
          ) : null}
        </>
      ) : (
        intermediate.map((message) => <Message key={message.id} {...props} message={message} />)
      )}
      {finals.map((message) => (
        <Message key={message.id} {...props} message={message} />
      ))}
      {settled && !intermediate.length && slot.state !== "complete" ? (
        <div className="turn-status">{slot.state}</div>
      ) : null}
      {slot.partsCursor ? (
        <button
          className="text-button"
          type="button"
          onClick={() => void props.client.loadTurnPage(props.threadId, slot.slotId)}
        >
          Load more of this turn
        </button>
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

export const Message = memo(function Message(props: MessageProps) {
  const { message } = props;
  const groups = useMemo(() => groupParts(message.parts), [message.parts]);
  return (
    <div className={`message message-${message.role}`} data-message-id={message.id}>
      {message.role === "user" && message.metadata?.authorId ? (
        <span className="message-author">
          {message.metadata.authorId}
          {message.metadata.inputMode === "steer" ? " · Steering" : ""}
        </span>
      ) : null}
      {groups.map((group, index) => {
        if (group.kind === "text") return <Markdown key={index} text={group.text} />;
        if (group.kind === "activity") return <Activity key={index} parts={group.parts} />;
        const part = group.part;
        switch (part.type) {
          case "data-resource":
            return (
              <Resource
                key={part.id}
                part={part}
                resourceUrl={props.resourceUrl}
                canEdit={props.canEdit}
                upload={props.upload}
              />
            );
          case "data-compaction":
            return (
              <div className="compaction" key={part.id}>
                Context compaction {part.data.state}
                {part.data.beforeCount !== undefined && part.data.afterCount !== undefined
                  ? ` · ${part.data.beforeCount} → ${part.data.afterCount}`
                  : ""}
              </div>
            );
          case "data-input-state":
            return part.data.state === "admitted" ? null : (
              <div className="input-state" key={part.id}>
                {part.data.reason ?? part.data.state}
              </div>
            );
          case "data-actions":
            return (
              <div className="action-list" key={part.id}>
                {part.data.actions.map((action) => (
                  <button
                    key={action.actionId}
                    type="button"
                    disabled={!props.canEdit || action.disabled}
                    className={`button ${action.style === "danger" ? "danger" : ""}`}
                    onClick={() => props.onAction(message.id, part, action.actionId)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            );
          case "data-reactions":
            return (
              <div className="reaction-list" key={part.id}>
                {part.data.items.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    type="button"
                    disabled={!props.canEdit}
                    aria-pressed={reaction.reacted}
                    className="badge"
                    onClick={() => props.onReaction(message.id, reaction.emoji, !reaction.reacted)}
                  >
                    {reaction.emoji} {reaction.count}
                  </button>
                ))}
              </div>
            );
        }
      })}
    </div>
  );
});

function Activity({ parts }: { parts: Extract<DisplayPart, { type: "data-activity" }>[] }) {
  const [open, setOpen] = useState(false);
  const running = parts.some((part) => part.data.state === "running");
  return (
    <div className="activity-block">
      <button
        type="button"
        className="work-summary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight className={open ? "rotated" : ""} />
        <span>
          {running
            ? parts.find((part) => part.data.state === "running")?.data.label
            : `${parts.length} ${parts.length === 1 ? "activity" : "activities"}`}
        </span>
      </button>
      {open ? (
        <VirtualList
          items={parts}
          itemKey={(part) => part.id}
          label="Activity details"
          className="activity-details"
          estimate={72}
          render={(part) => (
            <div className="activity-item">
              <span>{part.data.label}</span>
              <span className="badge">{part.data.state}</span>
              {part.data.detail ? <pre>{part.data.detail}</pre> : null}
            </div>
          )}
        />
      ) : null}
    </div>
  );
}

function Resource({
  part,
  resourceUrl,
  upload,
  canEdit,
}: {
  part: Extract<DisplayPart, { type: "data-resource" }>;
  resourceUrl: (id: string) => string;
  upload?: TimelineProps["upload"];
  canEdit: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const [recovery, setRecovery] = useState<{ progress: number; active: boolean; error?: string }>({
    progress: 0,
    active: false,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const { data } = part;
  const local = useContext(UploadProgressContext).get(data.resourceId);
  if (data.state !== "ready")
    return (
      <div className="resource">
        <FileText />
        <span>{data.name}</span>
        <span>{recovery.error ?? local?.error ?? data.error ?? data.state}</span>
        {canEdit && local?.state === "failed" && local.retry ? (
          <button type="button" className="text-button" onClick={local.retry}>
            Retry upload
          </button>
        ) : null}
        {canEdit && upload && !local && data.state !== "canceled" ? (
          <>
            <input
              type="file"
              ref={fileInput}
              className="sr-only"
              tabIndex={-1}
              aria-label={`Resume upload of ${data.name}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.name !== data.name || file.size !== data.size) {
                  setRecovery({
                    active: false,
                    progress: 0,
                    error: "Choose the original file with the same name and size.",
                  });
                  return;
                }
                setRecovery({ active: true, progress: 0 });
                void attempt(
                  async () => {
                    await upload(data.resourceId, file, (progress) =>
                      setRecovery({ active: true, progress }),
                    );
                    setRecovery({ active: false, progress: 1 });
                  },
                  () =>
                    setRecovery({
                      active: false,
                      progress: 0,
                      error: "Upload failed. Select the file to retry.",
                    }),
                );
              }}
            />
            <button
              type="button"
              className="text-button"
              disabled={recovery.active}
              onClick={() => fileInput.current?.click()}
            >
              Resume upload
            </button>
          </>
        ) : null}
        {data.state === "pending" || recovery.active ? (
          <progress
            value={recovery.active ? recovery.progress : (local?.progress ?? data.progress)}
            max={1}
            aria-label={`Uploading ${data.name}`}
          />
        ) : null}
      </div>
    );
  const href = resourceUrl(data.resourceId);
  return (
    <div className="resource-ready">
      {data.mediaType.startsWith("image/") && !failed ? (
        <a href={href} target="_blank" rel="noreferrer">
          <img src={href} loading="lazy" alt={data.name} onError={() => setFailed(true)} />
        </a>
      ) : null}
      <a className="resource-link" href={href} target="_blank" rel="noreferrer">
        <FileText />
        <span>{data.name}</span>
        <ExternalLink />
      </a>
      {data.mediaType.startsWith("text/") ||
      /\.(md|txt|json|csv|yaml|yml|ts|tsx|js|py|sh|log)$/i.test(data.name) ? (
        <button type="button" className="text-button" onClick={() => setPreview(true)}>
          Preview
        </button>
      ) : null}
      {failed ? <span className="error-text">This file is unavailable.</span> : null}
      {preview ? (
        <FilePreview name={data.name} href={href} onClose={() => setPreview(false)} />
      ) : null}
    </div>
  );
}

function FilePreview({ name, href, onClose }: { name: string; href: string; onClose: () => void }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void attempt(
      async () => {
        const response = await fetch(href, { signal: controller.signal });
        if (!response.ok || !response.body) {
          setError("This file is unavailable.");
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let source = "",
          bytes = 0;
        while (bytes < 65_536) {
          const chunk = await reader.read();
          if (chunk.done) {
            source += decoder.decode();
            setText(source);
            return;
          }
          const remaining = 65_536 - bytes;
          source += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
          bytes += chunk.value.byteLength;
        }
        await reader.cancel();
        if (!controller.signal.aborted) {
          setText(source);
          setTruncated(true);
        }
      },
      () => {
        if (!controller.signal.aborted) setError("This file is unavailable.");
      },
    );
    return () => controller.abort();
  }, [href]);
  return (
    <Modal title={name} onClose={onClose} wide>
      {error ? (
        <p className="error-text">{error}</p>
      ) : (
        <pre className="file-preview">{text ?? "Loading file…"}</pre>
      )}
      {truncated ? (
        <a href={href} target="_blank" rel="noreferrer">
          Open full file
        </a>
      ) : null}
    </Modal>
  );
}
