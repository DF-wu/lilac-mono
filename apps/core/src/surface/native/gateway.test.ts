import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { nativeContract } from "@stanley2058/lilac-client-protocol";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createNativeClerkAuthenticator } from "./auth-clerk";
import { authFailure } from "./auth";
import { Panic, Result } from "better-result";
import { createNativeLocalAuthenticator } from "./auth-local";
import { createNativeGateway, type NativeGatewayOptions } from "./gateway";
import { nativeRpcValue, type NativeRpcServices } from "./rpc";
import { nativeFailure } from "./errors";
import { createNativeMetrics, type NativeMetricSink } from "./metrics";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const user = {
  id: "owner",
  displayName: "Owner",
  role: "owner" as const,
  toolMode: "full" as const,
};
const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "n_0_1",
};

async function fixture(webRoot?: string, resources?: NativeGatewayOptions["resources"]) {
  const measurements: { event: string; fields: Parameters<NativeMetricSink>[1] }[] = [];
  const metrics = createNativeMetrics((event, fields) => measurements.push({ event, fields }));
  const fatalErrors: Error[] = [];
  const fatal = Promise.withResolvers<Error>();
  const auth = createNativeLocalAuthenticator({
    ownerUserId: user.id,
    username: "operator",
    passwordHash: await Bun.password.hash("test-password", {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    }),
    signingKey: crypto.getRandomValues(new Uint8Array(32)),
    installationId: "test",
    allowedOrigins: ["http://localhost"],
  });
  const services = {
    bootstrap: {
      get: () =>
        Result.ok({
          installationId: "test",
          viewer: user,
          threads: { items: [] },
          catalog: {
            kind: "catalog",
            catalog: { revision: "catalog1", models: [], skills: [], commands: [] },
          },
          catalogCursor: "catalog1",
        }),
    },
    threads: {
      watch: () =>
        Result.ok(
          (async function* () {
            yield {
              kind: "replay",
              reply: {
                kind: "window",
                checkpoint,
                slots: [
                  { kind: "deferred", slotId: "older", position: 0, endPosition: 9 },
                  {
                    kind: "ready",
                    slotId: "latest",
                    turnId: "turn_latest",
                    position: 9,
                    messages: [],
                  },
                ],
              },
            };
            yield {
              kind: "hydration",
              hydration: {
                historyGeneration: 0,
                projectionRevision: 1,
                slotId: "older",
                slots: [
                  { kind: "ready", slotId: "old", turnId: "turn_old", position: 0, messages: [] },
                ],
              },
            };
          })(),
        ),
      sync: (_principal: object, input: { threadId: string }) =>
        input.threadId === "private-other"
          ? Result.err(nativeFailure("forbidden", "Thread access denied"))
          : Result.ok({ kind: "unchanged", checkpoint }),
    },
  } as unknown as NativeRpcServices;
  const gateway = createNativeGateway({
    metrics,
    hostname: "127.0.0.1",
    port: 0,
    webRoot,
    resources,
    auth,
    login: auth.login,
    services,
    getViewer: () => Result.ok(user),
    reportFatalError: (error) => {
      fatalErrors.push(error);
      fatal.resolve(error);
    },
    publicAuth: { provider: "local" },
  });
  const { url } = gateway.start().unwrap();
  cleanup.push(gateway.stop);
  const login = await fetch(new URL("api/auth/login", url), {
    method: "POST",
    headers: { authorization: `Basic ${btoa("operator:test-password")}` },
  });
  const { token } = (await login.json()) as { token: string };
  return {
    url,
    token,
    gateway,
    services,
    fatalErrors,
    fatal: fatal.promise,
    metrics,
    measurements,
  };
}

function connect(url: string, token: string) {
  const endpoint = new URL("api/socket", url);
  endpoint.protocol = "ws:";
  const socket = new (WebSocket as unknown as {
    new (url: URL, options: { headers: Record<string, string> }): WebSocket;
  })(endpoint, { headers: { authorization: `Bearer ${token}` } });
  cleanup.push(() => socket.close());
  const client: ContractRouterClient<typeof nativeContract> = createORPCClient(
    new RPCLink({ websocket: socket }),
  );
  return { socket, client };
}

