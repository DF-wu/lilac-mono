import type { Database } from "bun:sqlite";
import { generateVAPIDKeys, sendNotification, WebPushError } from "web-push";
import { Result } from "better-result";
import type { NativeRpcInputs, NativeThread } from "@stanley2058/lilac-client-protocol";
import { nativeFailure } from "./errors";
import { nativeStoreTransaction, type NativeStore } from "./store";

type Subscription = {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  completion: number;
  failure: number;
};
type Keys = { publicKey: string; privateKey: string };

export function allowedPushEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash)
    return false;
  return (
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".push.apple.com") ||
    url.hostname.endsWith(".notify.windows.com")
  );
}

export class NativePush {
  private readonly viewing = new Map<string, { userId: string; threadId: string; until: number }>();
  private readonly working = new Map<string, NativeThread>();
  private readonly pending = new Set<Promise<void>>();
  private stopListening?: () => void;
  constructor(
    private readonly db: Database,
    private readonly store: NativeStore,
    private readonly send = sendNotification,
  ) {}

  key() {
    return nativeStoreTransaction(this.db, () => {
      const keys = this.keys() ?? this.createKeys();
      return Result.ok({ publicKey: keys.publicKey });
    });
  }

  private createKeys(): Keys {
    const keys = generateVAPIDKeys();
    this.db
      .query("INSERT INTO native_push_keys(id,public_key,private_key) VALUES(1,?,?)")
      .run(keys.publicKey, keys.privateKey);
    return keys;
  }

  private keys(): Keys | null {
    return this.db
      .query<Keys, []>(
        "SELECT public_key AS publicKey,private_key AS privateKey FROM native_push_keys WHERE id=1",
      )
      .get();
  }

  subscribe(userId: string, input: NativeRpcInputs["notifications"]["subscribe"]) {
    if (!allowedPushEndpoint(input.endpoint))
      return Result.err(nativeFailure("invalid", "Unsupported push service"));
    return nativeStoreTransaction(this.db, () => {
      const count =
        this.db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM native_push_subscriptions WHERE user_id=? AND endpoint<>?",
          )
          .get(userId, input.endpoint)?.count ?? 0;
      if (count >= 16) return Result.err(nativeFailure("invalid", "Too many notification devices"));
      this.db
        .query(
          "INSERT INTO native_push_subscriptions(endpoint,user_id,p256dh,auth,completion,failure) VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,completion=excluded.completion,failure=excluded.failure",
        )
        .run(
          input.endpoint,
          userId,
          input.keys.p256dh,
          input.keys.auth,
          Number(input.completion),
          Number(input.failure),
        );
      this.trackWorking(userId);
      return Result.ok({ ok: true as const });
    });
  }

  private trackWorking(userId: string) {
    const records = this.db
      .query<{ id: string }, []>("SELECT id FROM native_records WHERE kind='thread'")
      .all();
    for (const record of records) {
      const thread = this.store
        .getThread(userId, record.id)
        .match({ ok: (value) => value, err: () => undefined });
      if (!thread || thread.archived || !thread.capabilities.read) continue;
      if (thread.displayStatus === "working") this.working.set(`${userId}:${thread.id}`, thread);
    }
  }

  unsubscribe(userId: string, endpoint: string) {
    this.db
      .query("DELETE FROM native_push_subscriptions WHERE endpoint=? AND user_id=?")
      .run(endpoint, userId);
    return Result.ok({ ok: true as const });
  }

  presence(userId: string, input: NativeRpcInputs["notifications"]["presence"]) {
    for (const [key, view] of this.viewing) if (view.until <= Date.now()) this.viewing.delete(key);
    const key = JSON.stringify([userId, input.clientId]);
    if (input.threadId)
      this.viewing.set(key, {
        userId,
        threadId: input.threadId,
        until: Date.now() + 60_000,
      });
    else this.viewing.delete(key);
    return Result.ok({ ok: true as const });
  }

  start() {
    this.stopListening = this.store.subscribe((threadId) => this.changed(threadId));
  }

  private changed(threadId: string) {
    if (!threadId) return;
    const subscriptions = this.db
      .query<Subscription, []>("SELECT * FROM native_push_subscriptions")
      .all();
    for (const userId of new Set(subscriptions.map((entry) => entry.user_id))) {
      const key = `${userId}:${threadId}`;
      const thread = this.store
        .getThread(userId, threadId)
        .match({ ok: (value) => value, err: () => undefined });
      if (!thread || thread.archived || !thread.capabilities.read) {
        this.working.delete(key);
        continue;
      }
      if (thread.displayStatus === "working") {
        this.working.set(key, thread);
        continue;
      }
      if (thread.displayStatus === "idle") continue;
      const previous = this.working.get(key);
      this.working.delete(key);
      if (!previous || thread.revision <= previous.revision) continue;
      if (
        [...this.viewing.values()].some(
          (viewing) =>
            viewing.userId === userId &&
            viewing.threadId === threadId &&
            viewing.until > Date.now(),
        )
      )
        continue;
      const kind = thread.displayStatus === "error" ? "failure" : "completion";
      const payload = this.store
        .notificationContent(userId, threadId)
        .match({ ok: (value) => value, err: () => undefined });
      const keys = this.keys();
      if (!payload || !keys) continue;
      for (const subscription of subscriptions) {
        if (subscription.user_id !== userId || !subscription[kind]) continue;
        const delivery = this.deliver(subscription, JSON.stringify(payload), keys);
        this.pending.add(delivery);
        void delivery.finally(() => this.pending.delete(delivery));
      }
    }
  }

  private async deliver(subscription: Subscription, payload: string, keys: Keys) {
    const result = await Result.tryPromise({
      try: () =>
        this.send(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          {
            vapidDetails: { subject: "mailto:notifications@lilac.app", ...keys },
            TTL: 3600,
            timeout: 10_000,
          },
        ),
      catch: (error) => (error instanceof WebPushError ? error.statusCode : 0),
    });
    const status = result.match({ ok: () => 201, err: (value) => value });
    if (status === 404 || status === 410)
      this.unsubscribe(subscription.user_id, subscription.endpoint);
  }

  async stop() {
    this.stopListening?.();
    this.stopListening = undefined;
    await Promise.all(this.pending);
    this.working.clear();
    this.viewing.clear();
  }
}
