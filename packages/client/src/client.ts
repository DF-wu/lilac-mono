import { Result } from "better-result";
import { ORPCError } from "@orpc/client";
import type {
  BootstrapInput,
  BootstrapReply,
  CatalogEvent,
  NativeInput,
  NativeInputReceipt,
  NativeThread,
  ReplayCheckpoint,
  ThreadEvent,
} from "@stanley2058/lilac-client-protocol";
import { type CacheScope, type NativeCache, NoNativeCache } from "./cache.ts";
import { DisplayCatalogCache } from "./catalog.ts";
import { NativeThreadStore } from "./thread-store.ts";
import { createNativeRPC, reconnectDelay, type NativeRPC } from "./transport.ts";

export type ClientFailure = {
  kind: "auth" | "forbidden" | "conflict" | "network" | "rejected";
  message: string;
};
export type CommandOutcome =
  | { kind: "accepted"; receipt: NativeInputReceipt }
  | { kind: "uncertain"; commandId: string }
  | { kind: "rejected"; error: ClientFailure };
export type ClientEvent =
  | { kind: "connection"; state: "connecting" | "online" | "offline" | "logged-out" }
  | { kind: "bootstrap"; bootstrap: BootstrapReply }
  | { kind: "thread"; thread: NativeThread }
  | { kind: "removed"; threadId: string }
  | { kind: "input"; threadId: string; receipt: NativeInputReceipt }
  | { kind: "catalog" }
  | { kind: "checkpoint"; threadId: string; checkpoint: ReplayCheckpoint }
  | { kind: "error"; error: ClientFailure };
export type NativeClientOptions = {
  scope: CacheScope;
  openSocket: () => WebSocket;
  bootstrap: (input: BootstrapInput, signal: AbortSignal) => Promise<BootstrapReply>;
  cache?: NativeCache;
  catalogs?: DisplayCatalogCache;
  onEvent?: (event: ClientEvent) => void;
};

function captureFailure(error: unknown): ClientFailure {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
      case "UNAUTHORIZED":
        return { kind: "auth", message: error.message };
      case "FORBIDDEN":
        return { kind: "forbidden", message: error.message };
      case "CONFLICT":
        return { kind: "conflict", message: error.message };
      case "INVALID_INPUT":
      case "NOT_FOUND":
        return { kind: "rejected", message: error.message };
      default:
        return { kind: "network", message: error.message };
    }
  }
  return { kind: "network", message: error instanceof Error ? error.message : "Connection failed" };
}

export const MAX_INACTIVE_THREAD_STORES = 8;

export class NativeClient {
  private readonly stores = new Map<string, NativeThreadStore>();
  private readonly cache: NativeCache;
  readonly catalogs: DisplayCatalogCache;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private readonly streams = new Map<string, AbortController>();
  private readonly streamTasks = new Set<Promise<void>>();
  private readonly historyRequests = new Map<
    string,
    { threadId: string; controller: AbortController }
  >();
  private readonly cacheWrites = new Map<string, Promise<void>>();
  private socket: WebSocket | undefined;
  private connection: NativeRPC | undefined;
  private lifetime = new AbortController();
  private stopped = false;
  private generation = 0;
  private readonly threadEpochs = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedThreadId: string | undefined;
  private catalogCursor: string | undefined;
  private readonly pending = new Map<string, NativeInput>();
  private readonly receipts = new Map<
    string,
    { input: NativeInput; receipt: NativeInputReceipt }
  >();
  private bootstrapSequence = 0;
  private bootstrapPending = true;