describe("native gateway", () => {
  test("shutdown waits for an in-flight RPC mutation after closing its socket", async () => {
    const { url, token, gateway, services } = await fixture();
    const entered = Promise.withResolvers<void>();
    const finishMutation = Promise.withResolvers<void>();
    let writes = 0;
    services.threads.sync = async () => {
      entered.resolve();
      await finishMutation.promise;
      writes += 1;
      return Result.ok({ kind: "unchanged", checkpoint });
    };
    const { client, socket } = connect(url, token);
    const socketClosed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    const pending = client.threads.sync({ threadId: "shared" }).then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    let stopped = false;
    const stopping = gateway.stop().then(() => {
      stopped = true;
    });
    await socketClosed;
    expect(stopped).toBe(false);
    expect(writes).toBe(0);
    finishMutation.resolve();
    await stopping;
    expect(writes).toBe(1);
    await pending;
  });

  test("shutdown aborts a live subscription before awaiting RPC drain", async () => {
    const { url, token, gateway, services, fatalErrors } = await fixture();
    const waiting = Promise.withResolvers<void>();
    services.threads.watch = (_principal, _input, signal) =>
      Result.ok(
        (async function* () {
          yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
            waiting.resolve();
          });
        })(),
      );
    const { client } = connect(url, token);
    const stream = await client.threads.watch({ threadId: "shared" });
    await stream.next();
    await waiting.promise;
    await gateway.stop();
    expect(fatalErrors).toEqual([]);
  });

  test("RPC defects reach the supervisor with their original Panic identity", async () => {
    const { url, token, services, fatalErrors } = await fixture();
    const defect = new Panic({ message: "Native service invariant failed" });
    services.threads.sync = () => {
      throw defect;
    };
    const { client } = connect(url, token);
    await expect(client.threads.sync({ threadId: "shared" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBe(defect);
  });

  test("watch iteration defects reach the supervisor before protocol serialization", async () => {
    const { url, token, gateway, services, fatalErrors, fatal } = await fixture();
    const defect = new Panic({ message: "Native watch invariant failed" });
    services.threads.watch = () =>
      Result.ok(
        (async function* () {
          yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
          throw defect;
        })(),
      );
    const { client } = connect(url, token);
    const stream = await client.threads.watch({ threadId: "shared" });
    expect((await stream.next()).value).toMatchObject({ kind: "replay" });
    expect(await fatal).toBe(defect);
    const pending = stream.next().then(
      () => undefined,
      () => undefined,
    );
    await gateway.stop();
    await pending;
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBe(defect);
  });

  test("malformed socket envelopes close the connection without reporting a defect", async () => {
    const { url, token, fatalErrors } = await fixture();
    for (const frame of [
      "{",
      '{"i":"malformed","p":{}}',
      JSON.stringify({
        i: "multipart",
        p: {
          u: "/threads/sync",
          h: { "content-type": "multipart/form-data; boundary=bad" },
          b: {},
        },
      }),
    ]) {
      const { client, socket } = connect(url, token);
      await client.threads.sync({ threadId: "shared" });
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      socket.send(frame);
      expect((await closed).code).toBe(4400);
    }
    expect(fatalErrors).toEqual([]);
  });

  test("shutdown aborts authenticated uploads and waits for their storage cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    let storageClosed = false;
    let writesAfterClose = 0;
    let cleanupWrites = 0;
    let enteredCount = 0;
    const { url, token, gateway } = await fixture(undefined, {
      async handle(request, actorId) {
        expect(actorId).toBe("owner");
        enteredCount += 1;
        entered.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted.resolve();
            resolve();
          };
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
        await finishCleanup.promise;
        if (storageClosed) writesAfterClose += 1;
        cleanupWrites += 1;
        return new Response(null, { status: 409 });
      },
    });
    const { client, socket } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const socketClosed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    const upload = fetch(new URL("api/resources/upload", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "file",
    }).then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    let stopped = false;
    const stopping = gateway.stop().then(() => {
      stopped = true;
    });
    await aborted.promise;
    await socketClosed;
    expect(stopped).toBe(false);
    expect(gateway.start().isErr()).toBe(true);
    const refused = await fetch(new URL("api/resources/upload", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "late",
    }).then(
      (response) => response.status,
      () => 503,
    );
    expect(refused).toBe(503);
    expect(enteredCount).toBe(1);
    finishCleanup.resolve();
    await stopping;
    storageClosed = true;
    await upload;
    expect(cleanupWrites).toBe(1);
    expect(writesAfterClose).toBe(0);
    await gateway.stop();
    const restarted = gateway.start().unwrap();
    expect((await fetch(new URL("api/auth/info", restarted.url))).status).toBe(200);
  });

  test("SPA shell and immutable assets share the origin without filesystem traversal", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "native-gateway-"));
    cleanup.push(() => rmSync(temporary, { recursive: true, force: true }));
    const webRoot = path.join(temporary, "web");
    mkdirSync(path.join(webRoot, "assets"), { recursive: true });
    writeFileSync(path.join(webRoot, "index.html"), "<main>Lilac</main>");
    writeFileSync(path.join(webRoot, "assets", "app-fixture.js"), "export {};");
    writeFileSync(path.join(temporary, "secret.txt"), "private");
    const { url } = await fixture(webRoot);
    const shell = await fetch(new URL("threads/thread-id", url));
    expect(await shell.text()).toBe("<main>Lilac</main>");
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(new URL("assets/app-fixture.js", url));
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(new URL("assets/missing.js", url))).status).toBe(404);
    expect((await fetch(new URL("%2e%2e%2fsecret.txt", url))).status).toBe(404);
  });

  test("one socket delivers latest-first replay and deferred hydration", async () => {
    const { url, token } = await fixture();
    const { client } = connect(url, token);
    const events = [];
    for await (const event of await client.threads.watch({ threadId: "shared" }))
      events.push(event);
    expect(events[0]).toMatchObject({
      kind: "replay",
      reply: {
        kind: "window",
        slots: [
          { kind: "deferred", slotId: "older" },
          { kind: "ready", turnId: "turn_latest" },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      kind: "hydration",
      hydration: { slotId: "older", slots: [{ kind: "ready", turnId: "turn_old" }] },
    });
  });

  test("socket logout acknowledges before closing", async () => {
    const { url, token } = await fixture();
    const { socket, client } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    expect(await client.connection.logout({})).toEqual({ ok: true });
    expect((await closed).code).toBe(4401);
  });

  test("signed Clerk principals remain isolated across RPC and same-connection refresh", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const issuer = "https://fixture.clerk.accounts.dev";
    const auth = (
      await createNativeClerkAuthenticator({
        secretKey: "sk_test_fixture",
        oauthClientId: "client_fixture",
        publishableKey: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
        jwtKey: await exportSPKI(keys.publicKey),
        issuer,
        allowedOrigins: ["http://localhost"],
        resolveUser: async (id) =>
          ["alice", "bob"].includes(id)
            ? Result.ok({ userId: id })
            : Result.err(authFailure("forbidden", "Unknown user")),
      })
    ).unwrap();
    const sign = (id: string, expires: string | number = "1m") =>
      new SignJWT({ sid: `sess_${id}`, azp: "http://localhost" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "fixture" })
        .setIssuer(issuer)
        .setSubject(id)
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) - 1)
        .setExpirationTime(expires)
        .sign(keys.privateKey);
    const services = {
      threads: {
        sync: (principal: { userId: string }, input: { threadId: string }) =>
          input.threadId === principal.userId
            ? Result.ok({ kind: "unchanged", checkpoint })
            : Result.err(nativeFailure("forbidden", "Thread denied")),
      },
    } as unknown as NativeRpcServices;
    const gateway = createNativeGateway({
      hostname: "127.0.0.1",
      port: 0,
      auth,
      publicAuth: { provider: "clerk", issuer, oauthClientId: "client_fixture" },
      services,
      getViewer: (id) => Result.ok({ ...user, id }),
      reportFatalError: (error) => {
        throw error;
      },
    });
    const { url } = gateway.start().unwrap();
    cleanup.push(gateway.stop);
    const publicInfo = await fetch(new URL("api/auth/info", url));
    expect(publicInfo.headers.get("cache-control")).toContain("no-store");
    expect(await publicInfo.json()).toEqual({
      provider: "clerk",
      issuer,
      oauthClientId: "client_fixture",
    });
    const aliceToken = await sign("alice");
    const bobToken = await sign("bob");
    const alice = connect(url, aliceToken).client;
    const bob = connect(url, bobToken).client;
    expect((await alice.threads.sync({ threadId: "alice" })).kind).toBe("unchanged");
    expect((await bob.threads.sync({ threadId: "bob" })).kind).toBe("unchanged");
    await expect(alice.threads.sync({ threadId: "bob" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(alice.connection.reauthenticate({ token: bobToken })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await alice.connection.reauthenticate({ token: await sign("alice") })).id).toBe(
      "alice",
    );
    expect((await alice.threads.sync({ threadId: "alice" })).kind).toBe("unchanged");
    const shortLived = connect(url, await sign("alice", Math.floor(Date.now() / 1000) + 2));
    const expired = new Promise<CloseEvent>((resolve) =>
      shortLived.socket.addEventListener("close", resolve, { once: true }),
    );
    await shortLived.client.threads.sync({ threadId: "alice" });
    expect((await expired).code).toBe(4401);
  });

  test("bootstrap checks auth directly and oRPC preserves domain rejection identity", async () => {
    const { url, token } = await fixture();
    expect((await fetch(new URL("api/bootstrap", url))).status).toBe(401);
    const initial = await fetch(new URL("api/bootstrap", url), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(((await initial.json()) as { viewer: { id: string } }).viewer.id).toBe("owner");
    const { client } = connect(url, token);
    expect(await client.threads.sync({ threadId: "shared", checkpoint })).toEqual({
      kind: "unchanged",
      checkpoint,
    });
    await expect(client.threads.sync({ threadId: "private-other" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(() => nativeRpcValue(Result.err(nativeFailure("forbidden", "denied")))).toThrow(
      "denied",
    );
  });

  test("logout revokes open sockets and subsequent HTTP requests", async () => {
    const { url, token } = await fixture();
    const { socket, client } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    const logout = await fetch(new URL("api/auth/logout", url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    expect((await closed).code).toBe(4401);
    expect(
      (
        await fetch(new URL("api/bootstrap", url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("foreign origins and malformed checkpoint are rejected before bootstrap", async () => {
    const { url, token } = await fixture();
    expect(
      (
        await fetch(new URL("api/bootstrap", url), {
          headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(new URL("api/bootstrap?checkpoint=%7B", url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(422);
  });
});

test("real oRPC frames produce redacted replay and bootstrap measurements", async () => {
  const { url, token, metrics, measurements } = await fixture();
  metrics.committed("thread", 1, 0, "request");
  const bootstrap = await fetch(new URL("api/bootstrap", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(bootstrap.status).toBe(200);
  const { client } = connect(url, token);
  const stream = await client.threads.watch({ threadId: "thread" });
  expect((await stream.next()).value).toMatchObject({ kind: "replay" });
  await stream.return?.();
  expect(measurements.find((item) => item.event === "bootstrap.complete")?.fields.status).toBe(200);
  const replay = measurements.find((item) => item.event === "replay.enqueue")?.fields;
  expect(replay).toMatchObject({
    threadId: "thread",
    requestId: "request",
    kind: "window",
    cacheReset: false,
  });
  expect(replay?.commitToSocketEnqueueMs).toBeGreaterThanOrEqual(0);
  expect(replay?.bytes).toBeGreaterThan(0);
  expect(JSON.stringify(measurements)).not.toContain(token);
});
