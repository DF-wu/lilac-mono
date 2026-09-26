import { rewindDraft } from "../rewind-draft";
import type { OptimisticTurn } from "../optimistic-turns";
import { useEventCallback } from "../use-event-callback";
import { useStore } from "zustand";
import { draftAttachment, releaseDraftAttachments, type DraftThread } from "../draft-thread";
import type { ActorIdentity } from "./ActorAvatar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  participantOptions,
  composerDraftOptions,
  updateComposerDraft,
  queueOptions,
  refreshQueue as refreshQueueQuery,
  useNativeOnline,
} from "../queries";
import { MessageIdentityContext } from "./message-identity";
import { useWorkspace } from "../workspace-context";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { X, RotateCcw } from "lucide-react";
import type {
  NativeInput,
  DisplayPart,
  NativeThread,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { ChatCommon, ComposerSubmission } from "../types";
import { resolveAttachmentIds } from "../uploads";
import { inputDeliveryOptions } from "../input-mode";
import { deliverPendingInput, type PendingInput } from "../pending-input";
import { pendingMessageParts } from "../pending-message";
export type { PendingInput } from "../pending-input";
import { Button } from "./ui/button";
import { Composer } from "./Composer";
import { Timeline, ThinkingIndicator, useLatestReadableTurn } from "./Timeline";
import { attempt, IconButton, Modal, VirtualList } from "./ui";
import { toast } from "./ui/toast";

import { UploadProgressContext } from "../upload-context";
const queueLabels = { prompt: "Prompt", steer: "Steering", followup: "Follow-up" };
export type Draft = {
  text: string;
  skillIds: string[];
  commandId?: string;
  attachments: string[];
  savedText?: string;
};
const emptyDraft: Draft = { text: "", skillIds: [], attachments: [] };
export type ChatProps = Pick<ChatCommon, "catalog" | "onError"> & {
  threadId: string;
  thread?: NativeThread;
  loadingMessage?: string;
  onRetryLoad: () => void;
  onLocalChange: (id: string, update: (thread: DraftThread) => DraftThread) => void;
  onLocalSubmit: (id: string, submission: ComposerSubmission) => void;
  header: ReactNode;
  draft?: Draft;
  onDraft: (id: string, draft: Draft) => void;
  readTurns: Map<string, string>;
  pending: PendingInput[];
  onPending: (id: string, update: (pending: PendingInput[]) => PendingInput[]) => void;
  foreground: boolean;
  autoFocus?: boolean;
};

export function Chat(props: ChatProps) {
  const {
    client,
    pool,
    scope,
    upload,
    resourceUrl,
    draftCache,
    drafts: draftStore,
  } = useWorkspace();
  const { thread, threadId } = props;
  const local = threadId.startsWith("draft:");
  const localThread = useStore(draftStore, (state) => state.localDrafts.get(threadId));
  const editable = local ? !!localThread : !!thread?.capabilities.edit;
  const queries = useQueryClient();
  const draftOptions = composerDraftOptions(scope, threadId, draftCache);
  const draftQuery = useQuery({
    ...draftOptions,
    initialData: props.draft,
    enabled: !local,
  });
  const draft = localThread?.draft ?? draftQuery.data ?? emptyDraft;
  const draftLoaded = local ? !!localThread : !draftQuery.isPending;
  const identity = useContext(MessageIdentityContext);
  const [view, setView] = useState<{
    id: string;
    error?: string;
    historyError?: string;
    rewindTarget?: string;
    rewinding?: boolean;
    latestVisible?: boolean;
    unknownAuthor?: string;
  }>({ id: threadId });
  if (view.id !== threadId) setView({ id: threadId });
  const updateView = useCallback(
    (patch: Partial<Omit<typeof view, "id">>) => {
      setView((current) => {
        if (current.id !== threadId) return current;
        if (
          Object.entries(patch).every(
            ([key, value]) => current[key as keyof typeof current] === value,
          )
        )
          return current;
        return { ...current, ...patch };
      });
    },
    [threadId],
  );
  const setError = useCallback((error?: string) => updateView({ error }), [updateView]);
  const setHistoryError = useCallback(
    (historyError?: string) => updateView({ historyError }),
    [updateView],
  );
  const setRewindTarget = useCallback(
    (rewindTarget?: string) => updateView({ rewindTarget }),
    [updateView],
  );
  const setRewinding = (rewinding: boolean) => updateView({ rewinding });
  const setLatestVisible = useCallback(
    (latestVisible: boolean) => updateView({ latestVisible }),
    [updateView],
  );
  const { error, historyError, rewindTarget, rewinding, latestVisible, unknownAuthor } =
    view.id === threadId ? view : {};
  const currentId = useRef(threadId);
  currentId.current = threadId;
  const getDraft = () =>
    local
      ? (draftStore.getState().localDrafts.get(threadId)?.draft ?? emptyDraft)
      : (queries.getQueryData(draftOptions.queryKey) ?? emptyDraft);
  const commitDraft = (value: Draft) => {
    if (local) {
      props.onLocalChange(threadId, (current) => ({ ...current, draft: value }));
      return;
    }
    updateComposerDraft(queries, threadId, value);
    props.onDraft(threadId, value);
    if (draftCache) void attempt(() => draftCache.saveDraft(scope, threadId, value), setError);
  };
  const pendingEntries = props.pending;
  const commitPending = (update: (entries: PendingInput[]) => PendingInput[]) =>
    props.onPending(threadId, update);
  const store = client.thread(threadId);
  const subscribeHistory = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const historySnapshot = useCallback(() => !!store.checkpoint, [store]);
  const historyLoaded = useSyncExternalStore(subscribeHistory, historySnapshot, historySnapshot);
  const readableTurnId = useLatestReadableTurn(store);
  const sendingEntry = localThread?.sending
    ? localThread.creation?.entry
    : pendingEntries.find((entry) => entry.state === "preparing" || entry.state === "accepted");
  const activeTurnSnapshot = useCallback(() => {
    const slot = store.at(store.size - 1);
    return slot?.kind === "ready" && (slot.state === "pending" || slot.state === "running");
  }, [store]);
  const activeTurn = useSyncExternalStore(subscribeHistory, activeTurnSnapshot, activeTurnSnapshot);
  const serverActive = !!thread?.activeRunId || activeTurn;
  const active = serverActive || !!sendingEntry;
  const previousActive = useRef(active);
  const canEdit = useRef(editable);
  canEdit.current = editable;
  const online = useNativeOnline(client);
  const participants = useQuery({
    ...participantOptions(client, threadId),
    enabled: online && !local,
  });
  const setUnknownAuthor = useCallback(
    (unknownAuthor: string) => updateView({ unknownAuthor }),
    [updateView],
  );
  useEffect(() => {
    if (!local && unknownAuthor)
      void queries.invalidateQueries({ queryKey: ["participants", threadId] });
  }, [queries, threadId, unknownAuthor, local]);
  const identities = useMemo(() => {
    const users = new Map<string, ActorIdentity>(
      participants.data?.items.map(({ user }) => [
        user.id,
        { displayName: user.displayName, avatarUrl: user.avatarUrl },
      ]),
    );
    const viewer = identity.viewerId ? identity.users.get(identity.viewerId) : undefined;
    if (identity.viewerId && viewer) users.set(identity.viewerId, viewer);
    return {
      agent: identity.agent,
      viewerId: identity.viewerId,
      users,
      onUnknownAuthor: participants.data ? setUnknownAuthor : undefined,
    };
  }, [identity, participants.data, setUnknownAuthor]);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "connection" && event.state === "online") setHistoryError(undefined);
        if (event.kind === "error" && event.error.kind !== "network" && !store.checkpoint)
          setHistoryError(event.error.message);
      }),
    [client, store],
  );
  const queueQuery = useQuery({
    ...queueOptions(client, threadId),
    enabled: online && !local && editable,
  });
  const queue = editable
    ? (queueQuery.data?.items ?? []).filter((entry) => entry.mode !== "prompt")
    : [];
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribe(threadId, listener),
    [pool, threadId],
  );
  const snapshot = useCallback(() => pool.get(threadId), [pool, threadId]);
  const uploads = useSyncExternalStore(subscribe, snapshot, snapshot);
  const uploadProgress = useMemo(() => ({ pool, threadId }), [pool, threadId]);
  const pendingAttachments = useMemo(
    () =>
      sendingEntry?.submission.attachments.map(
        (attachment) => uploads.find((upload) => upload.key === attachment.key) ?? attachment,
      ) ?? [],
    [sendingEntry, uploads],
  );
  const messageResourceUrl = useCallback(
    (id: string) =>
      pendingAttachments.find((attachment) => (attachment.resourceId ?? attachment.key) === id)
        ?.preview ?? resourceUrl(id),
    [pendingAttachments, resourceUrl],
  );
  const pendingTurn = useMemo<ReadyTurnSlot | undefined>(() => {
    if (!sendingEntry || (!sendingEntry.optimisticSlotIds && serverActive)) return;
    return {
      kind: "ready",
      slotId: `sending:${sendingEntry.commandId}`,
      turnId: `sending:${sendingEntry.commandId}`,
      position: store.size,
      state: "pending",
      messages: [
        {
          id: sendingEntry.commandId,
          role: "user",
          metadata: { authorId: scope.principalId },
          parts: pendingMessageParts(sendingEntry.submission, pendingAttachments),
        },
      ],
    };
  }, [sendingEntry, pendingAttachments, serverActive, scope.principalId, store]);
  const optimisticTurn = useMemo<OptimisticTurn | undefined>(() => {
    if (!pendingTurn || !sendingEntry) return;
    return {
      slot: pendingTurn,
      precedingSlotIds: sendingEntry.optimisticSlotIds ?? store.slotIds,
      confirmedSlotId: sendingEntry.receipt?.turnId,
    };
  }, [pendingTurn, sendingEntry, store]);
  const resolveOptimistic = useEventCallback(() => {
    if (!sendingEntry?.receipt) return;
    for (const attachment of sendingEntry.submission.attachments)
      pool.release(threadId, attachment.key);
    commitPending((entries) =>
      entries.filter((entry) => entry.commandId !== sendingEntry.commandId),
    );
  });
  const visiblePendingEntries = pendingEntries.filter(
    (entry) => entry.commandId !== sendingEntry?.commandId || !pendingTurn,
  );

  useEffect(() => {
    if (!editable) setRewindTarget(undefined);
  }, [editable]);
  const recoveryUpload = useCallback(
    (resourceId: string, file: File, onProgress: (fraction: number) => void) =>
      upload(resourceId, file, onProgress, pool.signal),
    [upload, pool],
  );
  const attachments = useMemo(
    () =>
      localThread?.attachments ??
      uploads.filter((attachment) => draft.attachments.includes(attachment.key)),
    [localThread?.attachments, uploads, draft.attachments],
  );
  const refreshQueue = useCallback(() => refreshQueueQuery(queries, threadId), [queries, threadId]);
  useEffect(() => {
    if (queueQuery.error && client.connectionState === "online") setError(queueQuery.error.message);
  }, [client, queueQuery.error]);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "input" && event.threadId === threadId) void refreshQueue();
      }),
    [client, threadId, refreshQueue],
  );
  useEffect(() => {
    const changed = previousActive.current !== active;
    previousActive.current = active;
    if (changed) void refreshQueue();
  }, [active, refreshQueue]);
  useEffect(() => {
    if (local || !props.foreground || !readableTurnId || !latestVisible || active) return;
    const turnId = readableTurnId;
    let pending = false;
    function markVisibleTurnRead() {
      const rpc = client.rpc;
      if (
        document.visibilityState !== "visible" ||
        !rpc ||
        pending ||
        props.readTurns.get(threadId) === turnId
      )
        return;
      pending = true;
      void attempt(() => rpc.threads.markRead({ threadId: threadId, turnId }), setError).then(
        (result) => {
          pending = false;
          if (result) props.readTurns.set(threadId, turnId);
        },
      );
    }
    markVisibleTurnRead();
    document.addEventListener("visibilitychange", markVisibleTurnRead);
    return () => document.removeEventListener("visibilitychange", markVisibleTurnRead);
  }, [client, threadId, active, latestVisible, readableTurnId, props.readTurns, props.foreground]);

  const setPending = (commandId: string, patch: Partial<PendingInput> | null) => {
    commitPending((entries) =>
      patch
        ? entries.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry))
        : entries.filter((entry) => entry.commandId !== commandId),
    );
  };
  async function prepareInput(
    entry: PendingInput,
    retryFailed: boolean,
  ): Promise<NativeInput | undefined> {
    const [ids, { resolveComposerAttachments }] = await Promise.all([
      resolveAttachmentIds(pool, threadId, entry.submission.attachments, retryFailed),
      import("./composer-editor"),
    ]);
    if (currentId.current === threadId && !canEdit.current) {
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
    return {
      threadId: threadId,
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
        serverActive,
        entry.submission.mode,
        entry.submission.modelId,
        !!entry.submission.command,
      ),
      attachmentIds: ids.filter((id): id is string => !!id),
      skillIds: entry.submission.skillIds,
      command: entry.submission.command,
    };
  }
  async function deliver(entry: PendingInput, retryFailed = false) {
    let awaitingProjection = false;
    const outcome = await deliverPendingInput(
      entry,
      () => prepareInput(entry, retryFailed),
      (input) => client.submit(input),
      (patch) => {
        awaitingProjection = patch?.state === "accepted";
        setPending(entry.commandId, patch);
      },
      currentId.current !== threadId || canEdit.current,
    );
    if (outcome?.kind !== "accepted") return;
    if (!awaitingProjection)
      for (const attachment of entry.submission.attachments) pool.release(threadId, attachment.key);
    void refreshQueue();
  }
  function submit(submission: ComposerSubmission) {
    if (local) {
      props.onLocalSubmit(threadId, submission);
      return;
    }
    const entry: PendingInput = {
      commandId: crypto.randomUUID(),
      text: submission.text,
      submission,
      optimisticSlotIds: serverActive ? undefined : [...store.slotIds],
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
          threadId: threadId,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
          runId: thread?.activeRunId,
        }),
      setError,
    );
    void refreshQueue();
  }
  async function rewind() {
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (
      !draftLoaded ||
      !canEdit.current ||
      !rpc ||
      !checkpoint ||
      !rewindTarget ||
      rewinding ||
      active
    )
      return;
    setRewinding(true);
    let target = store.get(rewindTarget);
    while (target?.kind === "ready" && target.partsCursor) {
      const cursor = target.partsCursor;
      await client.loadTurnPage(threadId, rewindTarget);
      target = store.get(rewindTarget);
      if (target?.kind !== "ready" || target.partsCursor === cursor) {
        setError("Could not load the complete message. Try rewinding again.");
        setRewinding(false);
        return;
      }
    }
    const message =
      target?.kind === "ready"
        ? target.messages.find(
            (item) => item.role === "user" && item.metadata?.inputMode !== "steer",
          )
        : undefined;
    if (!message) {
      setError("The message is no longer available.");
      setRewinding(false);
      return;
    }
    const restored = await rewindDraft({
      parts: message.parts,
      threadId,
      resourceUrl,
      pool,
      onError: setError,
      rewind: async () => {
        if (!canEdit.current || currentId.current !== threadId) return;
        return attempt(
          () =>
            rpc.threads.rewind({
              threadId,
              commandId: crypto.randomUUID(),
              historyGeneration: checkpoint.historyGeneration,
              expectedRevision: checkpoint.projectionRevision,
              turnId: rewindTarget,
            }),
          setError,
        );
      },
    });
    setRewinding(false);
    if (!restored) return;
    const current = getDraft();
    commitDraft({
      ...restored,
      skillIds: [],
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
            threadId: threadId,
            messageId,
            actionId,
            requestId: part.data.requestId,
            revision: part.data.revision,
            commandId: crypto.randomUUID(),
          }),
        setError,
      );
    },
    [client, threadId],
  );
  const onReaction = useCallback(
    (messageId: string, emoji: string, enabled: boolean) => {
      if (!client.rpc) return;
      void attempt(
        () => client.rpc!.reactions.set({ threadId: threadId, messageId, emoji, active: enabled }),
        setError,
      );
    },
    [client, threadId],
  );
  const composerSkills = useEventCallback((skillIds: string[]) =>
    commitDraft({ ...getDraft(), skillIds }),
  );
  const composerCommand = useEventCallback((commandId: string | undefined) =>
    commitDraft({ ...getDraft(), commandId }),
  );
  const composerText = useEventCallback((text: string) => commitDraft({ ...getDraft(), text }));
  const composerAttach = useEventCallback((files: File[], requireAll?: boolean) => {
    if (local) {
      const current = draftStore.getState().localDrafts.get(threadId);
      if (!current) return [];
      const available = 32 - current.attachments.length;
      if (requireAll && files.length > available) return [];
      const added = files.slice(0, available).map(draftAttachment);
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: [...current.attachments, ...added],
        draft: {
          ...current.draft,
          attachments: [...current.draft.attachments, ...added.map((item) => item.key)],
        },
      }));
      return added;
    }
    const current = getDraft();
    const available = 32 - current.attachments.length;
    if (requireAll && files.length > available) return [];
    const keys = files.slice(0, available).map((file) => pool.add(threadId, file));
    commitDraft({ ...current, attachments: [...current.attachments, ...keys] });
    return keys.map((key) => pool.get(threadId).find((attachment) => attachment.key === key)!);
  });
  const composerRemoveAttachment = useEventCallback((key: string) => {
    if (local) {
      releaseDraftAttachments(attachments.filter((item) => item.key === key));
      props.onLocalChange(threadId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.key !== key),
        draft: {
          ...current.draft,
          attachments: current.draft.attachments.filter((id) => id !== key),
        },
      }));
      return;
    }
    pool.remove(threadId, key);
    commitDraft({ ...draft, attachments: draft.attachments.filter((id) => id !== key) });
  });
  const composerRetryAttachment = useEventCallback((key: string) => pool.retry(threadId, key));
  const composerModelChange = useEventCallback((modelId: string) => {
    if (local) {
      props.onLocalChange(threadId, (current) => ({ ...current, modelId }));
      return;
    }
    const rpc = client.rpc,
      checkpoint = store.checkpoint;
    if (!rpc || !checkpoint) return;
    void attempt(
      () =>
        rpc.threads.update({
          threadId: threadId,
          expectedRevision: checkpoint.projectionRevision,
          modelId,
        }),
      setError,
    );
  });
  const composerCancel = useEventCallback(() => void cancel());
  const composerSubmit = useEventCallback(submit);
  const composerError = localThread?.error ?? error ?? draftQuery.error?.message ?? historyError;
  const dismissComposerError = useEventCallback((id: string, message: string) => {
    if (id !== threadId || message !== composerError) return;
    setError(undefined);
    setHistoryError(undefined);
    if (local) props.onLocalChange(threadId, (current) => ({ ...current, error: undefined }));
  });
  useEffect(() => {
    if (!composerError) return;
    const id = `composer-error:${threadId}`;
    toast.add({
      id,
      title: composerError,
      type: "error",
      onClose: () => dismissComposerError(threadId, composerError),
    });
    return () => toast.close(id);
  }, [composerError, threadId, dismissComposerError]);
  const composer = (
    <div className="chat-bottom w-full max-w-[var(--ui-chat-width)] my-0 mx-auto pt-2 px-6 pb-6 max-workspace:px-3 max-workspace:pb-3">
      {localThread?.creation && !pendingTurn ? (
        <div className="pending-input flex flex-wrap gap-2 p-2 mb-2 rounded-sm bg-surface text-sm">
          <span>{localThread.creation.entry.text}</span>
          <small>
            {localThread.sending ? <ThinkingIndicator /> : "Conversation could not be created."}
          </small>
          {!localThread.sending ? (
            <Button
              onClick={() => props.onLocalSubmit(threadId, localThread.creation!.entry.submission)}
            >
              Retry message
            </Button>
          ) : null}
        </div>
      ) : null}
      {visiblePendingEntries.length ? (
        <VirtualList
          className="pending-inputs max-h-48 h-24"
          items={visiblePendingEntries}
          itemKey={(entry) => entry.commandId}
          label="Pending messages"
          estimate={88}
          render={(entry) => (
            <div
              className="pending-input flex flex-wrap gap-2 p-2 mb-2 rounded-sm bg-surface text-sm"
              key={entry.commandId}
            >
              <span>{entry.text}</span>
              {entry.error ? <small>{entry.error}</small> : <ThinkingIndicator />}
              {editable && entry.state !== "preparing" && entry.state !== "accepted" ? (
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
      {editable && queue.length ? (
        <div className="queue bg-surface rounded-md mb-2 p-1">
          <VirtualList
            items={queue}
            itemKey={(entry) => entry.inputId}
            label="Queued messages"
            estimate={48}
            render={(entry) => (
              <div className="queue-entry flex items-center gap-2 py-1 px-2 text-sm">
                <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
                  {queueLabels[entry.mode]}
                </span>
                <span>{entry.text}</span>
                <IconButton
                  label="Remove queued message"
                  onClick={() => {
                    const checkpoint = store.checkpoint;
                    if (!client.rpc || !checkpoint) return;
                    void attempt(
                      () =>
                        client.rpc!.runs.removeQueued({
                          threadId: threadId,
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
          className="text-primary py-2 px-3 text-sm"
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
      <div hidden={!editable}>
        <Composer
          documentKey={threadId}
          autoFocus={props.autoFocus}
          loadingDraft={!draftLoaded}
          windowDrop={props.foreground}
          catalog={props.catalog}
          text={draft.text}
          skillIds={draft.skillIds}
          onSkills={composerSkills}
          commandId={draft.commandId}
          onCommand={composerCommand}
          onText={composerText}
          attachments={attachments}
          onAttach={composerAttach}
          onRemoveAttachment={composerRemoveAttachment}
          onRetryAttachment={composerRetryAttachment}
          active={active}
          canCancel={active || queue.length > 0}
          disabled={!editable || !draftLoaded || !!rewinding}
          submitting={!!localThread?.creation}
          offline={!online}
          modelId={localThread?.modelId ?? thread?.modelId}
          onModelChange={composerModelChange}
          onSubmit={composerSubmit}
          onCancel={composerCancel}
        />
      </div>
      {!editable && thread ? <div className="read-only">Read-only</div> : null}
    </div>
  );
  function renderEmptyConversation() {
    if (local)
      return (
        <div className="welcome">
          <span className="brand inline-flex gap-1 items-baseline text-2xl [letter-spacing:-0.07em] font-[650]">
            lilac
            <span />
          </span>
        </div>
      );
    if (props.loadingMessage)
      return (
        <div className="empty-chat" role="status">
          <p>{props.loadingMessage}</p>
          {!thread ? (
            <Button variant="secondary" onClick={props.onRetryLoad}>
              Retry
            </Button>
          ) : null}
        </div>
      );
    if (historyLoaded) return undefined;
    return (
      <div className="empty-chat">
        {online && !historyError
          ? "Loading conversation…"
          : "Conversation history is unavailable. Reconnect to load it."}
      </div>
    );
  }
  return (
    <MessageIdentityContext value={identities}>
      <div className="chat-workspace min-h-0 flex flex-col flex-1" data-thread-id={threadId}>
        <UploadProgressContext.Provider value={uploadProgress}>
          <Timeline
            optimisticTurn={optimisticTurn}
            onOptimisticResolved={resolveOptimistic}
            emptyContent={renderEmptyConversation()}
            header={props.header}
            footer={composer}
            onLatestVisibleChange={setLatestVisible}
            client={client}
            threadId={threadId}
            canEdit={editable && draftLoaded}
            resourceUrl={messageResourceUrl}
            upload={recoveryUpload}
            onRewind={setRewindTarget}
            rewindDisabled={active}
            onAction={onAction}
            onReaction={onReaction}
          />
        </UploadProgressContext.Provider>

        <Modal
          open={editable && !!rewindTarget}
          title="Rewind this conversation?"
          onClose={() => setRewindTarget(undefined)}
        >
          <p>
            The selected turn and everything after it will leave the conversation. Its text and
            attachments return to your composer. File changes and other tool effects remain.
          </p>
          {active ? <p>Wait for the agent to finish before rewinding.</p> : null}
          <div className="dialog-actions flex justify-end gap-2 mt-6">
            <Button
              variant="secondary"
              className="gap-2 rounded-sm px-4"
              onClick={() => setRewindTarget(undefined)}
            >
              Keep conversation
            </Button>
            <Button
              variant="destructive"
              className="gap-2 rounded-sm px-4"
              disabled={rewinding || active}
              onClick={() => void rewind()}
            >
              <RotateCcw />
              Rewind
            </Button>
          </div>
        </Modal>
      </div>
    </MessageIdentityContext>
  );
}
