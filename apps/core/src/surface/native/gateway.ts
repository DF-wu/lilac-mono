import path from "node:path";
import { RPCHandler } from "@orpc/server/bun-ws";
import { AsyncIteratorClass, onError, ORPCError } from "@orpc/server";
import {
  bootstrapInputSchema,
  type NativeUser,
  type BootstrapInput,
} from "@stanley2058/lilac-client-protocol";
import { Result, TaggedError } from "better-result";
import { z } from "zod";
import { createNativeMetrics, type NativeMetrics } from "./metrics";
import { captureError } from "../../shared/error-capture";
import type { NativeAuthenticator, NativeAuthError, NativeLogin, NativePrincipal } from "./auth";
import {
  createNativeRouter,
  type NativeRpcContext,
  type NativeRpcServices,
  type NativeServiceError,
} from "./rpc";

export class NativeGatewayError extends TaggedError("NativeGatewayError")<{ message: string }> {}
export type NativeGatewayOptions = {
  metrics?: NativeMetrics;
  hostname: string;
  port: number;
  auth: NativeAuthenticator;
  publicAuth: {
    provider: "local" | "clerk";
    publishableKey?: string;
    issuer?: string;
    oauthClientId?: string;
  };
  login?: (request: Request, clientKey: string) => Promise<Result<NativeLogin, NativeAuthError>>;
  services: NativeRpcServices;
  getViewer: (userId: string) => Result<NativeUser, NativeServiceError>;
  reportFatalError: (error: Error) => void;
  resources?: { handle: (request: Request, actorId: string) => Promise<Response | undefined> };
  webRoot?: string;
};
type Peer = { send: (message: string | ArrayBufferLike | Uint8Array) => number };
type SocketData = {
  metrics: ReturnType<NativeMetrics["connection"]>;
  context: NativeRpcContext;
  peer?: Peer;
  expiry?: ReturnType<typeof setTimeout>;
  inflight: number;
  budget: number;
  refill: number;
  ending?: boolean;
};

const logoutReceiptSchema = z.object({
  p: z.object({ b: z.object({ json: z.strictObject({ ok: z.literal(true) }) }) }),
});

const nativeFrameSchema = z.union([
  z.object({
    i: z.string().min(1).max(128),
    t: z.literal(1).optional(),
    p: z.object({
      u: z.string().refine((value) => value.startsWith("/") || URL.canParse(value)),
      m: z.string().optional(),
      h: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .refine((headers) =>
          Object.entries(headers).every(([name, value]) => {
            if (name.toLowerCase() === "content-disposition") return false;
            if (name.toLowerCase() !== "content-type") return true;
            return (
              typeof value === "string" &&
              value.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
            );
          }),
        )
        .optional(),
      b: z.unknown().optional(),
    }),
  }),
  z.object({ i: z.string().min(1).max(128), t: z.literal(4) }),
]);

function validateNativeFrame(message: string): Result<void, NativeGatewayError> {
  return Result.try({
    try: (): unknown => JSON.parse(message),
    catch: () => new NativeGatewayError({ message: "Invalid socket frame" }),
  }).andThen((value) =>
    nativeFrameSchema.safeParse(value).success
      ? Result.ok()
      : Result.err(new NativeGatewayError({ message: "Invalid socket frame" })),
  );
}

function observeNativeGatewayFailure(error: unknown, report: (error: Error) => void): void {
  if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") return;
  if (error instanceof ORPCError && error.cause instanceof Error) {
    report(error.cause);
    return;
  }
  report(captureError(error).cause);
}

function rethrowNativeGatewayFailure(error: Error): never {
  throw error;
}

async function observeNativeIteratorStep<T>(
  operation: () => Promise<T>,
  report: (error: Error) => void,
): Promise<T> {
  const captured = await Result.tryPromise({ try: operation, catch: captureError });
  const settle = captured.match({
    ok: (value) => () => value,
    err: (failure) => () => {
      observeNativeGatewayFailure(failure.cause, report);
      return rethrowNativeGatewayFailure(failure.cause);
    },
  });
  return settle();
}

function observeNativeIterator<T, TReturn, TNext>(
  iterator: AsyncIteratorClass<T, TReturn, TNext>,
  report: (error: Error) => void,
): AsyncIteratorClass<T, TReturn, TNext> {
  return new AsyncIteratorClass(
    () => observeNativeIteratorStep(() => iterator.next(), report),
    async (reason) => {
      if (reason === "next") return;
      await observeNativeIteratorStep(() => iterator.return(), report);
    },
  );
}

