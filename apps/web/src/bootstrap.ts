import { threadIdFromUrl } from "./thread-location";
import { NativeClient, type CacheScope } from "@stanley2058/lilac-client";
import type { BootstrapReply } from "@stanley2058/lilac-client-protocol";
import { ORPCError } from "@orpc/client";
import { Result } from "better-result";
import { z } from "zod";
import { createWebNativeCache, type WebNativeCache } from "./cache";
import { logoutHttp, openNativeSocket, readBootstrap } from "./http";

export type WebSession = {
  client: NativeClient;
  scope: CacheScope;
  initial: BootstrapReply;
  initialThreadId?: string;
};
export type WebState =
  | { kind: "starting" }
  | { kind: "ready"; session: WebSession }
  | { kind: "login"; message?: string; signingOut?: boolean; logoutFailed?: boolean }
  | { kind: "offline"; message: string };
export type WebSessionOptions = {
  cache?: WebNativeCache;
  openSocket?: () => WebSocket;
  bootstrap?: typeof readBootstrap;
  logout?: () => Promise<Result<void, Error>>;
  currentUrl?: () => URL;
  channel?: BroadcastChannel | null;
};

export const webCache = createWebNativeCache();

function requestError(error: unknown): WebState {
  if (
    error instanceof ORPCError &&
    (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")
  ) {
    return { kind: "login", message: error.message };
  }
  return {
    kind: "offline",
    message: "Could not connect to Lilac. Your drafts are saved on this device.",
  };
}

const sessionNoticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ending"), id: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("ended"),
    id: z.string().min(1).max(128).optional(),
    failed: z.boolean().optional(),
  }),
]);
function decodeSessionNotice(value: unknown): z.infer<typeof sessionNoticeSchema> | undefined {
  const parsed = sessionNoticeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function createSessionChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return Result.try({
    try: () => new BroadcastChannel("lilac-session"),
    catch: () => undefined,
  }).match({ ok: (channel) => channel, err: () => undefined });
}

export class WebSessionController {
  private state: WebState = { kind: "starting" };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private readonly pendingSignouts = new Set<string>();
  private logoutFailed = false;
  private logoutTask: Promise<void> | undefined;
  private active: NativeClient | undefined;
  private activeScope: CacheScope | undefined;
  private stopEvents: (() => void) | undefined;
  private startup = new AbortController();
  private startingSocket: WebSocket | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private readonly saves = new Set<Promise<void>>();
  private readonly cache: WebNativeCache;
  private readonly openSocket: () => WebSocket;
  private readonly fetchBootstrap: typeof readBootstrap;
  private readonly endRemoteSession: () => Promise<Result<void, Error>>;
  private readonly currentUrl: () => URL;
  private readonly channel: BroadcastChannel | undefined;

