import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Result } from "better-result";
import { NativeStore } from "./store";
import { createNativeOperator, OPERATOR_GRACE_MS } from "./operator";
import { createNativeExecution } from "./execution";
import { SqliteTranscriptStore } from "../../transcript/transcript-store";
import { NativeSearchStore } from "./store-search";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  let now = 1000;
  const database = new Database(":memory:");
  const store = new NativeStore(database, () => now);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      displayName: "Owner",
      toolMode: "full",
    })
    .unwrap();
  const transcript = new SqliteTranscriptStore(":memory:");
  cleanups.push(() => {
    store.close();
    transcript.close();
  });
  const token = "x".repeat(43);
  const sessionId = crypto.randomUUID();
  let cancellations = 0;
  let cancel: () => Promise<Result<void, Error>> = async () => Result.ok();
  const execution = createNativeExecution({
    store,
    transcriptStore: transcript,
    bus: {
      publish: async () => Result.ok({ id: "1", cursor: "1", topic: "cmd.request" as never }),
    },
    runner: () => ({
      cancelNativeSession: async () => {
        cancellations++;
        return cancel();
      },
    }),
  });
  const options = {
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    ownerId: "owner",
    store,
    execution,
    now: () => now,
  };
  const operator = createNativeOperator(options);
  function request(
    method = "POST",
    session: string = sessionId,
    headers: Record<string, string> = {},
  ) {
    return new Request("http://127.0.0.1:8788/api/operator/session", {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-lilac-operator-session": session,
        ...headers,
      },
    });
  }
  return {
    store,
    database,
    operator,
    options,
    request,
    sessionId,
    advance(ms: number) {
      now += ms;
    },
    setCancel(fn: typeof cancel) {
      cancel = fn;
    },
    cancellations: () => cancellations,
  };
}

test("operator authentication rejects wrong tokens, cookies, browser origins and invalid session IDs", async () => {
  const f = fixture();
  for (const request of [
    f.request("POST", f.sessionId, { authorization: "Bearer wrong" }),
    f.request("POST", f.sessionId, { origin: "http://localhost" }),
    f.request("POST", "invalid"),
    new Request("http://localhost/api/operator/session", {
      method: "POST",
      headers: { cookie: "lilac_native_session=anything" },
    }),
  ]) {
    expect((await f.operator.handle(request)).status).toBe(401);
  }
  expect(f.store.listEphemeralThreads().unwrap()).toEqual([]);
});

test("one invocation is idempotent, has owner authority, and stays out of ordinary lists and search", async () => {
  const f = fixture();
  expect((await f.operator.handle(f.request())).status).toBe(200);
  const first = f.store.getEphemeralThread(f.sessionId).unwrap()!;
  expect((await f.operator.handle(f.request())).status).toBe(200);
  expect(f.store.listEphemeralThreads().unwrap()).toHaveLength(1);
  expect(f.store.listThreads("owner", {}).unwrap()).toEqual([]);
  const search = new NativeSearchStore({ db: f.database, store: f.store });
  expect(search.searchMessages("owner", { query: "Temporary", limit: 10 }).unwrap()).toEqual([]);
  const principal = (await f.operator.auth.authenticate(f.request("GET"))).unwrap();
  expect(principal.userId).toBe("owner");
  expect(principal.provider).toBe("operator");
  expect(f.store.getThread("owner", first.id).unwrap().capabilities.edit).toBe(true);
  const secondSession = crypto.randomUUID();
  await f.operator.handle(f.request("POST", secondSession));
  await f.operator.handle(f.request("DELETE"));
  expect(f.store.getEphemeralThread(secondSession).unwrap()!.deleted).toBe(false);
});

test("exit fences input immediately and waits for cancellation before deleting visible history", async () => {
  const f = fixture();
  await f.operator.handle(f.request());
  const thread = f.store.getEphemeralThread(f.sessionId).unwrap()!;
  f.store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "temporary message",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const entered = Promise.withResolvers<void>();
  const canceled = Promise.withResolvers<Result<void, Error>>();
  f.setCancel(() => {
    entered.resolve();
    return canceled.promise;
  });
  const ending = f.operator.handle(f.request("DELETE"));
  await entered.promise;
  expect(f.store.getThreadRecord(thread.id).unwrap().mutationPending).toBe(true);
  expect(f.store.getThread("owner", thread.id).isErr()).toBe(true);
  canceled.resolve(Result.ok());
  expect((await ending).status).toBe(200);
  expect(f.store.getThreadRecord(thread.id).unwrap().mutationPending).toBe(false);
  expect(f.store.listEphemeralThreads().unwrap()).toEqual([]);
  expect((await f.operator.handle(f.request())).status).toBe(401);
});

test("heartbeats allow reconnection until grace expires, and an expired session cannot resurrect", async () => {
  const f = fixture();
  await f.operator.handle(f.request());
  f.advance(OPERATOR_GRACE_MS - 1);
  (await f.operator.reap()).unwrap();
  expect((await f.operator.handle(f.request())).status).toBe(200);
  f.advance(OPERATOR_GRACE_MS);
  expect((await f.operator.handle(f.request())).status).toBe(401);
  (await f.operator.reap()).unwrap();
  expect(f.cancellations()).toBe(1);
  expect((await f.operator.handle(f.request())).status).toBe(401);
});

test("restart cleanup and cancellation retries use persisted session ownership", async () => {
  const f = fixture();
  await f.operator.handle(f.request());
  f.setCancel(async () => Result.err(new Error("fixture cancellation failure")));
  const restarted = createNativeOperator(f.options);
  expect((await restarted.reap(true)).isErr()).toBe(true);
  expect(f.store.getEphemeralThread(f.sessionId).unwrap()!.mutationPending).toBe(true);
  f.setCancel(async () => Result.ok());
  (await restarted.reap(true)).unwrap();
  expect(f.store.listEphemeralThreads().unwrap()).toEqual([]);
  expect(f.cancellations()).toBe(2);
});
