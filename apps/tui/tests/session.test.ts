import { expect, jest, test } from "bun:test";
import { Result } from "better-result";
import { MemoryNativeCache } from "@stanley2058/lilac-client";
import {
  bootstrapUrl,
  createTuiSession,
  decodeTuiBootstrap,
  uploadTuiResource,
} from "../src/session";
import { parseTuiArgs } from "../src/main";
import { TuiAuthError, type TuiAuthSession } from "../src/auth";

const initial = {
  installationId: "fixture",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalog: { kind: "unchanged", revision: "catalog1" },
  catalogCursor: "catalog_cursor1",
};

function auth(): TuiAuthSession {
  return {
    sessionId: "fixture-session",
    threadId: "fixture-thread",
    token: "fixture-token",
    expiresAt: Date.now() / 1000 + 3600,
    authorization: () => "Bearer fixture-token",
    refresh: async () => Result.ok(),
    logout: async () => Result.ok(),
    dispose: () => {},
  };
}

test("CLI only accepts local operator startup and information flags", () => {
  expect(parseTuiArgs([]).unwrap()).toEqual({ kind: "run" });
  for (const option of ["--url", "--thread", "--login", "--no-cache"])
    expect(parseTuiArgs([option]).isErr()).toBe(true);
  expect(parseTuiArgs(["--help"]).unwrap()).toEqual({ kind: "help" });
});

test("bootstrap preserves checkpoint without adding credentials to URL", () => {
  const checkpoint = {
    protocolVersion: 1 as const,
    historyGeneration: 0,
    projectionRevision: 8,
    cursor: "cursor8",
  };
  const url = bootstrapUrl("https://example.com", {
    threadId: "thread1",
    catalogRevision: "catalog1",
    checkpoint,
  });
  expect(JSON.parse(url.searchParams.get("checkpoint")!)).toEqual(checkpoint);
  expect(url.searchParams.get("threadId")).toBe("thread1");
  expect(url.searchParams.has("token")).toBe(false);
  expect(
    decodeTuiBootstrap({ installationId: "old" }).match({
      ok: () => "",
      err: (error) => error.message,
    }),
  ).toContain("Update lilac-tui");
});

test("startup authenticates HTTP and socket with headers and forwards bootstrap once", async () => {
  let httpRequests = 0;
  const observed: { socketHeader: string | null } = { socketHeader: null };
  const opened = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      if (new URL(request.url).pathname === "/api/socket") {
        observed.socketHeader = request.headers.get("authorization");
        if (server.upgrade(request)) return;
      }
      httpRequests++;
      return Response.json(initial);
    },
    websocket: {
      open() {
        opened.resolve();
      },
      message() {},
    },
  });
  const result = await createTuiSession(server.url.origin, auth(), new MemoryNativeCache());
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    server.stop(true);
    return;
  }
  const session = result.value;
  const events: string[] = [];
  session.client.subscribe((event) => events.push(event.kind));
  await session.client.start();
  await opened.promise;
  expect(httpRequests).toBe(1);
  expect(observed.socketHeader).toBe("Bearer fixture-token");
  expect(events).toContain("bootstrap");
  await session.dispose();
  server.stop(true);
});

test("upload streams authenticated bytes with progress and stops on cancellation", async () => {
  let received = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      expect(request.headers.get("content-type")?.split(";")[0]).toBe("text/plain");
      received = await request.text();
      return new Response(null, { status: 204 });
    },
  });
  const progress: number[] = [];
  const uploaded = await uploadTuiResource(
    server.url.origin,
    "Bearer fixture-token",
    "file1",
    new Blob(["hello"], { type: "text/plain" }),
    (fraction) => progress.push(fraction),
  );
  expect(uploaded.isOk()).toBe(true);
  expect(received).toBe("hello");
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(1);
  const canceled = await uploadTuiResource(
    server.url.origin,
    "Bearer fixture-token",
    "file2",
    new Blob(["no"]),
    () => {},
    AbortSignal.abort(),
  );
  expect(canceled.match({ ok: () => "", err: (error) => error.code })).toBe("canceled");
  expect(received).toBe("hello");
  server.stop(true);
});

test("bootstrap rejects sign-in and protocol failures before exposing a client", async () => {
  let status = 401;
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({}, { status });
    },
  });
  const denied = await createTuiSession(server.url.origin, auth(), new MemoryNativeCache());
  expect(denied.match({ ok: () => "", err: (error) => error.code })).toBe("unauthenticated");
  status = 200;
  const incompatible = await createTuiSession(server.url.origin, auth(), new MemoryNativeCache());
  expect(incompatible.match({ ok: () => "", err: (error) => error.code })).toBe("incompatible");
  server.stop(true);
});

test("exit stops renewal and awaits cleanup despite an in-flight heartbeat failure", async () => {
  const heartbeat = Promise.withResolvers<Result<void, TuiAuthError>>();
  const cleanup = Promise.withResolvers<Result<void, TuiAuthError>>();
  const deleting = Promise.withResolvers<void>();
  let renewals = 0;
  let disposed = false;
  let ended = false;
  const server = Bun.serve({ port: 0, fetch: () => Response.json(initial) });
  jest.useFakeTimers();
  const session = (
    await createTuiSession(
      server.url.origin,
      {
        ...auth(),
        refresh: () => {
          renewals++;
          return heartbeat.promise;
        },
        logout: () => {
          deleting.resolve();
          return cleanup.promise;
        },
        dispose: () => {
          disposed = true;
        },
      },
      new MemoryNativeCache(),
    )
  ).unwrap();
  try {
    jest.advanceTimersByTime(10_000);
    expect(renewals).toBe(1);
    const exit = session.logout().then(() => {
      ended = true;
    });
    heartbeat.resolve(Result.err(new TuiAuthError({ code: "login", message: "Session ended" })));
    await deleting.promise;
    jest.advanceTimersByTime(30_000);
    expect(renewals).toBe(1);
    expect(disposed).toBe(false);
    expect(ended).toBe(false);
    cleanup.resolve(Result.ok());
    await exit;
    expect(disposed).toBe(true);
    expect(ended).toBe(true);
  } finally {
    heartbeat.resolve(Result.ok());
    cleanup.resolve(Result.ok());
    await session.dispose();
    jest.useRealTimers();
    server.stop(true);
  }
});