  constructor(private readonly options: NativeClientOptions) {
    this.cache = options.cache ?? new NoNativeCache();
    this.catalogs = options.catalogs ?? new DisplayCatalogCache();
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  get rpc(): NativeRPC | undefined {
    return this.connection;
  }
  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  thread(threadId: string): NativeThreadStore {
    const existing = this.stores.get(threadId);
    if (existing) {
      this.stores.delete(threadId);
      this.stores.set(threadId, existing);
      return existing;
    }
    const store = new NativeThreadStore(() => this.trimStores());
    store.subscribe(({ patch }) => {
      if (!patch || this.stopped || this.stores.get(threadId) !== store) return;
      this.emit({ kind: "checkpoint", threadId, checkpoint: patch.checkpoint });
      const previous = this.cacheWrites.get(threadId) ?? Promise.resolve();
      const write = previous.then(() => this.persist(threadId, patch));
      this.cacheWrites.set(threadId, write);
      void write.then(() => {
        if (this.cacheWrites.get(threadId) === write) this.cacheWrites.delete(threadId);
      });
    });
    this.stores.set(threadId, store);
    this.trimStores(threadId);
    return store;
  }
  private trimStores(requestedThreadId?: string): void {
    const limit = this.cache instanceof NoNativeCache ? 0 : MAX_INACTIVE_THREAD_STORES;
    const inactive: string[] = [];
    for (const [threadId, store] of this.stores) {
      if (
        threadId === this.selectedThreadId ||
        this.streams.has(threadId) ||
        store.observerCount > 1
      )
        continue;
      inactive.push(threadId);
    }
    let excess = inactive.length - limit;
    for (const threadId of inactive) {
      if (excess <= 0) return;
      if (threadId === requestedThreadId) continue;
      this.stores.delete(threadId);
      excess--;
    }
  }
  private async persist(
    threadId: string,
    patch: Parameters<NativeCache["commit"]>[2],
  ): Promise<void> {
    const captured = await Result.tryPromise({
      try: () => this.cache.commit(this.options.scope, threadId, patch),
      catch: captureFailure,
    });
    captured.match({ ok: () => {}, err: (error) => this.emit({ kind: "error", error }) });
  }
  async loadCached(threadId: string): Promise<void> {
    if (this.threadEpochs.has(threadId)) return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    await this.cacheWrites.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.cache.read(this.options.scope, threadId),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (value) => {
        if (value) this.thread(threadId).restore(value);
      },
      err: () => {},
    });
  }
  async start(selectedThreadId?: string): Promise<void> {
    this.selectedThreadId = selectedThreadId ?? this.selectedThreadId;
    this.bootstrapPending = true;
    this.stopped = false;
    this.lifetime = new AbortController();
    this.open();
    if (this.selectedThreadId && !this.thread(this.selectedThreadId).checkpoint)
      await this.loadCached(this.selectedThreadId);
    await this.bootstrap();
  }
  private open(): void {
    if (this.stopped) return;
    this.emit({ kind: "connection", state: "connecting" });
    const socket = this.options.openSocket();
    this.socket = socket;
    this.connection = createNativeRPC(socket);
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.emit({ kind: "connection", state: "online" });
    });
    if (socket.readyState === WebSocket.OPEN) {
      this.attempt = 0;
      this.emit({ kind: "connection", state: "online" });
    }
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.stopped) return;
      this.emit({ kind: "connection", state: "offline" });
      this.streams.clear();
      this.connection = undefined;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(
        () => {
          this.open();
          void this.bootstrap();
        },
        reconnectDelay(this.attempt++),
      );
    });
  }
  private async bootstrap(): Promise<void> {
    clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = undefined;
    this.bootstrapPending = true;
    const sequence = ++this.bootstrapSequence;
    const generation = this.generation;
    const threadId = this.selectedThreadId;
    const threadEpoch = threadId ? this.threadEpochs.get(threadId) : undefined;
    const input: BootstrapInput = {
      threadId,
      checkpoint: threadId ? this.thread(threadId).checkpoint : undefined,
      catalogRevision: this.catalogs.get(this.options.scope)?.revision,
    };
    const captured = await Result.tryPromise({
      try: () => this.options.bootstrap(input, this.lifetime.signal),
      catch: captureFailure,
    });
    if (generation !== this.generation || this.stopped || sequence !== this.bootstrapSequence)
      return;
    const outcome = captured.match<{ reply: BootstrapReply } | { error: ClientFailure }>({
      ok: (reply) => ({ reply }),
      err: (error) => ({ error }),
    });
    if ("error" in outcome) {
      if (outcome.error.kind === "forbidden") {
        await this.logout();
        return;
      }
      await this.failure(outcome.error);
      if (outcome.error.kind === "network" && !this.stopped) this.retryBootstrap();
      return;
    }
    const reply = outcome.reply;
    if (
      reply.installationId !== this.options.scope.installationId ||
      reply.viewer.id !== this.options.scope.principalId
    ) {
      await this.logout();
      return;
    }
    this.catalogCursor = reply.catalogCursor;
    if (reply.catalog.kind === "catalog")
      this.catalogs.put(this.options.scope, reply.catalog.catalog);
    if (threadId && reply.selectedThreadUnavailable) await this.revoke(threadId);
    if (threadId && reply.selectedThread && threadEpoch === this.threadEpochs.get(threadId))
      this.thread(threadId).replay(reply.selectedThread);
    this.bootstrapPending = false;
    this.emit({ kind: "bootstrap", bootstrap: reply });
    this.watchCatalog();
    if (
      this.selectedThreadId &&
      (!reply.selectedThreadUnavailable || this.selectedThreadId !== threadId)
    )
      this.watchThread(this.selectedThreadId);
  }
  private retryBootstrap(): void {
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = setTimeout(
      () => {
        if (this.stopped) return;
        void this.bootstrap();
      },
      reconnectDelay(this.attempt++),
    );
  }
  async selectThread(threadId: string): Promise<void> {
    const previous = this.selectedThreadId;
    this.selectedThreadId = threadId;
    if (previous && previous !== threadId) {
      this.stopStream(previous);
      this.abortHistory(previous);
    }
    this.trimStores(threadId);
    if (!this.thread(threadId).checkpoint) await this.loadCached(threadId);
    if (this.selectedThreadId !== threadId || this.stopped || this.bootstrapPending) return;
    this.watchThread(threadId);
  }
  private trackStream(task: Promise<void>): void {
    this.streamTasks.add(task);
    void task.then(() => {
      this.streamTasks.delete(task);
    });
  }
  private stopStream(key: string): void {
    this.streams.get(key)?.abort();
    this.streams.delete(key);
  }
  private abortStreams(): void {
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
  }
  private watchThread(threadId: string): void {
    const rpc = this.connection;
    if (!rpc || this.bootstrapPending || this.streams.has(threadId)) return;
    const controller = new AbortController();
    this.streams.set(threadId, controller);
    this.trackStream(this.consumeThread(rpc, threadId, controller));
  }
  private async consumeThread(
    rpc: NativeRPC,
    threadId: string,
    controller: AbortController,
  ): Promise<void> {
    const captured = await Result.tryPromise({
      try: async () => {
        const iterator = await rpc.threads.watch(
          { threadId, checkpoint: this.thread(threadId).checkpoint },
          { signal: controller.signal },
        );
        for await (const event of iterator) {
          if (controller.signal.aborted) return;
          await this.threadEvent(threadId, event);
        }
      },
      catch: captureFailure,
    });
    if (controller.signal.aborted) return;
    if (this.streams.get(threadId) === controller) this.streams.delete(threadId);
    const error = captured.match({ ok: () => undefined, err: (failure) => failure });
    if (error?.kind === "forbidden" || error?.kind === "rejected") {
      await this.revoke(threadId);
      return;
    }
    if (error) {
      await this.failure(error);
      return;
    }
    if (!this.stopped) this.retryBootstrap();
  }
  private async threadEvent(threadId: string, event: ThreadEvent): Promise<void> {
    const store = this.thread(threadId);
    switch (event.kind) {
      case "replay":
        store.replay(event.reply);
        break;
      case "update":
        store.update(event.update);
        break;
      case "hydration":
        store.hydrate(event.hydration);
        break;
      case "thread":
        this.emit(event);
        return;
      case "input":
        this.emit({ ...event, threadId });
        return;
      case "deleted":
      case "revoked":
        await this.revoke(threadId);
        return;
    }
    if (!store.resyncRequired || !this.connection) return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.connection!.threads.sync({ threadId }),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (reply) => {
        store.replay(reply);
      },
      err: (error) => this.emit({ kind: "error", error }),
    });
  }
  private watchCatalog(): void {
    if (!this.connection || !this.catalogCursor) return;
    this.stopStream("__catalog");
    const controller = new AbortController();
    this.streams.set("__catalog", controller);
    this.trackStream(this.consumeCatalog(this.connection, this.catalogCursor, controller));
  }
  private async consumeCatalog(
    rpc: NativeRPC,
    cursor: string,
    controller: AbortController,
  ): Promise<void> {
    const captured = await Result.tryPromise({
      try: async () => {
        const iterator = await rpc.bootstrap.watch({ cursor }, { signal: controller.signal });
        for await (const event of iterator) {
          if (controller.signal.aborted) return;
          await this.catalogEvent(event);
        }
      },
      catch: captureFailure,
    });
    if (controller.signal.aborted) return;
    const error = captured.match({ ok: () => undefined, err: (failure) => failure });
    if (error) {
      await this.failure(error);
      return;
    }
    if (!this.stopped) this.retryBootstrap();
  }
  private async catalogEvent(event: CatalogEvent): Promise<void> {
    this.catalogCursor = event.cursor;
    switch (event.kind) {
      case "thread":
        this.emit(event);
        return;
      case "removed":
        await this.revoke(event.threadId);
        return;
      case "resync":
        await this.bootstrap();
        return;
      case "catalog-invalidated": {
        const generation = this.generation;
        const rpc = this.connection;
        if (!rpc) return;
        const captured = await Result.tryPromise({
          try: () =>
            rpc.catalogs.get({ revision: this.catalogs.get(this.options.scope)?.revision }),
          catch: captureFailure,
        });
        if (generation !== this.generation || this.stopped) return;
        captured.match({
          ok: (reply) => {
            if (reply.kind === "catalog") this.catalogs.put(this.options.scope, reply.catalog);
            this.emit({ kind: "catalog" });
          },
          err: (error) => this.emit({ kind: "error", error }),
        });
        return;
      }
    }
  }
  private abortHistory(threadId?: string): void {
    for (const [key, request] of this.historyRequests) {
      if (threadId !== undefined && request.threadId !== threadId) continue;
      request.controller.abort();
      this.historyRequests.delete(key);
    }
  }
  async hydrate(threadId: string, slotId: string): Promise<void> {
    const rpc = this.connection;
    const store = this.thread(threadId);
    const checkpoint = store.checkpoint;
    const slot = store.getVersioned(slotId);
    if (!rpc || !checkpoint || !slot || slot.slot.kind === "ready") return;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    const key = JSON.stringify([threadId, slotId]);
    if (this.historyRequests.has(key)) return;
    const controller = new AbortController();
    this.historyRequests.set(key, { threadId, controller });
    const captured = await Result.tryPromise({
      try: () =>
        rpc.threads.hydrate(
          {
            threadId,
            slotId,
            historyGeneration: checkpoint.historyGeneration,
            projectionRevision: checkpoint.projectionRevision,
          },
          { signal: controller.signal },
        ),
      catch: captureFailure,
    });
    this.historyRequests.delete(key);
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped ||
      controller.signal.aborted
    )
      return;
    captured.match({
      ok: (hydration) => {
        store.hydrate(hydration);
      },
      err: (error) => store.failHydration(slotId, error.message),
    });
  }
  async loadTurnPage(threadId: string, slotId: string): Promise<void> {
    const rpc = this.connection;
    const store = this.thread(threadId);
    const checkpoint = store.checkpoint;
    const target = store.getVersioned(slotId);
    if (!rpc || !checkpoint || !target || target.slot.kind !== "ready" || !target.slot.partsCursor)
      return;
    const cursor = target.slot.partsCursor;
    const turnId = target.slot.turnId;
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(threadId);
    const captured = await Result.tryPromise({
      try: () =>
        rpc.threads.turnPage({
          threadId,
          turnId,
          cursor,
          historyGeneration: checkpoint.historyGeneration,
          projectionRevision: checkpoint.projectionRevision,
        }),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(threadId) ||
      this.stopped
    )
      return;
    captured.match({
      ok: (page) => {
        store.turnPage(slotId, cursor, page);
      },
      err: (error) => this.emit({ kind: "error", error }),
    });
  }
  async reauthenticate(token: string): Promise<boolean> {
    const rpc = this.connection;
    if (!rpc) return false;
    const captured = await Result.tryPromise({
      try: () => rpc.connection.reauthenticate({ token }),
      catch: captureFailure,
    });
    const outcome = captured.match<{ accepted: boolean } | { error: ClientFailure }>({
      ok: (viewer) => ({ accepted: viewer.id === this.options.scope.principalId }),
      err: (error) => ({ error }),
    });
    if ("error" in outcome) {
      await this.failure(outcome.error);
      return false;
    }
    if (!outcome.accepted) {
      await this.logout();
      return false;
    }
    return true;
  }
  async submit(input: NativeInput): Promise<CommandOutcome> {
    const known = this.receipts.get(input.commandId);
    const existing = this.pending.get(input.commandId) ?? known?.input;
    if (existing && JSON.stringify(existing) !== JSON.stringify(input))
      return {
        kind: "rejected",
        error: { kind: "conflict", message: "A command ID cannot be reused for different input" },
      };
    if (known) return { kind: "accepted", receipt: known.receipt };
    if (this.pending.size >= 256 && !existing)
      return {
        kind: "rejected",
        error: { kind: "rejected", message: "Resolve pending sends before sending more messages" },
      };
    const generation = this.generation;
    const threadEpoch = this.threadEpochs.get(input.threadId);
    this.pending.set(input.commandId, structuredClone(input));
    const rpc = this.connection;
    if (!rpc) return { kind: "uncertain", commandId: input.commandId };
    const captured = await Result.tryPromise({
      try: () => rpc.inputs.submit(input),
      catch: captureFailure,
    });
    if (
      generation !== this.generation ||
      threadEpoch !== this.threadEpochs.get(input.threadId) ||
      this.stopped
    )
      return { kind: "uncertain", commandId: input.commandId };
    const outcome = captured.match<{ receipt: NativeInputReceipt } | { error: ClientFailure }>({
      ok: (value) => ({ receipt: value }),
      err: (error) => ({ error }),
    });
    if ("receipt" in outcome) {
      this.pending.delete(input.commandId);
      this.receipts.set(input.commandId, {
        input: structuredClone(input),
        receipt: outcome.receipt,
      });
      if (this.receipts.size > 256) {
        const oldest = this.receipts.keys().next().value;
        if (oldest) this.receipts.delete(oldest);
      }
      return { kind: "accepted", receipt: outcome.receipt };
    }
    if (outcome.error.kind === "network") return { kind: "uncertain", commandId: input.commandId };
    this.pending.delete(input.commandId);
    if (outcome.error.kind === "auth") await this.logout();
    return { kind: "rejected", error: outcome.error };
  }
  async retry(commandId: string): Promise<CommandOutcome> {
    const input = this.pending.get(commandId);
    if (input) return this.submit(input);
    const receipt = this.receipts.get(commandId);
    if (receipt) return { kind: "accepted", receipt: receipt.receipt };
    return { kind: "rejected", error: { kind: "rejected", message: "Unknown command" } };
  }
  private async failure(error: ClientFailure): Promise<void> {
    if (error.kind === "auth") {
      await this.logout();
      return;
    }
    this.emit({ kind: "error", error });
  }
  async revoke(threadId: string): Promise<void> {
    this.threadEpochs.set(threadId, (this.threadEpochs.get(threadId) ?? 0) + 1);
    for (const [id, input] of this.pending) {
      if (input.threadId === threadId) this.pending.delete(id);
    }
    for (const [id, value] of this.receipts) {
      if (value.input.threadId === threadId) this.receipts.delete(id);
    }
    this.stopStream(threadId);
    this.abortHistory(threadId);
    this.stores.get(threadId)?.clear();
    this.stores.delete(threadId);
    await this.cacheWrites.get(threadId);
    const captured = await Result.tryPromise({
      try: () => this.cache.remove(this.options.scope, threadId),
      catch: captureFailure,
    });
    captured.match({ ok: () => {}, err: (error) => this.emit({ kind: "error", error }) });
    this.emit({ kind: "removed", threadId });
  }
  async logout(): Promise<void> {
    void this.dispose();
    for (const store of this.stores.values()) store.clear();
    this.stores.clear();
    this.pending.clear();
    this.receipts.clear();
    this.catalogs.purge(this.options.scope);
    await Promise.all(this.cacheWrites.values());
    const captured = await Result.tryPromise({
      try: () => this.cache.purge(this.options.scope),
      catch: captureFailure,
    });
    captured.match({ ok: () => {}, err: (error) => this.emit({ kind: "error", error }) });
    this.emit({ kind: "connection", state: "logged-out" });
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.lifetime.abort();
    this.abortStreams();
    this.abortHistory();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.bootstrapTimer);
    this.connection = undefined;
    await Promise.all(this.streamTasks);
    this.socket?.close();
  }
}
