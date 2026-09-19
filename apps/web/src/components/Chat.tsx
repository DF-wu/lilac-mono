import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { X, RotateCcw } from "lucide-react";
import type { NativeInput, DisplayPart } from "@stanley2058/lilac-client-protocol";
import type { AppProps, ChatCommon, ComposerSubmission, QueueEntry } from "../types";
import { resolveAttachmentIds } from "../uploads";
import { inputDeliveryOptions } from "../input-mode";
import type { UploadPool } from "../uploads";
import { Button } from "./ui/button";
import { Composer } from "./Composer";
import { Timeline, useSlot, useSlotIds } from "./Timeline";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./ui";

import { UploadProgressContext } from "../upload-context";
const queueLabels = { prompt: "Prompt", steer: "Steering", followup: "Follow-up" };
export type Draft = {
  text: string;
  skillIds: string[];
  commandId?: string;
  attachments: string[];
  savedText?: string;
};
export type PendingInput = {
  commandId: string;
  text: string;
  submission: ComposerSubmission;
  input?: NativeInput;
  error?: string;
  state: "preparing" | "uncertain" | "rejected";
};
export type ChatProps = ChatCommon & {
  header: ReactNode;
  draft: Draft;
  draftCache?: AppProps["draftCache"];
  onDraft: (draft: Draft) => void;
  pool: UploadPool;
  positions: Map<string, number>;
  readTurns: Map<string, string>;
  pending: PendingInput[];
  onPending: (update: (pending: PendingInput[]) => PendingInput[]) => void;
};