  constructor(options: WebSessionOptions = {}) {
    this.cache = options.cache ?? webCache;
    this.openSocket = options.openSocket ?? openNativeSocket;
    this.fetchBootstrap = options.bootstrap ?? readBootstrap;
    this.endRemoteSession = options.logout ?? logoutHttp;
    this.currentUrl = options.currentUrl ?? (() => new URL(location.href));
    this.channel =
      options.channel === undefined ? createSessionChannel() : (options.channel ?? undefined);
    this.channel?.addEventListener("message", this.receiveSessionEvent);
  }
  private readonly receiveSessionEvent = (event: MessageEvent<unknown>): void => {
    const notice = decodeSessionNotice(event.data);
    if (!notice) return;
    if (notice.kind === "ending") this.pendingSignouts.add(notice.id);
    if (notice.kind === "ended") {
      if (notice.id) this.pendingSignouts.delete(notice.id);
      this.logoutFailed = notice.failed ?? false;
    }
    void this.clearSession(false);
  };
  private closeStartingSocket(): void {
    this.startingSocket?.close();
    this.startingSocket = undefined;
  }
  getSnapshot = (): WebState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(state: WebState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async start(): Promise<void> {
    if (this.disposed || this.pendingSignouts.size || this.logoutFailed) return;
    const epoch = ++this.epoch;
    this.startup.abort();
    this.closeStartingSocket();
    this.startup = new AbortController();
    const signal = this.startup.signal;
    this.stopEvents?.();
    this.stopEvents = undefined;
    const previous = this.active;
    this.active = undefined;
    await previous?.dispose();
    await this.cleanup;
    if (epoch !== this.epoch) return;
    const result = await Result.tryPromise({
      try: () => this.startSession(epoch, signal),
      catch: requestError,
    });
    if (epoch !== this.epoch) return;
    const failure = result.match({ ok: () => undefined, err: (state) => state });
    if (!failure) return;
    await this.settleStartFailure(failure);
  }
  private async settleStartFailure(failure: WebState): Promise<void> {
    this.closeStartingSocket();
    this.stopEvents?.();
    this.stopEvents = undefined;
    const active = this.active;
    this.active = undefined;
    this.set(failure);
    await active?.dispose();
  }
  private async startSession(epoch: number, signal: AbortSignal): Promise<void> {
    const threadId = threadIdFromUrl(this.currentUrl());
    const cached = await this.cache.readLatestBootstrap();
    if (epoch !== this.epoch) return;
    if (cached) {
      const {
        selectedThread: _selected,
        selectedThreadUnavailable: _unavailable,
        ...initial
      } = cached.bootstrap;
      const session = this.create(
        cached.scope,
        initial,
        threadId,
        this.openSocket,
        this.fetchBootstrap,
      );
      this.set({ kind: "ready", session });
      await session.client.start(threadId);
      return;
    }
    const socket = this.openSocket();
    this.startingSocket = socket;
    const bootstrap = await this.fetchBootstrap({ threadId }, signal);
    if (epoch !== this.epoch) {
      socket.close();
      return;
    }
    const scope: CacheScope = {
      installationId: bootstrap.installationId,
      principalId: bootstrap.viewer.id,
      protocolVersion: 1,
      projectionVersion: 1,
    };
    let firstSocket = true;
    let firstBootstrap = true;
    const session = this.create(
      scope,
      bootstrap,
      threadId,
      () => {
        if (firstSocket && socket.readyState < WebSocket.CLOSING) {
          firstSocket = false;
          return socket;
        }
        firstSocket = false;
        return this.openSocket();
      },
      async (input, requestSignal) => {
        if (firstBootstrap) {
          firstBootstrap = false;
          return bootstrap;
        }
        return this.fetchBootstrap(input, requestSignal);
      },
    );
    this.startingSocket = undefined;
    this.set({ kind: "ready", session });
    await session.client.start(threadId);
  }
  private create(
    scope: CacheScope,
    initial: BootstrapReply,
    initialThreadId: string | undefined,
    openSocket: () => WebSocket,
    bootstrap: typeof readBootstrap,
  ): WebSession {
    const client = new NativeClient({ scope, cache: this.cache, openSocket, bootstrap });
    if (initial.catalog.kind === "catalog") client.catalogs.put(scope, initial.catalog.catalog);
    if (initialThreadId && initial.selectedThread)
      client.thread(initialThreadId).replay(initial.selectedThread);
    this.active = client;
    this.activeScope = scope;
    this.stopEvents = client.subscribe((event) => {
      if (this.active !== client) return;
      if (event.kind === "connection" && event.state === "logged-out") {
        void this.clearSession(true);
        return;
      }
      if (event.kind !== "bootstrap") return;
      const catalog = client.catalogs.get(scope);
      const snapshot: BootstrapReply = catalog
        ? { ...event.bootstrap, catalog: { kind: "catalog", catalog } }
        : event.bootstrap;
      const save = this.saveSnapshot(this.epoch, client, scope, snapshot);
      this.saves.add(save);
      void save.then(() => {
        this.saves.delete(save);
      });
    });
    return { client, scope, initial, initialThreadId };
  }
  private async saveSnapshot(
    epoch: number,
    client: NativeClient,
    scope: CacheScope,
    snapshot: BootstrapReply,
  ): Promise<void> {
    if (epoch !== this.epoch || this.active !== client) return;
    const result = await Result.tryPromise({
      try: () => this.cache.saveBootstrap(scope, snapshot),
      catch: () => undefined,
    });
    result.match({ ok: () => {}, err: () => {} });
  }
  logout(providerOperation?: () => Promise<Result<void, Error>>): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    const task = this.performLogout(providerOperation);
    this.logoutTask = task;
    void task.then(() => {
      if (this.logoutTask === task) this.logoutTask = undefined;
    });
    return task;
  }
  private async performLogout(
    providerOperation?: () => Promise<Result<void, Error>>,
  ): Promise<void> {
    const id = crypto.randomUUID();
    this.pendingSignouts.add(id);
    this.broadcast({ kind: "ending", id });
    const remote = Result.tryPromise({
      try: () => this.endRemoteSession(),
      catch: () => new Error("Could not sign out of Lilac. Retry before leaving this device."),
    });
    const provider = Result.tryPromise({
      try: () => providerOperation?.() ?? Promise.resolve(Result.ok()),
      catch: () => new Error("Could not sign out of the authentication provider. Try again."),
    });
    await this.clearSession(false);
    const [result, providerResult] = await Promise.all([remote, provider]);
    const remoteMessage = result
      .andThen((value) => value)
      .match({
        ok: () => undefined,
        err: () => "Could not sign out of Lilac. Retry before leaving this device.",
      });
    const providerMessage = providerResult
      .andThen((value) => value)
      .match({ ok: () => undefined, err: (error) => error.message });
    const message = remoteMessage ?? providerMessage;
    this.logoutFailed = !!message;
    this.pendingSignouts.delete(id);
    this.broadcast({ kind: "ended", id, failed: this.logoutFailed });
    if (!this.disposed)
      this.set({
        kind: "login",
        signingOut: this.pendingSignouts.size > 0,
        logoutFailed: this.logoutFailed,
        message,
      });
  }
  private broadcast(notice: z.infer<typeof sessionNoticeSchema>): void {
    Result.try({ try: () => this.channel?.postMessage(notice), catch: () => undefined }).match({
      ok: () => {},
      err: () => {},
    });
  }
  private clearSession(broadcast: boolean): Promise<void> {
    ++this.epoch;
    this.startup.abort();
    this.closeStartingSocket();
    const client = this.active;
    const scope = this.activeScope;
    this.active = undefined;
    this.activeScope = undefined;
    this.stopEvents?.();
    this.stopEvents = undefined;
    this.set({
      kind: "login",
      signingOut: this.pendingSignouts.size > 0,
      logoutFailed: this.logoutFailed,
      ...(this.logoutFailed
        ? { message: "Could not finish signing out. Retry before leaving this device." }
        : {}),
    });
    if (broadcast) this.broadcast({ kind: "ended" });
    const saves = [...this.saves];
    this.cleanup = this.cleanup.then(() => this.purgeSession(client, scope, saves));
    return this.cleanup;
  }
  private async purgeSession(
    client: NativeClient | undefined,
    scope: CacheScope | undefined,
    saves: Promise<void>[],
  ): Promise<void> {
    const result = await Result.tryPromise({
      try: async () => {
        await client?.logout();
        await Promise.all(saves);
        const identity = scope ?? (await this.cache.readLatestBootstrap())?.scope;
        if (identity) await this.cache.purge(identity);
      },
      catch: () => undefined,
    });
    result.match({ ok: () => {}, err: () => {} });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    ++this.epoch;
    this.startup.abort();
    this.closeStartingSocket();
    this.stopEvents?.();
    this.stopEvents = undefined;
    const active = this.active;
    this.active = undefined;
    this.channel?.removeEventListener("message", this.receiveSessionEvent);
    await active?.dispose();
    await this.cleanup;
    await Promise.all(this.saves);
    await this.logoutTask;
    this.channel?.close();
  }
}
