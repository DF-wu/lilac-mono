import type { UIMessageChunk } from "ai";
import type { Result as ResultType } from "better-result";

import {
  type MiniLilacCompactResult,
  type MiniLilacCompactError,
  type MiniLilacControlResult,
  type MiniLilacHistoryFilesystemResult,
  type MiniLilacOutputRollback,
  type MiniLilacReasoning,
  type MiniLilacRequestError,
  type MiniLilacResultStream,
  type MiniLilacSessionSnapshot,
  type MiniLilacStreamError,
  type MiniLilacTodoState,
  type MiniLilacTranscriptReset,
  type MiniLilacTransport,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import {
  editorOffsetIndex,
  editorOffsetWidth,
  initialInputState,
  reduceInput,
  type DraftFile,
  type DraftPastedText,
  type InputEffect,
  type InputEvent,
  type InputState,
} from "./input-state";
import { compactionEntry, type TranscriptEntry } from "./render";
import { ChunkRenderer, renderInitialMessages } from "./render-boundary";
import { sessionPresentation, type SessionPresentation } from "./presentation";
import {
  cancelTerminalStream,
  readTerminalStream,
  releaseTerminalStreamLock,
  type TerminalStreamCleanupFailed,
  type TerminalStreamReadFailed,
} from "./terminal-stream-adapter";
import {
  projectMiniLilacStreamChunk,
  UIMessageChunkProjectionState,
} from "./ui-message-chunk-projection";

export interface ControllerUISink {
  onState(state: InputState): void;
  onOutput(entries: readonly TranscriptEntry[]): void;
  onSteering?(messages: readonly MiniLilacUserUIMessage[]): void;
  onTodos?(todos: MiniLilacTodoState): void;
  onBindings?(bindings: SessionBindings): void;
  onSession?(session: SessionPresentation): void;
  onNotice?(message: string, tone: "warning" | "danger"): void;
}

export interface SessionBindings {
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly reasoning: MiniLilacReasoning | undefined;
}

export interface HistoryNavigationState {
  readonly historyStateId: string | undefined;
  readonly canUndo: boolean | undefined;
  readonly canRedo: boolean | undefined;
}

export type SessionBindingUpdate =
  | { readonly model: string; readonly profile?: string; readonly reasoning?: MiniLilacReasoning }
  | { readonly model?: string; readonly profile: string; readonly reasoning?: MiniLilacReasoning }
  | { readonly model?: string; readonly profile?: string; readonly reasoning: MiniLilacReasoning };

export interface ControllerOptions {
  readonly transport: MiniLilacTransport;
  readonly ui: ControllerUISink;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly initialSnapshot?: MiniLilacSessionSnapshot;
  readonly initialMessages?: readonly MiniLilacUIMessage[];
  readonly initialTodos?: MiniLilacTodoState;
  readonly initialBindings?: SessionBindings;
  readonly reconnectDelay?: (attempt: number) => Promise<void>;
  /** Delay between session polls while following a detached compaction. */
  readonly compactionWatchDelay?: () => Promise<void>;
  readonly onExit: () => void;
}

/** How often a detached compaction is polled for its outcome. */
const COMPACTION_WATCH_INTERVAL_MS = 1_500;

type StreamOutcome = "completed" | "disconnected" | "disposed" | "superseded";

type ControllerFailure =
  | MiniLilacRequestError
  | MiniLilacCompactError
  | MiniLilacStreamError
  | TerminalStreamReadFailed
  | TerminalStreamCleanupFailed;

type DraftSnapshot = Pick<InputState, "editor" | "files" | "pastedTexts">;

interface DraftProvenance {
  readonly before: DraftSnapshot;
  readonly after: DraftSnapshot;
}

function errorMessage(error: ControllerFailure): string {
  return error.message;
}

/**
 * Wires semantic UI events, the input-state reducer, and the mini-lilac
 * transport into an interactive session. It has no terminal dependencies.
 */
export class Controller {
  private state: InputState = initialInputState();
  private readonly renderer: ChunkRenderer;
  private readonly streamProjection: UIMessageChunkProjectionState;
  private messages: MiniLilacUIMessage[];
  private output: TranscriptEntry[];
  private steering: MiniLilacUserUIMessage[] = [];
  private outputSequence = 0;
  private steerChain: Promise<void> = Promise.resolve();
  private promptAdmission: Promise<string | undefined>;
  private resolvePromptAdmission: ((runId: string | undefined) => void) | undefined;
  private activeRunId: string | undefined;
  private activeReader:
    | ReadableStreamDefaultReader<ResultType<UIMessageChunk, MiniLilacStreamError>>
    | undefined;
  private pendingUndoCommandId: string | undefined;
  private pendingRedoCommandId: string | undefined;
  private undoDraftProvenance: DraftProvenance[] = [];
  private draftMutationGeneration = 0;
  private historyStateId: string | undefined;
  private canUndo: boolean | undefined;
  private canRedo: boolean | undefined;
  /**
   * Resolves once the running compact request is admitted server-side (its
   * first lifecycle event). `esc` cancellation awaits this: a cancel that
   * reaches the server before admission answers `inactive`, and the compaction
   * would then proceed despite the user's request.
   */
  private compactionAdmission: Promise<void> = Promise.resolve();
  private resolveCompactionAdmission: (() => void) | undefined;
  /**
   * Command id of the compaction this controller started, so `esc` cancels
   * that operation and not an unrelated successor. Undefined when following a
   * compaction admitted by an earlier client (reopened session).
   */
  private compactionCommandId: string | undefined;
  private watchingDetachedCompaction = false;
  /** Cancels only the in-flight manual compaction, not the whole session. */
  private bindings: SessionBindings;
  private presentation: SessionPresentation;
  private todos: MiniLilacTodoState;
  private sessionExists: boolean;
  private readonly abortController = new AbortController();
  private controlAbortController = new AbortController();
  private controlGeneration = 0;
  private readonly pendingSteerCommandIds = new Set<string>();
  private readonly pendingSteerOptimistic = new Map<
    string,
    { readonly messageId: string; readonly remove: () => void }
  >();
  private readonly interruptSteerCommandIds = new Map<string, readonly string[]>();
  private runOutputBaseline: number;
  private runMessageBaseline: number;
  private runGeneration = 0;
  private disposed = false;

  constructor(private readonly options: ControllerOptions) {
    this.streamProjection = new UIMessageChunkProjectionState({
      cwd: options.cwd ?? options.initialSnapshot?.cwd,
    });
    this.activeRunId = options.initialSnapshot?.activeRunId ?? undefined;
    this.sessionExists =
      options.initialSnapshot !== undefined || (options.initialMessages?.length ?? 0) > 0;
    this.historyStateId = options.initialSnapshot?.historyStateId;
    this.canUndo = options.initialSnapshot?.canUndo;
    this.canRedo = options.initialSnapshot?.canRedo;
    this.bindings =
      options.initialSnapshot === undefined
        ? (options.initialBindings ?? {
            model: undefined,
            profile: undefined,
            reasoning: undefined,
          })
        : {
            model: options.initialSnapshot.model ?? undefined,
            profile: options.initialSnapshot.profile ?? undefined,
            reasoning: options.initialSnapshot.reasoning ?? undefined,
          };
    this.presentation = sessionPresentation(options.initialSnapshot);
    this.todos = options.initialTodos ?? { revision: 0, todos: [] };
    this.promptAdmission = Promise.resolve(this.activeRunId);
    this.messages = [...(options.initialMessages ?? [])];
    this.output = this.renderMessages();
    this.runOutputBaseline = this.output.length;
    this.runMessageBaseline = this.messages.length;
    if (
      options.initialSnapshot?.status === "streaming" ||
      options.initialSnapshot?.status === "cancelling"
    ) {
      this.state = reduceInput(this.state, { type: "agent-started" }).state;
      this.state = reduceInput(this.state, {
        type: "steering-updated",
        queuedSteeringCount: options.initialSnapshot.queuedSteeringCount,
      }).state;
    }
    if (options.initialSnapshot?.status === "compacting") {
      // A compaction admitted by an earlier client is still running. It cannot
      // be re-attached for live progress, but it must not be shown as idle:
      // the server refuses prompts, and `esc` must still be able to cancel it.
      this.state = reduceInput(this.state, { type: "compaction-observed" }).state;
      this.compactionCommandId = options.initialSnapshot.activeCompactionCommandId ?? undefined;
    }
    this.renderer = new ChunkRenderer(
      {
        append: (entry) => this.appendOutput(entry),
        update: (id, entry) => this.updateOutput(id, entry),
        remove: (id) => this.removeOutput(id),
        appendText: (id, delta) => this.appendOutputText(id, delta),
        finish: (id) => this.finishOutput(id),
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onControl: (result) => this.onControl(result),
        onTodos: (todos) => this.onTodos(todos),
        onTranscriptReset: (reset) => this.onTranscriptReset(reset),
        onOutputRollback: (rollback) => this.onOutputRollback(rollback),
      },
      { cwd: options.cwd ?? options.initialSnapshot?.cwd },
    );
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** Publish initial state/output and reconnect a resumed active session. */
  start(): void {
    this.notifyState();
    this.notifyOutput();
    this.notifySteering();
    this.options.ui.onTodos?.(this.todos);
    this.options.ui.onBindings?.(this.bindings);
    this.options.ui.onSession?.(this.presentation);
    if (this.state.phase === "active") void this.resumeActiveSession();
    else if (this.state.phase === "compacting") void this.watchDetachedCompaction();
  }

  /** Replace the editor value from a managed textarea. */
  setEditor(text: string): void {
    if (text !== this.state.editor) this.invalidateDraftProvenance();
    this.dispatch({ type: "set-editor", text });
  }

  /** Apply Enter semantics to the current editor and lifecycle state. */
  submit(): void {
    this.dispatch({ type: "submit" });
  }

  undo(): void {
    this.dispatch({ type: "request-undo" });
  }

  redo(): void {
    this.dispatch({ type: "request-redo" });
  }

  compact(): void {
    this.dispatch({ type: "request-compact" });
  }

  async updateSessionBindings(update: SessionBindingUpdate): Promise<boolean> {
    if (this.state.phase !== "idle") return false;
    this.dispatch({ type: "operation-started" });
    if (!this.sessionExists) {
      this.options.transport.setSessionBindings(update);
      this.bindings = { ...this.bindings, ...update };
      this.options.ui.onBindings?.(this.bindings);
      this.dispatch({ type: "operation-completed" });
      return true;
    }

    const clientCommandId = crypto.randomUUID();
    const request = { sessionId: this.sessionId, clientCommandId, ...update };
    let updated = await this.options.transport.updateSessionBindingsResult(request, {
      signal: this.abortController.signal,
    });
    if (updated.match({ ok: () => false, err: () => true })) {
      updated = await this.options.transport.updateSessionBindingsResult(request, {
        signal: this.abortController.signal,
      });
    }
    if (this.disposed) return false;
    const snapshot = updated.match({ ok: (value) => value, err: () => undefined });
    if (snapshot !== undefined) {
      this.acceptSnapshot(snapshot);
      this.dispatch({ type: "operation-completed" });
      return true;
    }
    const recovered = await this.reconcileSessionBindings();
    if (recovered !== undefined && sessionBindingUpdateMatches(recovered, update)) {
      this.dispatch({ type: "operation-completed" });
      return true;
    }
    this.dispatch({ type: "operation-failed" });
    updated.match({ ok: () => {}, err: (error) => this.commitError(error) });
    return false;
  }

  private async reconcileSessionBindings(): Promise<MiniLilacSessionSnapshot | undefined> {
    const loaded = await this.options.transport.getSessionResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    if (this.disposed) return undefined;
    const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
    if (snapshot === undefined) return undefined;
    this.options.transport.setSessionBindings({
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    });
    this.acceptSnapshot(snapshot);
    return snapshot;
  }

  /** Esc interrupts server work and never exits the program. */
  escape(): void {
    this.dispatch({ type: "escape" });
  }

  /** First Ctrl-C clears the draft; a second consecutive Ctrl-C exits. */
  ctrlC(): void {
    if (
      this.state.editor.length > 0 ||
      this.state.files.length > 0 ||
      this.state.pastedTexts.length > 0
    ) {
      this.invalidateDraftProvenance();
    }
    this.dispatch({ type: "ctrl-c" });
  }

  addFile(file: DraftFile): void {
    this.invalidateDraftProvenance();
    this.dispatch({ type: "add-file", file });
  }

  addPastedText(pastedText: DraftPastedText): void {
    this.invalidateDraftProvenance();
    this.dispatch({ type: "add-pasted-text", pastedText });
  }

  syncDraftParts(files: readonly DraftFile[], pastedTexts: readonly DraftPastedText[]): void {
    if (
      !draftPartsEqual(this.state.files, files) ||
      !draftPartsEqual(this.state.pastedTexts, pastedTexts)
    ) {
      this.invalidateDraftProvenance();
    }
    this.dispatch({ type: "sync-draft-parts", files, pastedTexts });
  }

  /** Stop local stream consumption when the UI renderer is destroyed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.controlAbortController.abort();
    const reader = this.activeReader;
    this.activeReader = undefined;
    if (reader !== undefined) void cancelTerminalStream(reader);
  }

  /** Current state exposed for focused integration tests and status adapters. */
  get inputState(): InputState {
    return this.state;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.output;
  }

  get steeringQueue(): readonly MiniLilacUserUIMessage[] {
    return this.steering;
  }

  get historyNavigation(): HistoryNavigationState {
    return {
      historyStateId: this.historyStateId,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
    };
  }

  private dispatch(event: InputEvent): void {
    const { state, effects } = reduceInput(this.state, event);
    this.state = state;
    this.notifyState();
    for (const effect of effects) this.execute(effect);
  }

  private execute(effect: InputEffect): void {
    switch (effect.type) {
      case "prompt":
        void this.runPrompt(effect.text, effect.files, effect.pastedTexts);
        return;
      case "steer":
        this.enqueueSteer(effect.text, effect.files, effect.pastedTexts);
        return;
      case "undo":
        void this.runUndo();
        return;
      case "redo":
        void this.runRedo();
        return;
      case "compact":
        void this.runCompact();
        return;
      case "interrupt-queued-steering":
        this.enqueueInterrupt();
        return;
      case "cancel":
        this.enqueueCancel();
        return;
      case "cancel-compaction":
        this.cancelCompaction();
        return;
      case "exit":
        this.options.onExit();
        return;
    }
  }

  private async runPrompt(
    draftText: string,
    files: readonly DraftFile[],
    pastedTexts: readonly DraftPastedText[],
  ): Promise<void> {
    const generation = this.nextRunGeneration();
    let resolveAdmission: (runId: string | undefined) => void = () => {};
    const text = expandDraftText(draftText, files, pastedTexts);
    const message: MiniLilacUserUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: userParts(text, files),
    };
    this.messages.push(message);
    const outputIds = this.appendUserOutput(text, files);
    this.runMessageBaseline = this.messages.length;
    this.runOutputBaseline = this.output.length;

    this.activeRunId = undefined;
    this.promptAdmission = new Promise<string | undefined>((resolve) => {
      resolveAdmission = resolve;
      this.resolvePromptAdmission = resolveAdmission;
    });
    // Become active synchronously before awaiting HTTP admission. This closes
    // the rapid-submit race; steering still waits on promptAdmission below.
    this.dispatch({ type: "agent-started" });

    const admitted = await this.options.transport.sendMessagesResult({
      trigger: "submit-message",
      chatId: this.sessionId,
      messageId: undefined,
      messages: [...this.messages],
      abortSignal: this.abortController.signal,
    });
    const admissionError = admitted.match({ ok: () => undefined, err: (error) => error });
    if (admissionError !== undefined) {
      const error = admissionError;
      const recovery = await this.recoverSessionAfterAmbiguousAdmission();
      if (!this.isCurrentRun(generation)) return;

      if (
        recovery.kind === "session" &&
        recovery.snapshot.activeRunId !== null &&
        recovery.snapshot.activeRunId !== undefined
      ) {
        this.onPromptAdmitted();
        const runId = recovery.snapshot.activeRunId;
        resolveAdmission(runId);
        this.resolvePromptAdmission = undefined;
        this.promptAdmission = Promise.resolve(runId);
        this.activeRunId = runId;
        if (recovery.messages !== undefined) this.replaceMessages(recovery.messages);
        this.runMessageBaseline = this.messages.length;
        this.runOutputBaseline = this.output.length;
        this.beginRun();
        await this.reconnectRun(generation);
        return;
      }

      if (
        recovery.kind === "session" &&
        recovery.snapshot.status !== "compacting" &&
        recovery.messages?.some((candidate) => candidate.id === message.id)
      ) {
        this.onPromptAdmitted();
        resolveAdmission(undefined);
        this.resolvePromptAdmission = undefined;
        this.replaceMessages(recovery.messages);
        this.activeRunId = undefined;
        this.dispatch({ type: "agent-stopped" });
        return;
      }

      if (recovery.kind === "session" && recovery.snapshot.status === "compacting") {
        const promptWasCommitted =
          recovery.messages?.some((candidate) => candidate.id === message.id) === true;
        if (promptWasCommitted) this.onPromptAdmitted();
        resolveAdmission(undefined);
        if (this.resolvePromptAdmission === resolveAdmission) {
          this.resolvePromptAdmission = undefined;
        }
        if (recovery.messages !== undefined) this.replaceMessages(recovery.messages);
        else {
          this.messages = this.messages.filter((candidate) => candidate.id !== message.id);
          outputIds.forEach((id) => this.removeOutput(id));
          this.runMessageBaseline = this.messages.length;
          this.runOutputBaseline = this.output.length;
        }
        this.dispatch({ type: "admission-failed" });
        if (!promptWasCommitted) {
          this.restoreSubmittedDraft(draftText, files, pastedTexts, false, true);
          this.commitError(error);
        }
        this.compactionCommandId = recovery.snapshot.activeCompactionCommandId ?? undefined;
        void this.watchDetachedCompaction();
        return;
      }

      if (
        recovery.kind === "unknown" ||
        (recovery.kind === "session" && recovery.messages === undefined)
      ) {
        resolveAdmission(undefined);
        if (this.resolvePromptAdmission === resolveAdmission) {
          this.resolvePromptAdmission = undefined;
        }
        this.dispatch({ type: "disconnected" });
        this.commitError("prompt admission outcome is unknown; resume this session to reconcile");
        return;
      }

      resolveAdmission(undefined);
      if (this.resolvePromptAdmission === resolveAdmission) this.resolvePromptAdmission = undefined;
      this.messages = this.messages.filter((candidate) => candidate.id !== message.id);
      outputIds.forEach((id) => this.removeOutput(id));
      this.runMessageBaseline = this.messages.length;
      this.runOutputBaseline = this.output.length;
      this.dispatch({ type: "admission-failed" });
      this.restoreSubmittedDraft(draftText, files, pastedTexts, false, true);
      this.commitError(error);
      return;
    }
    const stream = admitted.match({ ok: (value) => value, err: () => undefined });
    if (stream === undefined) return;

    if (!this.isCurrentRun(generation)) {
      resolveAdmission(undefined);
      await cancelTerminalStream(stream);
      return;
    }
    this.onPromptAdmitted();
    this.beginRun();

    const outcome = await this.driveStream(stream, generation);
    if (!this.isCurrentRun(generation)) return;
    if (outcome === "completed") {
      await this.completeRun(generation);
    } else if (outcome === "disconnected") {
      this.dispatch({ type: "disconnected" });
    }
  }

  private async recoverSessionAfterAmbiguousAdmission(): Promise<
    | { kind: "session"; snapshot: MiniLilacSessionSnapshot; messages?: MiniLilacUIMessage[] }
    | { kind: "not-created" }
    | { kind: "unknown" }
  > {
    if (this.disposed) return { kind: "unknown" };
    const loaded = await this.options.transport.getSessionResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
    if (loadError !== undefined) {
      const message = errorMessage(loadError);
      return message.includes("(404)") || message.includes("not_found")
        ? { kind: "not-created" }
        : { kind: "unknown" };
    }
    const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
    if (snapshot === undefined) return { kind: "unknown" };
    if (this.disposed) return { kind: "unknown" };
    this.sessionExists = true;
    this.options.transport.setSessionBindings({
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    });
    this.acceptSnapshot(snapshot);
    const loadedMessages = await this.options.transport.getMessagesResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    const messages = loadedMessages.match({ ok: (value) => value, err: () => undefined });
    return { kind: "session", snapshot, ...(messages === undefined ? {} : { messages }) };
  }

  private async resumeActiveSession(): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextRunGeneration();
    this.beginRun();
    await this.reconnectRun(generation);
  }

  private async reconnectRun(generation: number): Promise<void> {
    const outcome = await this.driveStream(undefined, generation);
    if (!this.isCurrentRun(generation)) return;
    if (outcome === "completed") {
      await this.completeRun(generation);
    } else if (outcome === "disconnected") {
      this.dispatch({ type: "disconnected" });
    }
  }

  private async driveStream(
    initial: MiniLilacResultStream | undefined,
    generation: number,
  ): Promise<StreamOutcome> {
    if (!this.isCurrentRun(generation) && initial !== undefined) {
      await cancelTerminalStream(initial);
      return this.disposed ? "disposed" : "superseded";
    }
    let stream: MiniLilacResultStream | undefined = initial;
    const hadInitialStream = initial !== undefined;
    let reconnectAttempt = 0;
    let reconnectEntryId: string | undefined;

    for (;;) {
      if (stream !== undefined) {
        const outcome = await this.consume(stream, generation);
        if (outcome === "completed") return "completed";
        if (outcome === "disposed") return "disposed";
        if (outcome === "superseded") return "superseded";
        stream = undefined;
      }

      reconnectAttempt += 1;
      const reconnecting = {
        kind: "status",
        tone: "warning",
        text:
          reconnectAttempt === 1
            ? "connection lost; reconnecting"
            : `connection unavailable; retrying (${reconnectAttempt})`,
      } as const;
      if (hadInitialStream || reconnectAttempt > 1) {
        if (reconnectEntryId === undefined) reconnectEntryId = this.appendOutput(reconnecting);
        else this.updateOutput(reconnectEntryId, reconnecting);
      }
      if (reconnectAttempt > 1 || this.options.reconnectDelay !== undefined) {
        await this.waitForReconnect(reconnectAttempt);
      }
      if (!this.isCurrentRun(generation)) {
        return this.disposed ? "disposed" : "superseded";
      }

      const reconnect = await this.options.transport.reconnectToStreamResult({
        chatId: this.sessionId,
      });
      const reconnectError = reconnect.match({ ok: () => undefined, err: (error) => error });
      if (reconnectError !== undefined) {
        if (!this.isCurrentRun(generation)) {
          return this.disposed ? "disposed" : "superseded";
        }
        const unavailable = {
          kind: "status",
          tone: "warning",
          text: `connection unavailable; retrying (${reconnectAttempt}): ${errorMessage(reconnectError)}`,
        } as const;
        if (reconnectEntryId === undefined) reconnectEntryId = this.appendOutput(unavailable);
        else this.updateOutput(reconnectEntryId, unavailable);
        continue;
      }
      const reconnected = reconnect.match({ ok: (value) => value, err: () => undefined });
      if (reconnected === undefined) continue;
      if (!this.isCurrentRun(generation)) {
        if (reconnected !== null) await cancelTerminalStream(reconnected);
        return this.disposed ? "disposed" : "superseded";
      }
      // `null` means the run already finished server-side; treat as completion.
      if (reconnected === null) return "completed";
      stream = reconnected;
    }
  }

  private async waitForReconnect(attempt: number): Promise<void> {
    if (this.options.reconnectDelay !== undefined) {
      await this.options.reconnectDelay(attempt);
      return;
    }
    if (attempt <= 1) return;
    await Bun.sleep(Math.min(5_000, 250 * 2 ** Math.min(attempt - 2, 5)));
  }

  private async consume(stream: MiniLilacResultStream, generation: number): Promise<StreamOutcome> {
    if (!this.isCurrentRun(generation)) {
      await cancelTerminalStream(stream);
      return this.disposed ? "disposed" : "superseded";
    }
    const reader = stream.getReader();
    this.activeReader = reader;
    let terminalFinish = false;
    let outcome: StreamOutcome | undefined;
    for (;;) {
      const read = await readTerminalStream(reader);
      const streamRead = read.match({ ok: (value) => value, err: () => undefined });
      if (streamRead === undefined) {
        if (this.disposed) outcome = "disposed";
        else if (generation !== this.runGeneration) outcome = "superseded";
        else outcome = terminalFinish ? "completed" : "disconnected";
        break;
      }
      const { done, value } = streamRead;
      if (this.disposed) {
        outcome = "disposed";
        break;
      }
      if (generation !== this.runGeneration) {
        await cancelTerminalStream(reader);
        outcome = "superseded";
        break;
      }
      if (done) {
        outcome = terminalFinish ? "completed" : "disconnected";
        break;
      }
      const chunk = value.match({ ok: (chunkValue) => chunkValue, err: () => undefined });
      if (chunk === undefined) {
        outcome = terminalFinish ? "completed" : "disconnected";
        break;
      }
      const projected = projectMiniLilacStreamChunk(chunk, this.streamProjection);
      switch (projected.kind) {
        case "finish":
          terminalFinish = true;
          this.renderer.handleProjected({ kind: "rendered", chunk: projected.chunk });
          continue;
        case "cursor":
          this.admitRun(projected.cursor.runId);
          continue;
        case "steering":
          this.appendReplayedSteering(projected.message);
          continue;
        case "steering-committed":
          this.commitSteering(projected.message);
          continue;
        case "renderer":
          this.renderer.handleProjected(projected.chunk);
          continue;
      }
    }
    if (this.activeReader === reader) this.activeReader = undefined;
    const released = releaseTerminalStreamLock(reader);
    if (released.match({ ok: () => false, err: () => true }) && outcome === "completed") {
      return "disconnected";
    }
    return outcome;
  }

  private enqueueSteer(
    draftText: string,
    files: readonly DraftFile[],
    pastedTexts: readonly DraftPastedText[],
  ): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const controlGeneration = this.controlGeneration;
    const signal = this.controlAbortController.signal;
    const text = expandDraftText(draftText, files, pastedTexts);
    const message: MiniLilacUserUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: userParts(text, files),
    };
    const clientCommandId = crypto.randomUUID();
    this.pendingSteerCommandIds.add(clientCommandId);
    this.appendSteering(message);
    const removeOptimistic = () => {
      this.removeSteering(message.id);
    };
    const rollback = () => {
      removeOptimistic();
      this.restoreSubmittedDraft(draftText, files, pastedTexts, false, true);
    };
    this.pendingSteerOptimistic.set(clientCommandId, {
      messageId: message.id,
      remove: removeOptimistic,
    });
    this.steerChain = this.steerChain.then(async () => {
      const runId = await admission;
      if (runId === undefined || !this.isCurrentControl(generation, controlGeneration)) {
        rollback();
        this.pendingSteerOptimistic.delete(clientCommandId);
        this.pendingSteerCommandIds.delete(clientCommandId);
        return;
      }
      const request = { sessionId: this.sessionId, runId, message, clientCommandId };
      let steered = await this.options.transport.steerResult(request, { signal });
      if (
        steered.match({ ok: () => false, err: () => true }) &&
        this.isCurrentControl(generation, controlGeneration) &&
        !signal.aborted
      ) {
        steered = await this.options.transport.steerResult(request, { signal });
      }
      const steerError = steered.match({ ok: () => undefined, err: (error) => error });
      if (steerError !== undefined) {
        if (!this.isCurrentControl(generation, controlGeneration)) {
          this.pendingSteerCommandIds.delete(clientCommandId);
          return;
        }
        rollback();
        this.pendingSteerOptimistic.delete(clientCommandId);
        this.dispatch({ type: "steer-failed" });
        this.commitError(steerError);
      } else {
        this.pendingSteerOptimistic.delete(clientCommandId);
      }
      this.pendingSteerCommandIds.delete(clientCommandId);
    });
  }

  private enqueueInterrupt(): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const clientCommandId = crypto.randomUUID();
    const pendingSteerCommandIds = [...this.pendingSteerCommandIds];
    this.interruptSteerCommandIds.set(clientCommandId, pendingSteerCommandIds);
    const signal = this.abortPendingControls();
    void (async () => {
      const runId = await admission;
      if (runId === undefined || !this.isCurrentRun(generation)) return;
      const interrupted = await this.options.transport.interruptQueuedSteeringResult(
        { sessionId: this.sessionId, runId, clientCommandId, pendingSteerCommandIds },
        { signal },
      );
      const interruptError = interrupted.match({ ok: () => undefined, err: (error) => error });
      if (interruptError === undefined) {
        this.confirmInterrupt(clientCommandId);
        return;
      }
      if (!this.isCurrentRun(generation)) return;
      const commandIds = this.interruptSteerCommandIds.get(clientCommandId) ?? [];
      this.interruptSteerCommandIds.delete(clientCommandId);
      commandIds.forEach((commandId) => {
        if (this.pendingSteerOptimistic.has(commandId)) {
          this.pendingSteerCommandIds.add(commandId);
        }
      });
      this.commitError(interruptError);
    })();
  }

  private enqueueCancel(): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const clientCommandId = crypto.randomUUID();
    const pendingSteers = this.steerChain;
    void (async () => {
      let runId = await admission;
      if (!this.isCurrentRun(generation)) return;
      if (runId === undefined && this.state.phase === "disconnected") {
        const loaded = await this.options.transport.getSessionResult(this.sessionId, {
          signal: this.abortController.signal,
        });
        const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
        if (loadError !== undefined) {
          if (this.isCurrentRun(generation)) this.commitError(loadError);
          return;
        }
        const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
        if (snapshot === undefined) return;
        this.onSnapshot(snapshot);
        runId = snapshot.activeRunId ?? undefined;
      }
      if (runId === undefined) return;
      // Let already-queued steers dispatch, but do not wait for their HTTP responses.
      await Promise.race([pendingSteers, Bun.sleep(0)]);
      if (!this.isCurrentRun(generation)) return;
      // A fresh control generation aborts pending controls without touching the SSE stream.
      const signal = this.abortPendingControls();
      const cancelled = await this.options.transport.cancelResult(
        { sessionId: this.sessionId, runId, clientCommandId },
        { signal },
      );
      if (!this.isCurrentRun(generation)) return;
      const cancelError = cancelled.match({ ok: () => undefined, err: (error) => error });
      if (cancelError !== undefined) {
        this.commitError(cancelError);
        return;
      }
      if (this.state.phase === "disconnected") {
        await this.reconnectRun(generation);
      }
    })();
  }

  private onSnapshot(snapshot: MiniLilacSessionSnapshot): void {
    this.sessionExists = true;
    this.acceptSnapshot(snapshot);
    if (snapshot.activeRunId !== null) this.admitRun(snapshot.activeRunId);
    this.dispatch({ type: "steering-updated", queuedSteeringCount: snapshot.queuedSteeringCount });
  }

  private acceptSnapshot(snapshot: MiniLilacSessionSnapshot): void {
    this.historyStateId = snapshot.historyStateId;
    this.canUndo = snapshot.canUndo;
    this.canRedo = snapshot.canRedo;
    if (snapshot.status === "compacting") {
      this.compactionCommandId = snapshot.activeCompactionCommandId ?? undefined;
    }
    this.bindings = {
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    };
    this.presentation = sessionPresentation(snapshot);
    this.options.ui.onBindings?.(this.bindings);
    this.options.ui.onSession?.(this.presentation);
  }

  private onControl(result: MiniLilacControlResult): void {
    if (result.status === "queued") this.dispatch({ type: "steer-confirmed" });
    else if (result.clientCommandId) this.confirmInterrupt(result.clientCommandId);
  }

  private onTodos(todos: MiniLilacTodoState): void {
    if (todos.revision <= this.todos.revision) return;
    this.todos = todos;
    this.options.ui.onTodos?.(this.todos);
  }

  private admitRun(runId: string): void {
    this.activeRunId = runId;
    this.resolvePromptAdmission?.(runId);
    this.resolvePromptAdmission = undefined;
  }

  private onTranscriptReset(reset: MiniLilacTranscriptReset): void {
    const preservedSteering =
      reset.reason === "interrupt"
        ? this.messages
            .slice(this.runMessageBaseline)
            .filter((message): message is MiniLilacUserUIMessage => message.role === "user")
        : [];
    this.messages = [...this.messages.slice(0, this.runMessageBaseline), ...preservedSteering];
    if (reset.reason === "cancel") {
      this.clearSteering();
      this.pendingSteerOptimistic.clear();
      this.pendingSteerCommandIds.clear();
      this.interruptSteerCommandIds.clear();
    }
    this.output = [
      ...this.output.slice(0, this.runOutputBaseline),
      ...renderInitialMessages(preservedSteering),
    ];
    this.notifyOutput();
  }

  private onOutputRollback(rollback: MiniLilacOutputRollback): void {
    if (rollback.reason !== "cancel") return;
    this.clearSteering();
    this.pendingSteerOptimistic.clear();
    this.pendingSteerCommandIds.clear();
    this.interruptSteerCommandIds.clear();
  }

  private async runUndo(): Promise<void> {
    if (!this.sessionExists) {
      this.dispatch({ type: "operation-completed" });
      return;
    }
    const draftBefore = draftSnapshot(this.state);
    const draftGeneration = this.draftMutationGeneration;
    const clientCommandId = (this.pendingUndoCommandId ??= crypto.randomUUID());
    const request = { sessionId: this.sessionId, clientCommandId };
    let undone = await this.options.transport.undoResult(request, {
      signal: this.abortController.signal,
    });
    if (undone.match({ ok: () => false, err: () => true })) {
      undone = await this.options.transport.undoResult(request, {
        signal: this.abortController.signal,
      });
    }
    const undoError = undone.match({ ok: () => undefined, err: (error) => error });
    if (undoError !== undefined) {
      if (this.disposed) return;
      this.dispatch({ type: "operation-failed" });
      this.commitError(undoError);
      return;
    }
    const result = undone.match({ ok: (value) => value, err: () => undefined });
    if (result === undefined) return;

    if (this.disposed) return;
    if (result.status === "empty") {
      this.pendingUndoCommandId = undefined;
      this.canUndo = false;
      this.dispatch({ type: "operation-completed" });
      return;
    }
    const refresh = await this.refreshHistoryState(result.historyStateId);
    if (this.disposed) return;
    if (refresh.kind === "disposed") return;
    if (refresh.kind === "failed") {
      this.historyStateId = result.historyStateId;
      this.canUndo = undefined;
      this.canRedo = true;
      const removedIndex = this.messages.findIndex((message) => message.id === result.message.id);
      if (removedIndex >= 0) {
        this.messages = this.messages.slice(0, removedIndex);
        this.output = this.renderMessages();
        this.runOutputBaseline = this.output.length;
        this.runMessageBaseline = this.messages.length;
        this.notifyOutput();
      }
      this.commitError(
        `undo committed on server; transcript refresh failed: ${errorMessage(refresh.error)}`,
      );
    } else if (refresh.kind === "moved") {
      this.pendingUndoCommandId = undefined;
      this.undoDraftProvenance = [];
      this.finishHistoryRefresh(refresh.snapshot);
      this.reportMovedHistory();
      return;
    }

    const draftAfter = this.restoreDraft(result.message, true, true);
    if (this.draftMutationGeneration === draftGeneration) {
      this.undoDraftProvenance.push({ before: draftBefore, after: draftAfter });
    }
    this.reportSkippedFilesystem("undone", result.filesystem);
    this.pendingUndoCommandId = undefined;
    this.pendingRedoCommandId = undefined;
  }

  private async runRedo(): Promise<void> {
    if (!this.sessionExists) {
      this.dispatch({ type: "operation-completed" });
      return;
    }
    const clientCommandId = (this.pendingRedoCommandId ??= crypto.randomUUID());
    const request = { sessionId: this.sessionId, clientCommandId };
    let redone = await this.options.transport.redoResult(request, {
      signal: this.abortController.signal,
    });
    if (redone.match({ ok: () => false, err: () => true })) {
      redone = await this.options.transport.redoResult(request, {
        signal: this.abortController.signal,
      });
    }
    const redoError = redone.match({ ok: () => undefined, err: (error) => error });
    if (redoError !== undefined) {
      if (this.disposed) return;
      this.dispatch({ type: "operation-failed" });
      this.commitError(redoError);
      return;
    }
    const result = redone.match({ ok: (value) => value, err: () => undefined });
    if (result === undefined) return;

    if (this.disposed) return;
    if (result.status === "empty") {
      this.pendingRedoCommandId = undefined;
      this.canRedo = false;
      this.dispatch({ type: "operation-completed" });
      return;
    }
    const refresh = await this.refreshHistoryState(result.historyStateId);
    if (this.disposed) return;
    if (refresh.kind === "disposed") return;
    if (refresh.kind === "failed") {
      this.historyStateId = result.historyStateId;
      this.canUndo = true;
      this.canRedo = undefined;
      this.undoDraftProvenance = [];
      this.dispatch({ type: "operation-completed" });
      const skipped = skippedFilesystemReason(result.filesystem);
      this.options.ui.onNotice?.(
        `Redo committed; transcript refresh required: ${errorMessage(refresh.error)}${
          skipped === undefined ? "" : `. Managed worktree unchanged because ${skipped}.`
        }`,
        "warning",
      );
      this.pendingRedoCommandId = undefined;
      return;
    }
    if (refresh.kind === "moved") {
      this.pendingRedoCommandId = undefined;
      this.undoDraftProvenance = [];
      this.finishHistoryRefresh(refresh.snapshot);
      this.reportMovedHistory();
      return;
    }

    const provenance = this.undoDraftProvenance.pop();
    if (provenance !== undefined && draftMatches(this.state, provenance.after)) {
      this.dispatch({
        type: "draft-restored",
        text: provenance.before.editor,
        files: provenance.before.files,
        pastedTexts: provenance.before.pastedTexts,
        finishOperation: true,
      });
    } else this.finishHistoryRefresh(refresh.snapshot);
    this.reportSkippedFilesystem("redone", result.filesystem);
    this.pendingRedoCommandId = undefined;
    this.pendingUndoCommandId = undefined;
  }

  private async refreshHistoryState(
    expectedHistoryStateId: string,
  ): Promise<
    | { readonly kind: "matched"; readonly snapshot: MiniLilacSessionSnapshot }
    | { readonly kind: "moved"; readonly snapshot: MiniLilacSessionSnapshot }
    | { readonly kind: "failed"; readonly error: MiniLilacRequestError }
    | { readonly kind: "disposed" }
  > {
    const loaded = await this.options.transport.getSessionResumeResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
    if (loadError !== undefined) return { kind: "failed", error: loadError };
    if (this.disposed) return { kind: "disposed" };
    const resume = loaded.match({ ok: (value) => value, err: () => undefined });
    if (resume === undefined) return { kind: "disposed" };
    this.sessionExists = true;
    this.acceptSnapshot(resume.snapshot);
    this.replaceMessages(resume.messages);
    this.options.transport.setReconnectCursor(this.sessionId, resume.replayCursor);
    this.onTodos(resume.todos);
    const quiescent =
      resume.snapshot.activeRunId === null &&
      (resume.snapshot.status === "idle" || resume.snapshot.status === "error");
    return resume.snapshot.historyStateId === expectedHistoryStateId && quiescent
      ? { kind: "matched", snapshot: resume.snapshot }
      : { kind: "moved", snapshot: resume.snapshot };
  }

  private finishHistoryRefresh(snapshot: MiniLilacSessionSnapshot): void {
    if (!this.followSnapshotActivity(snapshot)) this.dispatch({ type: "operation-completed" });
  }

  private reportMovedHistory(): void {
    this.options.ui.onNotice?.("History changed again; showing latest server state.", "warning");
  }

  private reportSkippedFilesystem(
    action: "undone" | "redone",
    filesystem: MiniLilacHistoryFilesystemResult,
  ): void {
    const reason = skippedFilesystemReason(filesystem);
    if (reason === undefined) return;
    this.options.ui.onNotice?.(
      `Transcript ${action}; managed worktree unchanged because ${reason}.`,
      "warning",
    );
  }

  private async runCompact(): Promise<void> {
    if (!this.sessionExists) {
      this.dispatch({ type: "operation-completed" });
      return;
    }

    // One entry, updated in place: a line per progress chunk would bury the
    // transcript under the very operation meant to shrink it.
    let entryId: string | undefined;
    // Whether the server already told us how this ended. If it did, the promise
    // rejection that follows is that same event, not a second thing to report.
    let terminated = false;
    // Cancellation must wait for the server to acknowledge the operation, so
    // the admission gate opens on the first lifecycle event (or on failure).
    this.compactionAdmission = new Promise((resolve) => {
      this.resolveCompactionAdmission = resolve;
    });
    const clientCommandId = crypto.randomUUID();
    this.compactionCommandId = clientCommandId;
    const compacted = await this.options.transport.compactResult(
      { sessionId: this.sessionId, clientCommandId },
      {
        // Only unsubscribes on teardown. Detaching does not cancel: the
        // compaction keeps running and commits server-side either way.
        signal: this.abortController.signal,
        onEvent: (event) => {
          this.openCompactionAdmissionGate();
          if (this.disposed) return;
          if (event.phase !== "started" && event.phase !== "progress") terminated = true;
          if (entryId === undefined) entryId = this.appendOutput(compactionEntry(event));
          else this.updateOutput(entryId, compactionEntry(event));
        },
        onSession: (snapshot) => {
          if (!this.disposed) this.acceptSnapshot(snapshot);
        },
      },
    );
    this.openCompactionAdmissionGate();
    const compactError = compacted.match({ ok: () => undefined, err: (error) => error });
    if (compactError !== undefined) {
      const error = compactError;
      this.openCompactionAdmissionGate();
      if (this.disposed) return;
      if (terminated) {
        // The terminal event already rendered on the entry; this rejection is
        // the same news, not a second thing to report.
        this.compactionCommandId = undefined;
        if (!(await this.followLatestSessionActivity())) {
          this.dispatch({ type: "operation-failed" });
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (entryId === undefined && message.includes("MiniLilac request failed")) {
        // The server refused the request outright; nothing was admitted and
        // there is nothing to keep following.
        this.compactionCommandId = undefined;
        if (!(await this.followLatestSessionActivity())) {
          this.dispatch({ type: "operation-failed" });
        }
        this.commitError(error);
        return;
      }
      // The stream broke before any terminal event, so the compaction is not
      // known to have failed — it is only out of view. Keep representing it
      // and follow the session until the server reports how it ended.
      if (entryId !== undefined) this.removeOutput(entryId);
      this.appendOutput({
        kind: "status",
        tone: "warning",
        text: `compaction stream interrupted (${message}); it continues server-side`,
      });
      await this.watchDetachedCompaction();
      return;
    }
    const result: MiniLilacCompactResult | undefined = compacted.match({
      ok: (value) => value,
      err: () => undefined,
    });
    if (result === undefined) return;

    if (this.disposed) return;
    this.compactionCommandId = undefined;
    if (result.status !== "compacted") {
      if (!(await this.followLatestSessionActivity())) {
        this.dispatch({ type: "operation-completed" });
      }
      return;
    }

    // Compaction is committed from here on. A failure below is a failure to
    // refresh the local view, not a failed compaction, and must not be reported
    // as one.
    const loadedMessages = await this.options.transport.getMessagesResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    if (this.disposed) return;
    const messagesError = loadedMessages.match({ ok: () => undefined, err: (error) => error });
    if (messagesError !== undefined) {
      if (!(await this.followLatestSessionActivity()))
        this.dispatch({ type: "operation-completed" });
      this.appendOutput({
        kind: "status",
        tone: "warning",
        text: `context compacted, but refreshing the transcript failed: ${errorMessage(messagesError)}`,
      });
      return;
    }
    // The server persists its own compaction entry, so the live one would
    // otherwise be shown twice after the transcript is replaced.
    const liveEntryId = entryId;
    entryId = undefined;
    const messages = loadedMessages.match({ ok: (value) => value, err: () => undefined });
    if (messages === undefined) return;
    this.replaceMessages(messages);
    if (liveEntryId !== undefined) this.removeOutput(liveEntryId);
    const loadedSnapshot = await this.options.transport.getSessionResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    if (this.disposed) return;
    const snapshotError = loadedSnapshot.match({ ok: () => undefined, err: (error) => error });
    if (snapshotError !== undefined) {
      if (!(await this.followLatestSessionActivity()))
        this.dispatch({ type: "operation-completed" });
      this.appendOutput({
        kind: "status",
        tone: "warning",
        text: `context compacted, but refreshing the transcript failed: ${errorMessage(snapshotError)}`,
      });
      return;
    }
    const snapshot = loadedSnapshot.match({ ok: (value) => value, err: () => undefined });
    if (snapshot === undefined) return;
    this.acceptSnapshot(snapshot);
    if (!this.followSnapshotActivity(snapshot)) {
      this.dispatch({ type: "operation-completed" });
    }
  }

  /**
   * Ask the server to stop compacting.
   *
   * Compaction outlives the request that started it, so abandoning that request
   * would only detach this client. The terminal `cancelled` event arrives on the
   * still-open stream and updates the live entry.
   */
  private cancelCompaction(): void {
    // Captured at `esc` time: if a successor compaction is admitted while this
    // cancel is in flight, the server answers `inactive` for the old target
    // instead of stopping the newer operation.
    const observedCommandId = this.compactionCommandId;
    void (async () => {
      // `esc` can beat the compact POST to the server. A cancel that arrives
      // before admission answers `inactive`, and the compaction then proceeds
      // despite the user's request — so wait for the acknowledged admission.
      await this.compactionAdmission;
      if (this.disposed) return;
      let clientCommandId = observedCommandId;
      if (clientCommandId === undefined) {
        const loaded = await this.options.transport.getSessionResult(this.sessionId, {
          signal: this.abortController.signal,
        });
        if (this.disposed) return;
        const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
        if (loadError !== undefined) {
          this.commitError(loadError);
          return;
        }
        const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
        if (snapshot === undefined) return;
        this.acceptSnapshot(snapshot);
        if (snapshot.status !== "compacting" || snapshot.activeCompactionCommandId == null) return;
        clientCommandId = snapshot.activeCompactionCommandId;
      }
      const cancelled = await this.options.transport.cancelCompactionResult(
        { sessionId: this.sessionId, clientCommandId },
        { signal: this.abortController.signal },
      );
      const cancelError = cancelled.match({ ok: () => undefined, err: (error) => error });
      if (cancelError !== undefined) {
        if (!this.disposed) this.commitError(cancelError);
        return;
      }
      const result = cancelled.match({ ok: (value) => value, err: () => undefined });
      if (result === undefined) return;
      if (result.status === "inactive" && this.state.phase === "compacting") {
        await this.followLatestSessionActivity();
      }
    })();
  }

  /** Open the gate that `esc` cancellation waits behind. */
  private openCompactionAdmissionGate(): void {
    this.resolveCompactionAdmission?.();
    this.resolveCompactionAdmission = undefined;
  }

  /**
   * Follow a server-side compaction this client is not attached to.
   *
   * Live progress cannot be re-joined once detached, so the session is polled
   * until its status leaves `compacting`, then the transcript and snapshot are
   * refreshed — the committed compaction entry (if any) arrives with them. The
   * input stays in the `compacting` phase throughout, keeping `esc cancel`
   * reachable and operations the server would reject unavailable.
   */
  private async watchDetachedCompaction(): Promise<void> {
    if (this.watchingDetachedCompaction) return;
    this.watchingDetachedCompaction = true;
    using _detachedCompactionWatch = {
      [Symbol.dispose]: () => void (this.watchingDetachedCompaction = false),
    };
    this.dispatch({ type: "compaction-observed" });
    const wait =
      this.options.compactionWatchDelay ?? (() => Bun.sleep(COMPACTION_WATCH_INTERVAL_MS));
    for (;;) {
      let terminal: MiniLilacSessionSnapshot | undefined;
      // Follow one compaction generation to a non-compacting snapshot.
      for (;;) {
        if (this.disposed) return;
        const loaded = await this.options.transport.getSessionResult(this.sessionId, {
          signal: this.abortController.signal,
        });
        const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
        if (snapshot === undefined) {
          // Transient: the outcome is still unknown, so keep watching.
          if (this.disposed) return;
        } else {
          if (this.disposed) return;
          this.acceptSnapshot(snapshot);
          if (snapshot.status !== "compacting") {
            this.compactionCommandId = undefined;
            terminal = snapshot;
            break;
          }
        }
        await wait();
      }

      const loadedMessages = await this.options.transport.getMessagesResult(this.sessionId, {
        signal: this.abortController.signal,
      });
      const messagesError = loadedMessages.match({
        ok: () => undefined,
        err: (error) => error,
      });
      if (messagesError !== undefined) {
        if (this.disposed) return;
        this.appendOutput({
          kind: "status",
          tone: "warning",
          text: `compaction ended, but refreshing the transcript failed: ${errorMessage(messagesError)}`,
        });
      } else {
        if (this.disposed) return;
        const messages = loadedMessages.match({ ok: (value) => value, err: () => undefined });
        if (messages !== undefined) this.replaceMessages(messages);
      }

      if (terminal !== undefined) {
        const refreshed = await this.options.transport.getSessionResult(this.sessionId, {
          signal: this.abortController.signal,
        });
        const snapshot = refreshed.match({ ok: (value) => value, err: () => undefined });
        if (snapshot !== undefined) {
          terminal = snapshot;
          if (this.disposed) return;
          this.acceptSnapshot(terminal);
        }
      }
      // A successor compaction may begin while its predecessor's transcript is
      // being refreshed. Continue in this watcher instead of recursively
      // calling a watcher that the reentrancy guard would discard.
      if (terminal?.status === "compacting") continue;
      if (terminal !== undefined && this.followSnapshotActivity(terminal)) return;
      this.dispatch({ type: "operation-completed" });
      return;
    }
  }

  /** Keep editor controls aligned with server-side work observed in a snapshot. */
  private followSnapshotActivity(snapshot: MiniLilacSessionSnapshot): boolean {
    if (snapshot.status === "compacting") {
      this.compactionCommandId = snapshot.activeCompactionCommandId ?? undefined;
      void this.watchDetachedCompaction();
      return true;
    }
    this.compactionCommandId = undefined;
    if (
      (snapshot.status === "streaming" || snapshot.status === "cancelling") &&
      snapshot.activeRunId !== null
    ) {
      // Another client started a run as compaction ended. Adopt its identity so
      // steering and Escape target that run rather than a stale admission.
      this.activeRunId = snapshot.activeRunId;
      this.promptAdmission = Promise.resolve(snapshot.activeRunId);
      this.dispatch({ type: "agent-started" });
      this.dispatch({
        type: "steering-updated",
        queuedSteeringCount: snapshot.queuedSteeringCount,
      });
      void this.resumeActiveSession();
      return true;
    }
    return false;
  }

  /** Refresh server activity after a terminal/refused operation before idling. */
  private async followLatestSessionActivity(): Promise<boolean> {
    const loaded = await this.options.transport.getSessionResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    if (this.disposed) return false;
    const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
    if (snapshot === undefined) return false;
    this.acceptSnapshot(snapshot);
    return this.followSnapshotActivity(snapshot);
  }

  private async completeRun(generation: number): Promise<void> {
    await this.reconcile(generation);
    if (!this.isCurrentRun(generation)) return;
    this.clearSteering();
    const completedRunId = this.activeRunId;
    this.activeRunId = undefined;
    const loaded = await this.options.transport.getSessionResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    const snapshot = loaded.match({ ok: (value) => value, err: () => undefined });
    if (snapshot !== undefined) {
      if (!this.isCurrentRun(generation)) return;
      this.acceptSnapshot(snapshot);
      if (snapshot.status === "compacting") {
        // This run is over, so leave active before the compaction watcher asks
        // the reducer to enter its distinct busy phase.
        this.dispatch({ type: "agent-stopped" });
        this.followSnapshotActivity(snapshot);
        return;
      }
      const stillReportsCompletedRun =
        (snapshot.status === "streaming" || snapshot.status === "cancelling") &&
        snapshot.activeRunId === completedRunId;
      if (!stillReportsCompletedRun && this.followSnapshotActivity(snapshot)) return;
    }
    this.dispatch({ type: "agent-stopped" });
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.isCurrentRun(generation)) return;
    const loaded = await this.options.transport.getMessagesResult(this.sessionId, {
      signal: this.abortController.signal,
    });
    if (!this.isCurrentRun(generation)) return;
    const messages = loaded.match({ ok: (value) => value, err: () => undefined });
    if (messages === undefined) return;
    this.replaceMessages(messages);
  }

  private replaceMessages(messages: readonly MiniLilacUIMessage[]): void {
    this.messages = [...messages];
    const messageIds = new Set(messages.map((message) => message.id));
    this.steering = this.steering.filter((message) => !messageIds.has(message.id));
    this.output = this.renderMessages();
    this.runOutputBaseline = this.output.length;
    this.runMessageBaseline = this.messages.length;
    this.notifyOutput();
    this.notifySteering();
  }

  private renderMessages(): TranscriptEntry[] {
    return renderInitialMessages(this.messages, {
      cwd: this.options.cwd ?? this.options.initialSnapshot?.cwd,
    });
  }

  private appendOutput(entry: Omit<TranscriptEntry, "id">): string {
    const id = `output:${this.outputSequence}`;
    this.outputSequence += 1;
    this.output = [...this.output, { id, ...entry }];
    this.notifyOutput();
    return id;
  }

  private appendOutputText(id: string, delta: string): void {
    this.output = this.output.map((entry) =>
      entry.id === id ? { ...entry, text: entry.text + delta } : entry,
    );
    this.notifyOutput();
  }

  private finishOutput(id: string): void {
    this.output = this.output.map((entry) =>
      entry.id === id ? { ...entry, streaming: false } : entry,
    );
    this.notifyOutput();
  }

  private updateOutput(id: string, entry: Omit<TranscriptEntry, "id">): void {
    this.output = this.output.map((candidate) =>
      candidate.id === id ? { id: candidate.id, ...entry } : candidate,
    );
    this.notifyOutput();
  }

  private removeOutput(id: string): void {
    this.output = this.output.filter((entry) => entry.id !== id);
    this.notifyOutput();
  }

  private appendUserOutput(text: string, files: readonly DraftFile[]): string[] {
    const ids: string[] = [];
    if (text.length > 0) ids.push(this.appendOutput({ kind: "user", tone: "accent", text }));
    files.forEach((file) => {
      ids.push(
        this.appendOutput({
          kind: "file",
          tone: "muted",
          text: file.file.filename ? `Image: ${file.file.filename}` : "Image attached",
        }),
      );
    });
    return ids;
  }

  private appendReplayedSteering(message: MiniLilacUserUIMessage): void {
    for (const [commandId, pending] of this.pendingSteerOptimistic) {
      if (pending.messageId !== message.id) continue;
      this.pendingSteerOptimistic.delete(commandId);
      this.pendingSteerCommandIds.delete(commandId);
      break;
    }
    this.appendSteering(message);
  }

  private appendSteering(message: MiniLilacUserUIMessage): void {
    if (
      this.messages.some((candidate) => candidate.id === message.id) ||
      this.steering.some((candidate) => candidate.id === message.id)
    ) {
      return;
    }
    this.steering = [...this.steering, message];
    this.notifySteering();
  }

  private commitSteering(message: MiniLilacUserUIMessage): void {
    this.removeSteering(message.id);
    for (const [commandId, pending] of this.pendingSteerOptimistic) {
      if (pending.messageId !== message.id) continue;
      this.pendingSteerOptimistic.delete(commandId);
      this.pendingSteerCommandIds.delete(commandId);
      break;
    }
    if (this.messages.some((candidate) => candidate.id === message.id)) return;
    this.messages.push(message);
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) this.appendOutput({ kind: "user", tone: "accent", text });
    message.parts
      .filter((part) => part.type === "file")
      .forEach((file) =>
        this.appendOutput({
          kind: "file",
          tone: "muted",
          text: file.filename ? `Image: ${file.filename}` : "Image attached",
        }),
      );
  }

  private removeSteering(messageId: string): void {
    const next = this.steering.filter((message) => message.id !== messageId);
    if (next.length === this.steering.length) return;
    this.steering = next;
    this.notifySteering();
  }

  private clearSteering(): void {
    if (this.steering.length === 0) return;
    this.steering = [];
    this.notifySteering();
  }

  private confirmInterrupt(clientCommandId: string): void {
    const commandIds = this.interruptSteerCommandIds.get(clientCommandId);
    if (!commandIds) return;
    commandIds.forEach((commandId) => {
      const pending = this.pendingSteerOptimistic.get(commandId);
      pending?.remove();
      if (pending !== undefined) this.dispatch({ type: "steer-failed" });
      this.pendingSteerOptimistic.delete(commandId);
      this.pendingSteerCommandIds.delete(commandId);
    });
    this.interruptSteerCommandIds.delete(clientCommandId);
  }

  private restoreDraft(
    message: MiniLilacUserUIMessage,
    finishOperation = false,
    preserveCurrent = false,
  ): DraftSnapshot {
    const restoredText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    let restoredEditor = restoredText;
    const restoredFiles = message.parts
      .filter((part) => part.type === "file")
      .map(
        (file, index): DraftFile => ({
          id: crypto.randomUUID(),
          placeholder: `[Image ${index + 1}]`,
          start: 0,
          end: 0,
          file,
        }),
      )
      .map((file) => {
        let separator = "";
        if (restoredEditor.length > 0) separator = restoredText.length > 0 ? "\n" : " ";
        restoredEditor += separator;
        const start = editorOffsetWidth(restoredEditor);
        restoredEditor += file.placeholder;
        return { ...file, start, end: start + editorOffsetWidth(file.placeholder) };
      });
    const current = this.state;
    const text =
      preserveCurrent && current.editor.length > 0
        ? [restoredEditor, current.editor].filter(Boolean).join("\n")
        : restoredEditor;
    const currentOffset = restoredEditor.length > 0 ? editorOffsetWidth(`${restoredEditor}\n`) : 0;
    const files = preserveCurrent
      ? [
          ...restoredFiles,
          ...current.files.map(
            (file): DraftFile => ({
              ...file,
              start: file.start + currentOffset,
              end: file.end + currentOffset,
            }),
          ),
        ]
      : restoredFiles;
    const pastedTexts = preserveCurrent
      ? current.pastedTexts.map(
          (part): DraftPastedText => ({
            ...part,
            start: part.start + currentOffset,
            end: part.end + currentOffset,
          }),
        )
      : [];
    this.dispatch({ type: "draft-restored", text, files, pastedTexts, finishOperation });
    return { editor: text, files, pastedTexts };
  }

  private restoreSubmittedDraft(
    submittedText: string,
    submittedFiles: readonly DraftFile[],
    submittedPastedTexts: readonly DraftPastedText[],
    finishOperation: boolean,
    preserveCurrent: boolean,
  ): void {
    const current = this.state;
    const text =
      preserveCurrent && current.editor.length > 0
        ? [submittedText, current.editor].filter(Boolean).join("\n")
        : submittedText;
    const currentOffset = submittedText.length > 0 ? editorOffsetWidth(`${submittedText}\n`) : 0;
    this.dispatch({
      type: "draft-restored",
      text,
      files: preserveCurrent
        ? [
            ...submittedFiles,
            ...current.files.map(
              (file): DraftFile => ({
                ...file,
                start: file.start + currentOffset,
                end: file.end + currentOffset,
              }),
            ),
          ]
        : submittedFiles,
      pastedTexts: preserveCurrent
        ? [
            ...submittedPastedTexts,
            ...current.pastedTexts.map(
              (part): DraftPastedText => ({
                ...part,
                start: part.start + currentOffset,
                end: part.end + currentOffset,
              }),
            ),
          ]
        : submittedPastedTexts,
      finishOperation,
    });
  }

  private commitError(error: ControllerFailure | string): void {
    this.appendOutput({
      kind: "error",
      tone: "danger",
      text: typeof error === "string" ? error : errorMessage(error),
    });
  }

  private beginRun(): void {
    this.renderer.startRun();
    this.streamProjection.reset();
  }

  private onPromptAdmitted(): void {
    this.pendingUndoCommandId = undefined;
    this.pendingRedoCommandId = undefined;
    this.undoDraftProvenance = [];
    this.canRedo = false;
  }

  private invalidateDraftProvenance(): void {
    this.draftMutationGeneration += 1;
    this.undoDraftProvenance = [];
  }

  private nextRunGeneration(): number {
    this.abortPendingControls();
    this.runGeneration += 1;
    return this.runGeneration;
  }

  private abortPendingControls(): AbortSignal {
    this.controlAbortController.abort();
    this.controlAbortController = new AbortController();
    this.controlGeneration += 1;
    this.steerChain = Promise.resolve();
    return this.controlAbortController.signal;
  }

  private isCurrentControl(generation: number, controlGeneration: number): boolean {
    return this.isCurrentRun(generation) && controlGeneration === this.controlGeneration;
  }

  private isCurrentRun(generation: number): boolean {
    return !this.disposed && generation === this.runGeneration;
  }

  private notifyState(): void {
    if (!this.disposed) this.options.ui.onState(this.state);
  }

  private notifyOutput(): void {
    if (!this.disposed) this.options.ui.onOutput(this.output);
  }

  private notifySteering(): void {
    if (!this.disposed) this.options.ui.onSteering?.(this.steering);
  }
}