function isLogoutReceipt(message: string | ArrayBufferLike | Uint8Array): boolean {
  if (typeof message !== "string" || message.length > 512) return false;
  return Result.try({
    try: (): unknown => JSON.parse(message),
    catch: () => new Error("Invalid logout receipt"),
  }).match({ ok: (value) => logoutReceiptSchema.safeParse(value).success, err: () => false });
}

function privateJson(value: object, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function httpFailure(error: NativeServiceError): Response {
  switch (error.code) {
    case "unauthorized":
    case "expired":
      return privateJson({ error: "Authentication required" }, 401);
    case "forbidden":
      return privateJson({ error: error.message }, 403);
    case "not-found":
      return privateJson({ error: "Not found" }, 404);
    case "conflict":
    case "stale":
      return privateJson({ error: error.message }, 409);
    case "invalid":
    case "handshake":
      return privateJson({ error: error.message }, 422);
    case "rate_limited":
      return privateJson({ error: error.message }, 429);
    default:
      return privateJson({ error: "Native service is unavailable" }, 503);
  }
}

const jsonCheckpointSchema = z
  .string()
  .max(2048)
  .transform((value, context): unknown => {
    return Result.try({
      try: (): unknown => JSON.parse(value),
      catch: () => new Error("Invalid checkpoint"),
    }).match({
      ok: (parsed) => parsed,
      err: () => {
        context.addIssue({ code: "custom", message: "Invalid checkpoint" });
        return z.NEVER;
      },
    });
  });

function bootstrapInput(url: URL): Result<BootstrapInput, NativeGatewayError> {
  const checkpoint = url.searchParams.get("checkpoint");
  const decoded = checkpoint === null ? undefined : jsonCheckpointSchema.safeParse(checkpoint);
  if (decoded && !decoded.success)
    return Result.err(new NativeGatewayError({ message: "Invalid checkpoint" }));
  const parsed = bootstrapInputSchema.safeParse({
    ...(url.searchParams.has("threadId") ? { threadId: url.searchParams.get("threadId") } : {}),
    ...(url.searchParams.has("catalogRevision")
      ? { catalogRevision: url.searchParams.get("catalogRevision") }
      : {}),
    ...(decoded?.success ? { checkpoint: decoded.data } : {}),
  });
  if (!parsed.success)
    return Result.err(new NativeGatewayError({ message: "Invalid bootstrap request" }));
  return Result.ok(parsed.data);
}

async function staticResponse(request: Request, webRoot: string | undefined): Promise<Response> {
  if (!webRoot || request.method !== "GET") return privateJson({ error: "Not found" }, 404);
  const pathname = new URL(request.url).pathname;
  const decoded = Result.try({
    try: () => decodeURIComponent(pathname),
    catch: () => new Error("Invalid path"),
  }).match({ ok: (value) => value, err: () => undefined });
  if (!decoded || decoded.includes("\0") || decoded.includes("\\"))
    return privateJson({ error: "Not found" }, 404);
  const root = path.resolve(webRoot);
  const filePath = path.resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`))
    return privateJson({ error: "Not found" }, 404);
  const asset = Bun.file(filePath);
  if (path.extname(filePath) && (await asset.exists())) {
    const immutable = pathname.startsWith("/assets/");
    return new Response(asset, {
      headers: {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (path.extname(filePath)) return privateJson({ error: "Not found" }, 404);
  const shell = Bun.file(path.join(root, "index.html"));
  if (!(await shell.exists())) return privateJson({ error: "Web client is not built" }, 503);
  return new Response(shell, {
    headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  });
}

export function createNativeGateway(options: NativeGatewayOptions) {
  const metrics = options.metrics ?? createNativeMetrics();
  const handler = new RPCHandler(createNativeRouter(options.services, options.getViewer), {
    clientInterceptors: [
      onError((error) => observeNativeGatewayFailure(error, options.reportFatalError)),
      async ({ next }) => {
        const output = await next();
        if (!(output instanceof AsyncIteratorClass)) return output;
        return observeNativeIterator(output, options.reportFatalError);
      },
    ],
  });
  let server: Bun.Server<SocketData> | undefined;
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const requests = new Set<Promise<Response | undefined>>();
  const rpcOperations = new Set<Promise<void>>();
  const requestControllers = new Set<AbortController>();
  let accepting = false;
  let stopPromise: Promise<void> | undefined;
  let stopFinished = false;

  function closeSession(sessionId: string): void {
    for (const socket of sockets)
      if (socket.data.context.principal.sessionId === sessionId)
        socket.close(4401, "Session ended");
  }

  function scheduleExpiry(socket: Bun.ServerWebSocket<SocketData>): void {
    clearTimeout(socket.data.expiry);
    const delay = Math.max(0, socket.data.context.principal.expiresAt * 1000 - Date.now());
    socket.data.expiry = setTimeout(
      () => socket.close(4401, "Authentication expired"),
      Math.min(delay, 2_147_483_647),
    );
  }

  async function authenticateRequest(
    request: Request,
    running: Bun.Server<SocketData>,
    original: Request,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const isSocket = url.pathname === "/api/socket";
    const principal = await options.auth.authenticate(request, {
      socket: isSocket,
      mutation: request.method !== "GET" && request.method !== "HEAD",
    });
    const decision = principal.match<{ principal: NativePrincipal } | { response: Response }>({
      ok: (value) => ({ principal: value }),
      err: (error) => ({ response: httpFailure(error) }),
    });
    if ("response" in decision) return decision.response;
    if (!accepting || request.signal.aborted) return privateJson({ error: "Server stopping" }, 503);
    const user = decision.principal;
    if (isSocket) {
      if (request.method !== "GET") return privateJson({ error: "Method not allowed" }, 405);
      const context: NativeRpcContext = {
        principal: user,
        request,
        auth: options.auth,
        refreshed: () => {},
        loggedOut: () => closeSession(user.sessionId),
      };
      if (
        running.upgrade(original, {
          data: {
            context,
            metrics: metrics.connection(),
            inflight: 0,
            budget: 120,
            refill: Date.now(),
          },
        })
      )
        return;
      return privateJson({ error: "WebSocket upgrade required" }, 426);
    }
    if (url.pathname === "/api/bootstrap" && request.method === "GET") {
      const input = bootstrapInput(url).match<{ input: BootstrapInput } | { response: Response }>({
        ok: (value) => ({ input: value }),
        err: () => ({ response: privateJson({ error: "Invalid bootstrap request" }, 422) }),
      });
      if ("response" in input) return input.response;
      return (await options.services.bootstrap.get(user, input.input, request.signal)).match({
        ok: (value) => privateJson(value),
        err: httpFailure,
      });
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const result = await options.auth.logout(request);
      const response = result.match({
        ok: (value) => privateJson({ ok: true }, 200, { "set-cookie": value.setCookie }),
        err: httpFailure,
      });
      if (response.ok) closeSession(user.sessionId);
      return response;
    }
    if (options.resources) {
      const resource = await options.resources.handle(request, user.userId);
      if (resource) return resource;
    }
    return privateJson({ error: "Not found" }, 404);
  }

  async function routeRequest(
    request: Request,
    running: Bun.Server<SocketData>,
    original: Request,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/info" && request.method === "GET")
      return privateJson(options.publicAuth);
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!options.login) return privateJson({ error: "Local login is disabled" }, 404);
      const login = await options.login(request, running.requestIP(original)?.address ?? "unknown");
      return login.match({
        ok: (value) =>
          privateJson({ token: value.token, expiresAt: value.principal.expiresAt }, 200, {
            "set-cookie": value.setCookie,
          }),
        err: httpFailure,
      });
    }
    if (url.pathname.startsWith("/api/")) return authenticateRequest(request, running, original);
    return staticResponse(request, options.webRoot);
  }

  function fetch(
    request: Request,
    running: Bun.Server<SocketData>,
  ): Promise<Response | undefined> | Response {
    if (!accepting) return privateJson({ error: "Server stopping" }, 503);
    const controller = new AbortController();
    const linked = new Request(request, {
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    requestControllers.add(controller);
    const operation = captureRequest(linked, running, request);
    requests.add(operation);
    const finished = () => {
      requests.delete(operation);
      requestControllers.delete(controller);
    };
    void operation.then(finished);
    return operation;
  }

  async function captureRequest(
    request: Request,
    running: Bun.Server<SocketData>,
    original: Request,
  ): Promise<Response | undefined> {
    const started = performance.now();
    const captured = await Result.tryPromise({
      try: () => routeRequest(request, running, original),
      catch: captureError,
    });
    if (captured.isErr()) {
      options.reportFatalError(captured.error.cause);
      return privateJson({ error: "Native service is unavailable" }, 503);
    }
    const response = captured.match({ ok: (value) => value, err: () => undefined });
    if (new URL(request.url).pathname === "/api/bootstrap")
      metrics.bootstrap(performance.now() - started, response?.status ?? 503);
    return response;
  }

  async function deliverSocketMessage(
    socket: Bun.ServerWebSocket<SocketData>,
    message: string | Buffer,
  ): Promise<void> {
    if (!accepting) {
      socket.close(1001, "Server stopping");
      return;
    }
    const data = socket.data;
    const time = Date.now();
    data.budget = Math.min(120, data.budget + (time - data.refill) * 0.12) - 1;
    data.refill = time;
    if (typeof message !== "string" || data.budget < 0 || data.inflight >= 64 || !data.peer) {
      data.metrics.pressure(data.inflight);
      socket.close(4408, "Connection limit exceeded");
      return;
    }
    data.metrics.received(message, data.inflight);
    const valid = validateNativeFrame(message).match({ ok: () => true, err: () => false });
    if (!valid) {
      socket.close(4400, "Socket protocol failed");
      return;
    }
    data.inflight += 1;
    const delivered = await Result.tryPromise({
      try: () => handler.message(data.peer!, message, { context: data.context }),
      catch: captureError,
    });
    data.inflight -= 1;
    const failure = delivered.match({ ok: () => null, err: (error) => error.cause });
    if (!failure) return;
    if (failure.name === "AbortError" && !sockets.has(socket)) return;
    options.reportFatalError(failure);
    socket.close(1011, "Socket operation failed");
  }

  function start(): Result<{ url: string }, NativeGatewayError> {
    if (server) return Result.ok({ url: server.url.toString() });
    if (stopPromise && !stopFinished)
      return Result.err(new NativeGatewayError({ message: "Native gateway is stopping" }));
    return Result.try({
      try: () =>
        Bun.serve<SocketData>({
          hostname: options.hostname,
          port: options.port,
          maxRequestBodySize: 512 * 1024 * 1024,
          fetch,
          websocket: {
            maxPayloadLength: 2 * 1024 * 1024,
            backpressureLimit: 2 * 1024 * 1024,
            closeOnBackpressureLimit: true,
            idleTimeout: 120,
            open(socket) {
              if (!accepting) {
                socket.close(1001, "Server stopping");
                return;
              }
              sockets.add(socket);
              socket.data.metrics.opened();
              socket.data.context.refreshed = () => scheduleExpiry(socket);
              socket.data.context.loggedOut = () => {
                socket.data.ending = true;
                for (const peer of sockets)
                  if (
                    peer !== socket &&
                    peer.data.context.principal.sessionId ===
                      socket.data.context.principal.sessionId
                  )
                    peer.close(4401, "Session ended");
              };
              socket.data.peer = {
                send(message) {
                  const active = options.auth
                    .checkSession(socket.data.context.principal)
                    .match({ ok: () => true, err: () => false });
                  if (!active) {
                    if (socket.data.ending && !isLogoutReceipt(message)) return 0;
                    if (!socket.data.ending) {
                      socket.close(4401, "Authentication expired");
                      return 0;
                    }
                  }
                  const sent = socket.send(message);
                  socket.data.metrics.sent(message, sent, socket.getBufferedAmount());
                  if (socket.data.ending) {
                    socket.data.ending = false;
                    setImmediate(() => socket.close(4401, "Session ended"));
                  }
                  return sent;
                },
              };
              scheduleExpiry(socket);
            },
            message(socket, message) {
              const operation = deliverSocketMessage(socket, message);
              rpcOperations.add(operation);
              void operation.then(() => rpcOperations.delete(operation));
              return operation;
            },
            close(socket, code) {
              socket.data.metrics.closed(code);
              sockets.delete(socket);
              clearTimeout(socket.data.expiry);
              if (socket.data.peer) handler.close(socket.data.peer);
            },
          },
        }),
      catch: () => new NativeGatewayError({ message: "Cannot start native gateway" }),
    }).map((running) => {
      server = running;
      accepting = true;
      stopPromise = undefined;
      stopFinished = false;
      return { url: running.url.toString() };
    });
  }

  async function drainRequests(): Promise<void> {
    await Promise.allSettled(requests);
    await Promise.allSettled(rpcOperations);
    stopFinished = true;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    accepting = false;
    for (const socket of sockets) {
      clearTimeout(socket.data.expiry);
      socket.close(1001, "Server stopping");
      if (socket.data.peer) handler.close(socket.data.peer);
    }
    sockets.clear();
    for (const controller of requestControllers) controller.abort();
    server?.stop(true);
    server = undefined;
    stopPromise = drainRequests();
    return stopPromise;
  }
  return { start, stop };
}
