import { Result } from "better-result";
import type { NativeClient, CacheScope } from "@stanley2058/lilac-client";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { createStore } from "zustand/vanilla";

export type NotificationPreferences = { enabled: boolean; completion: boolean; failure: boolean };
export const defaultNotifications: NotificationPreferences = {
  enabled: false,
  completion: true,
  failure: true,
};
export function notificationScope(scope: Pick<CacheScope, "installationId" | "principalId">) {
  return `lilac-notifications-v1:${JSON.stringify([scope.installationId, scope.principalId])}`;
}
export function createNotificationPreferences(
  scope: Pick<CacheScope, "installationId" | "principalId">,
) {
  const key = notificationScope(scope);
  const read = (): NotificationPreferences =>
    Result.try({
      try: () => localStorage.getItem(key),
      catch: () => "Storage unavailable",
    }).match({
      ok: (value) =>
        /^[01]{3}$/.test(value ?? "")
          ? {
              enabled: value?.[0] === "1",
              completion: value?.[1] === "1",
              failure: value?.[2] === "1",
            }
          : defaultNotifications,
      err: () => defaultNotifications,
    });
  const store = createStore<NotificationPreferences>(() => read());
  return {
    store,
    sync: () => store.setState(read()),
    update(value: Partial<NotificationPreferences>) {
      store.setState(value);
      const state = store.getState();
      Result.try({
        try: () =>
          localStorage.setItem(
            key,
            [state.enabled, state.completion, state.failure].map(Number).join(""),
          ),
        catch: () => "Storage unavailable",
      }).match({ ok: () => {}, err: () => {} });
    },
  };
}
export type NotificationPermissionState = NotificationPermission | "unsupported";
export function notificationPermission(): NotificationPermissionState {
  if (!window.isSecureContext || !("Notification" in window) || !navigator.locks)
    return "unsupported";
  return Notification.permission;
}
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (notificationPermission() === "unsupported") return "unsupported";
  return Result.tryPromise({
    try: () => Notification.requestPermission(),
    catch: () => "default" as const,
  }).then((result) => result.match({ ok: (value) => value, err: (value) => value }));
}

export function notificationTransition(previous: NativeThread | undefined, current: NativeThread) {
  if (
    !previous ||
    !current.capabilities.read ||
    current.archived ||
    current.revision <= previous.revision
  )
    return;
  if (previous.displayStatus !== "working") return;
  if (current.displayStatus === "completed") return "completion";
  if (current.displayStatus === "error") return "failure";
}

export function holdNotificationLock(name: string): () => void {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  void Result.tryPromise({
    try: () =>
      navigator.locks.request(
        name,
        { mode: "shared", signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    catch: () => "Lock unavailable",
  });
  return () => {
    controller.abort();
    release?.();
  };
}

export function watchNotifications(options: {
  client: Pick<NativeClient, "subscribe" | "connectionState">;
  initial: NativeThread[];
  scope: Pick<CacheScope, "installationId" | "principalId">;
  preferences: ReturnType<typeof createNotificationPreferences>;
  openThread: (id: string) => void;
}) {
  const { client, preferences } = options;
  const scope = notificationScope(options.scope);
  let threads = new Map(options.initial.map((thread) => [thread.id, thread]));
  let epoch = 0;
  let leader = false;
  let disposed = false;
  let leadership: AbortController | undefined;
  let release: (() => void) | undefined;
  const shown = new Set<Notification>();
  function releaseLeadership() {
    leader = false;
    leadership?.abort();
    release?.();
    leadership = undefined;
    release = undefined;
  }
  function claimLeadership() {
    if (!navigator.locks || leadership || disposed) return;
    leadership = new AbortController();
    void Result.tryPromise({
      try: () =>
        navigator.locks.request(scope, { signal: leadership?.signal }, () => {
          leader = true;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }),
      catch: () => "Lock unavailable",
    });
  }
  if (client.connectionState === "online") claimLeadership();
  async function notify(thread: NativeThread, kind: "completion" | "failure") {
    const startedEpoch = epoch;
    const registration = await Result.tryPromise({
      try: async () => navigator.serviceWorker?.getRegistration(),
      catch: () => "Service worker unavailable",
    }).then((result) => result.match({ ok: (value) => value, err: () => undefined }));
    const captured = await Result.tryPromise({
      try: () => navigator.locks.query(),
      catch: () => "Lock unavailable",
    });
    const locks = captured.match({ ok: (value) => value, err: () => undefined });
    const prefs = preferences.store.getState();
    if (
      !locks ||
      disposed ||
      !leader ||
      !prefs.enabled ||
      !prefs[kind] ||
      notificationPermission() !== "granted"
    )
      return;
    if (locks.held?.some((lock) => lock.name === `${scope}:view:${thread.id}`)) return;
    const current = threads.get(thread.id);
    if (
      epoch !== startedEpoch ||
      !current?.capabilities.read ||
      current.archived ||
      current.displayStatus !== thread.displayStatus
    )
      return;
    const tag = `${scope}:${thread.id}:${thread.revision}:${kind}`;
    if (registration?.active) {
      await Result.tryPromise({
        try: () =>
          registration.showNotification(current.title || "Untitled conversation", {
            body: kind === "completion" ? "Response finished" : "Run failed",
            tag,
            data: { threadId: thread.id },
          }),
        catch: () => "Notification unavailable",
      });
      return;
    }
    Result.try({
      try: () => {
        const notification = new Notification(current.title || "Untitled conversation", {
          body: kind === "completion" ? "Response finished" : "Run failed",
          tag,
        });
        shown.add(notification);
        notification.onclose = () => shown.delete(notification);
        notification.onclick = () => {
          window.focus();
          options.openThread(thread.id);
          notification.close();
        };
      },
      catch: () => "Notification unavailable",
    }).match({ ok: () => {}, err: () => {} });
  }
  const sync = () => preferences.sync();
  window.addEventListener("storage", sync);
  const unsubscribe = client.subscribe((event) => {
    if (event.kind === "connection") {
      if (event.state === "online") {
        claimLeadership();
        return;
      }
      epoch += 1;
      threads.clear();
      releaseLeadership();
      return;
    }
    if (event.kind === "bootstrap") {
      epoch += 1;
      threads = new Map(event.bootstrap.threads.items.map((thread) => [thread.id, thread]));
      return;
    }
    if (event.kind === "removed") {
      threads.delete(event.threadId);
      return;
    }
    if (event.kind !== "thread") return;
    const previous = threads.get(event.thread.id);
    if (previous && event.thread.revision <= previous.revision) return;
    threads.set(event.thread.id, event.thread);
    const kind = notificationTransition(previous, event.thread);
    if (!kind || !leader || client.connectionState !== "online") return;
    const prefs = preferences.store.getState();
    if (prefs.enabled && prefs[kind] && notificationPermission() === "granted")
      return notify(event.thread, kind);
  });
  return () => {
    disposed = true;
    unsubscribe();
    window.removeEventListener("storage", sync);
    releaseLeadership();
    for (const notification of shown) notification.close();
  };
}