export function Chat(props: ChatProps) {
  const { client, thread, pool } = props;
  const [draft, setDraft] = useState(props.draft);
  const draftVersion = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [pendingEntries, setPendingEntries] = useState(props.pending);
  useEffect(() => {
    pendingRef.current = props.pending;
    setPendingEntries(props.pending);
  }, [props.pending]);
  const pendingRef = useRef(pendingEntries);
  pendingRef.current = pendingEntries;
  const commitDraft = (value: Draft) => {
    draftVersion.current++;
    draftRef.current = value;
    setDraft(value);
    props.onDraft(value);
    if (props.draftCache)
      void attempt(
        () =>
          props.draftCache!.saveDraft(props.scope, thread.id, {
            text: value.text,
            skillIds: value.skillIds,
            commandId: value.commandId,
            savedText: value.savedText,
          }),
        setError,
      );
  };
  useEffect(() => {
    const cache = props.draftCache;
    if (
      !cache ||
      draftRef.current.text ||
      draftRef.current.skillIds.length ||
      draftRef.current.attachments.length
    )
      return;
    let canceled = false;
    const revision = draftVersion.current;
    void attempt(() => cache.readDraft(props.scope, thread.id), setError).then((restored) => {
      if (!restored || canceled || draftVersion.current !== revision) return;
      const value = { ...restored, attachments: [] };
      draftRef.current = value;
      setDraft(value);
      props.onDraft(value);
    });
    return () => {
      canceled = true;
    };
  }, [props.draftCache, props.scope, thread.id]);
  const commitPending = (update: (entries: PendingInput[]) => PendingInput[]) => {
    const value = update(pendingRef.current);
    pendingRef.current = value;
    setPendingEntries(value);
    props.onPending(() => value);
  };
  const store = client.thread(thread.id);
  const ids = useSlotIds(store);
  const last = useSlot(store, ids.at(-1));
  const active = !!thread.activeRunId;
  const previousActive = useRef(active);
  const [latestVisible, setLatestVisible] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const queueRequest = useRef(0);
  const canEdit = useRef(thread.capabilities.edit);
  canEdit.current = thread.capabilities.edit;
  const [error, setError] = useState<string>();
  const [rewindTarget, setRewindTarget] = useState<string>();
  const [rewinding, setRewinding] = useState(false);
  useEffect(() => {
    if (!thread.capabilities.edit) setRewindTarget(undefined);
  }, [thread.capabilities.edit]);
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribe(thread.id, listener),
    [pool, thread.id],
  );
  const snapshot = useCallback(() => pool.get(thread.id), [pool, thread.id]);
  const uploads = useSyncExternalStore(subscribe, snapshot, snapshot);
  const uploadProgress = useMemo(
    () =>
      new Map(
        uploads
          .filter((item) => item.resourceId)
          .map((item) => [
            item.resourceId!,
            {
              progress: item.progress,
              state: item.state,
              error: item.error,
              retry: () => pool.retry(thread.id, item.key),
            },
          ]),
      ),
    [uploads, pool, thread.id],
  );
  const recoveryUpload = useCallback(
    (resourceId: string, file: File, onProgress: (fraction: number) => void) =>
      props.upload(resourceId, file, onProgress, pool.signal),
    [props.upload, pool],
  );
  const attachments = uploads.filter((attachment) => draft.attachments.includes(attachment.key));
  const refreshQueue = useCallback(async () => {
    const request = ++queueRequest.current;
    const rpc = client.rpc;
    if (!rpc || !canEdit.current) {
      setQueue([]);
      return;
    }
    const result = await attempt(
      () => rpc.runs.queue({ threadId: thread.id }),
      (message) => {
        if (request === queueRequest.current && canEdit.current) setError(message);
      },
    );
    if (result && request === queueRequest.current && canEdit.current) setQueue(result.items);
  }, [client, thread.id, thread.capabilities.edit]);
  useEffect(() => {
    void refreshQueue();
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === "input" && event.threadId === thread.id) void refreshQueue();
    });
    return () => {
      queueRequest.current++;
      unsubscribe();
    };
  }, [client, thread.id, refreshQueue]);
  useEffect(() => {
    const changed = previousActive.current !== active;
    previousActive.current = active;
    if (changed) void refreshQueue();
  }, [active, refreshQueue]);
  useEffect(() => {
    if (
      last?.kind !== "ready" ||
      !latestVisible ||
      active ||
      last.state === "pending" ||
      last.state === "running"
    )
      return;
    const turnId = last.turnId;
    let pending = false;
    function markVisibleTurnRead() {
      const rpc = client.rpc;
      if (
        document.visibilityState !== "visible" ||
        !rpc ||
        pending ||
        props.readTurns.get(thread.id) === turnId
      )
        return;
      pending = true;
      void attempt(() => rpc.threads.markRead({ threadId: thread.id, turnId }), setError).then(
        (result) => {
          pending = false;
          if (result) props.readTurns.set(thread.id, turnId);
        },
      );
    }
    markVisibleTurnRead();
    document.addEventListener("visibilitychange", markVisibleTurnRead);
    return () => document.removeEventListener("visibilitychange", markVisibleTurnRead);
  }, [
    client,
    thread.id,
    active,
    latestVisible,
    last?.kind === "ready" ? last.turnId : undefined,
    last?.kind === "ready" ? last.state : undefined,
    props.readTurns,
  ]);

  const setPending = (commandId: string, patch: Partial<PendingInput> | null) => {
    commitPending((entries) =>
      patch
        ? entries.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry))
        : entries.filter((entry) => entry.commandId !== commandId),
    );
  };
  async function deliver(entry: PendingInput, retryFailed = false) {
    if (!canEdit.current) return;
    const [ids, { resolveComposerAttachments }] = await Promise.all([
      resolveAttachmentIds(pool, thread.id, entry.submission.attachments, retryFailed),
      import("./composer-editor"),
    ]);
    if (!canEdit.current) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "You no longer have permission to send to this conversation.",
      });
      return;
    }
    if (ids.some((id) => !id)) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "A file could not be prepared. Retry this message to retry its upload.",
      });
      return;
    }
    const checkpoint = store.checkpoint;
    if (!checkpoint) {
      setPending(entry.commandId, {
        state: "rejected",
        error: "Connect to this thread before sending",
      });
      return;
    }
    const input: NativeInput = entry.input ?? {
      threadId: thread.id,
      commandId: entry.commandId,
      historyGeneration: checkpoint.historyGeneration,
      text: entry.submission.attachmentText
        ? resolveComposerAttachments(
            entry.submission.attachmentText,
            new Map(
              entry.submission.attachments.map((attachment, index) => [
                attachment.key,
                ids[index]!,
              ]),
            ),
          )
        : entry.text,
      ...inputDeliveryOptions(
        active,
        entry.submission.mode,
        entry.submission.modelId,
        !!entry.submission.command,
      ),
      attachmentIds: ids.filter((id): id is string => !!id),
      skillIds: entry.submission.skillIds,
      command: entry.submission.command,
    };
    setPending(entry.commandId, { input });
    const outcome = await client.submit(input);
    if (outcome.kind === "accepted") {
      for (const attachment of entry.submission.attachments)
        pool.release(thread.id, attachment.key);
      setPending(entry.commandId, null);
      void refreshQueue();
      return;
    }
    setPending(
      entry.commandId,
      outcome.kind === "uncertain"
        ? { state: "uncertain", error: "Send not confirmed. Retry safely when connected." }
        : { state: "rejected", error: outcome.error.message },
    );
  }
  function submit(submission: ComposerSubmission) {
    const entry: PendingInput = {
      commandId: crypto.randomUUID(),
      text: submission.text,
      submission,
      state: "preparing",
    };
    commitPending((entries) => [...entries, entry]);
    commitDraft({ text: "", skillIds: [], attachments: [], savedText: draft.savedText });
    void deliver(entry);
  }
  async function cancel() {
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (!rpc || !checkpoint) return;
    await attempt(
      () =>
        rpc.runs.cancel({
          threadId: thread.id,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
          runId: thread.activeRunId,
        }),
      setError,
    );
    void refreshQueue();
  }
  async function rewind() {
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (!canEdit.current || !rpc || !checkpoint || !rewindTarget || rewinding) return;
    setRewinding(true);
    const reply = await attempt(
      () =>
        rpc.threads.rewind({
          threadId: thread.id,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
          expectedRevision: checkpoint.projectionRevision,
          turnId: rewindTarget,
        }),
      setError,
    );
    setRewinding(false);
    if (!reply || !canEdit.current) return;
    const current = draftRef.current;
    commitDraft({
      text: reply.text,
      skillIds: [],
      attachments: [],
      savedText: current.text || current.savedText,
    });
    setRewindTarget(undefined);
    void refreshQueue();
  }
  const onAction = useCallback(
    (messageId: string, part: Extract<DisplayPart, { type: "data-actions" }>, actionId: string) => {
      if (!client.rpc) return;
      void attempt(
        () =>
          client.rpc!.actions.invoke({
            threadId: thread.id,
            messageId,
            actionId,
            requestId: part.data.requestId,
            revision: part.data.revision,
            commandId: crypto.randomUUID(),
          }),
        setError,
      );
    },
    [client, thread.id],
  );
  const onReaction = useCallback(
    (messageId: string, emoji: string, enabled: boolean) => {
      if (!client.rpc) return;
      void attempt(
        () => client.rpc!.reactions.set({ threadId: thread.id, messageId, emoji, active: enabled }),
        setError,
      );
    },
    [client, thread.id],
  );
  const composer = (
    <div className="chat-bottom">
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      {pendingEntries.length ? (
        <VirtualList
          className="pending-inputs"
          items={pendingEntries}
          itemKey={(entry) => entry.commandId}
          label="Pending messages"
          estimate={88}
          render={(entry) => (
            <div className="pending-input" key={entry.commandId}>
              <span>{entry.text}</span>
              <small>{entry.error ?? "Sending…"}</small>
              {thread.capabilities.edit && entry.state !== "preparing" ? (
                <Button
                  type="button"
                  onClick={() =>
                    void deliver(
                      {
                        ...entry,
                        submission: {
                          ...entry.submission,
                          attachments: entry.submission.attachments.map(
                            (attachment) =>
                              uploads.find((candidate) => candidate.key === attachment.key) ??
                              attachment,
                          ),
                        },
                      },
                      true,
                    )
                  }
                >
                  Retry message
                </Button>
              ) : null}
            </div>
          )}
        />
      ) : null}
      {thread.capabilities.edit && queue.length ? (
        <div className="queue">
          <VirtualList
            items={queue}
            itemKey={(entry) => entry.inputId}
            label="Queued messages"
            estimate={48}
            render={(entry) => (
              <div className="queue-entry">
                <span className="badge">{queueLabels[entry.mode]}</span>
                <span>{entry.text}</span>
                <IconButton
                  label="Remove queued message"
                  onClick={() => {
                    const checkpoint = store.checkpoint;
                    if (!client.rpc || !checkpoint) return;
                    void attempt(
                      () =>
                        client.rpc!.runs.removeQueued({
                          threadId: thread.id,
                          commandId: crypto.randomUUID(),
                          historyGeneration: checkpoint.historyGeneration,
                          inputId: entry.inputId,
                        }),
                      setError,
                    ).then(refreshQueue);
                  }}
                >
                  <X />
                </IconButton>
              </div>
            )}
          />
        </div>
      ) : null}
      {draft.savedText ? (
        <Button
          type="button"
          variant="ghost"
          className="text-button"
          onClick={() =>
            commitDraft({
              ...draft,
              text: draft.savedText ?? "",
              savedText: draft.text || undefined,
            })
          }
        >
          Restore previous draft
        </Button>
      ) : null}
      {thread.capabilities.edit ? (
        <Composer
          windowDrop
          client={client}
          scope={props.scope}
          catalog={props.catalog}
          text={draft.text}
          skillIds={draft.skillIds}
          onSkills={(skillIds) => commitDraft({ ...draftRef.current, skillIds })}
          commandId={draft.commandId}
          onCommand={(commandId) => commitDraft({ ...draftRef.current, commandId })}
          onText={(text) => commitDraft({ ...draftRef.current, text })}
          attachments={attachments}
          onAttach={(files) =>
            commitDraft({
              ...draft,
              attachments: [
                ...draft.attachments,
                ...files
                  .slice(0, 32 - draft.attachments.length)
                  .map((file) => pool.add(thread.id, file)),
              ],
            })
          }
          onRemoveAttachment={(key) => {
            pool.remove(thread.id, key);
            commitDraft({ ...draft, attachments: draft.attachments.filter((id) => id !== key) });
          }}
          onRetryAttachment={(key) => pool.retry(thread.id, key)}
          active={active}
          canCancel={active || queue.length > 0}
          disabled={false}
          modelId={thread.modelId}
          onModelChange={(modelId) => {
            const rpc = client.rpc,
              checkpoint = store.checkpoint;
            if (!rpc || !checkpoint) return;
            void attempt(
              () =>
                rpc.threads.update({
                  threadId: thread.id,
                  expectedRevision: checkpoint.projectionRevision,
                  modelId,
                }),
              setError,
            );
          }}
          onSubmit={submit}
          onCancel={() => void cancel()}
        />
      ) : (
        <div className="read-only">Read-only</div>
      )}
    </div>
  );
  return (
    <div className="chat-workspace">
      <UploadProgressContext.Provider value={uploadProgress}>
        <Timeline
          header={props.header}
          footer={composer}
          onLatestVisibleChange={setLatestVisible}
          client={client}
          threadId={thread.id}
          canEdit={thread.capabilities.edit}
          resourceUrl={props.resourceUrl}
          upload={recoveryUpload}
          onRewind={setRewindTarget}
          onAction={onAction}
          onReaction={onReaction}
          positions={props.positions}
        />
      </UploadProgressContext.Provider>

      {thread.capabilities.edit && rewindTarget ? (
        <Modal title="Rewind this conversation?" onClose={() => setRewindTarget(undefined)}>
          <p>
            The selected turn and everything after it will leave the conversation. Its text returns
            to your composer. File changes and other tool effects remain.
          </p>
          {active ? <p>The active run will be canceled and queued messages dropped.</p> : null}
          <div className="dialog-actions">
            <Button className="button" onClick={() => setRewindTarget(undefined)}>
              Keep conversation
            </Button>
            <Button
              variant="destructive"
              className="button danger"
              disabled={rewinding}
              onClick={() => void rewind()}
            >
              <RotateCcw />
              Rewind
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