function userParts(text: string, files: readonly DraftFile[]): MiniLilacUserUIMessage["parts"] {
  const fileParts = files.map((file) => file.file);
  if (text.length > 0) return [{ type: "text", text }, ...fileParts];
  const [first, ...rest] = fileParts;
  return first === undefined ? [] : [first, ...rest];
}

export function expandDraftText(
  text: string,
  files: readonly DraftFile[],
  pastedTexts: readonly DraftPastedText[],
): string {
  const replacements = [
    ...pastedTexts.map((part) => ({ ...part, replacement: part.text })),
    ...files.map((part) => ({ ...part, replacement: "" })),
  ].sort((left, right) => right.start - left.start);
  return replacements
    .reduce((expanded, part) => {
      const start = editorOffsetIndex(expanded, part.start);
      const end = editorOffsetIndex(expanded, part.end);
      return `${expanded.slice(0, start)}${part.replacement}${expanded.slice(end)}`;
    }, text)
    .trim();
}

function sessionBindingUpdateMatches(
  snapshot: MiniLilacSessionSnapshot,
  update: SessionBindingUpdate,
): boolean {
  if (update.model !== undefined && snapshot.model !== update.model) return false;
  if (update.profile !== undefined && snapshot.profile !== update.profile) return false;
  if (update.reasoning !== undefined && snapshot.reasoning !== update.reasoning) return false;
  return true;
}

function draftSnapshot(state: InputState): DraftSnapshot {
  return {
    editor: state.editor,
    files: state.files,
    pastedTexts: state.pastedTexts,
  };
}

function draftMatches(state: InputState, snapshot: DraftSnapshot): boolean {
  return (
    state.editor === snapshot.editor &&
    draftPartsEqual(state.files, snapshot.files) &&
    draftPartsEqual(state.pastedTexts, snapshot.pastedTexts)
  );
}

function draftPartsEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function skippedFilesystemReason(filesystem: MiniLilacHistoryFilesystemResult): string | undefined {
  if (filesystem.status !== "skipped") return undefined;
  if (filesystem.reason === "non-git-workspace") return undefined;
  if (filesystem.reason === "git-unavailable") return "Git is unavailable";
  if (filesystem.reason === "snapshot-unavailable") return "no worktree snapshot is available";
  return "worktree restore is unsupported on this platform";
}
