import { createHash, timingSafeEqual } from "node:crypto";
import { Result } from "better-result";
import { authFailure, nativeBearer, type NativeAuthenticator, type NativePrincipal } from "./auth";
import type { NativeExecution } from "./execution";
import type { NativeStore } from "./store";

export const NATIVE_OPERATOR_PORT = 8788;
export const OPERATOR_GRACE_MS = 30_000;

export function createNativeOperator(options: {
  tokenSha256: string;
  ownerId: string;
  store: NativeStore;
  execution: Pick<NativeExecution, "deleteThread">;
  now?: () => number;
}) {
  const { store, execution, ownerId } = options;
  const now = options.now ?? Date.now;
  const digest = Buffer.from(options.tokenSha256, "hex");

  function credential(request: Request) {
    const token = nativeBearer(request);
    const sessionId = request.headers.get("x-lilac-operator-session");
    if (
      request.headers.has("origin") ||
      !token ||
      !sessionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
      digest.length !== 32 ||
      !timingSafeEqual(createHash("sha256").update(token).digest(), digest)
    )
      return Result.err(authFailure("unauthorized", "Operator authentication required"));
    return Result.ok<NativePrincipal>({
      userId: ownerId,
      providerUserId: `operator:${ownerId}`,
      provider: "operator",
      sessionId,
      expiresAt: Math.floor((now() + 60_000) / 1000),
    });
  }

  function checkSession(principal: NativePrincipal) {
    return store
      .getEphemeralThread(principal.sessionId)
      .mapError(() => authFailure("unavailable", "Temporary conversation is unavailable"))
      .andThen((thread) => {
        if (
          !thread?.ephemeral ||
          thread.deleted ||
          thread.mutationPending ||
          thread.ephemeral.lastSeenAt + OPERATOR_GRACE_MS <= now()
        )
          return Result.err(authFailure("expired", "Temporary conversation has ended"));
        return Result.ok();
      });
  }

  const auth: NativeAuthenticator = {
    checkSession,
    async authenticate(request) {
      return credential(request).andThen((principal) =>
        checkSession(principal).map(() => principal),
      );
    },
    async reauthenticate(current, request) {
      const headers = new Headers(request.headers);
      headers.set("x-lilac-operator-session", current.sessionId);
      return auth.authenticate(new Request(request.url, { headers }));
    },
    async logout(request) {
      return Result.gen(async function* () {
        const principal = yield* credential(request);
        yield* (await end(principal.sessionId)).mapError(() =>
          authFailure("unavailable", "Temporary conversation cleanup failed"),
        );
        return Result.ok({ setCookie: "" });
      });
    },
  };

  async function end(sessionId: string) {
    return Result.gen(async function* () {
      const thread = yield* store.getEphemeralThread(sessionId);
      if (!thread || (thread.deleted && !thread.mutationPending)) return Result.ok();
      yield* Result.await(
        execution.deleteThread(ownerId, {
          threadId: thread.id,
          commandId: `operator-end:${sessionId}`,
        }),
      );
      return Result.ok();
    });
  }

  async function handle(request: Request): Promise<Response> {
    const response = await Result.gen(async function* () {
      const principal = yield* credential(request);
      if (request.method === "DELETE") {
        yield* Result.await(end(principal.sessionId));
        return Result.ok({ ok: true });
      }
      if (request.method !== "POST")
        return Result.err(authFailure("forbidden", "Method not allowed"));
      const existing = yield* store.getEphemeralThread(principal.sessionId);
      if (existing) yield* checkSession(principal);
      const thread =
        existing ??
        (yield* store.createThread(ownerId, {
          commandId: `operator-start:${principal.sessionId}`,
          title: "Temporary conversation",
          autoTitle: false,
          ephemeralSessionId: principal.sessionId,
        }));
      yield* store.touchEphemeralThread(thread.id);
      return Result.ok({ threadId: thread.id });
    });
    return response.match({
      ok: (value) => Response.json(value, { headers: { "cache-control": "no-store" } }),
      err: () =>
        Response.json(
          { error: "Temporary conversation is unavailable or has ended" },
          { status: 401, headers: { "cache-control": "no-store" } },
        ),
    });
  }

  async function reap(abandoned = false) {
    return Result.gen(async function* () {
      const threads = yield* store.listEphemeralThreads();
      for (const thread of threads) {
        if (!thread.ephemeral) continue;
        if (
          !abandoned &&
          !thread.deleted &&
          thread.ephemeral.lastSeenAt + OPERATOR_GRACE_MS > now()
        )
          continue;
        yield* Result.await(end(thread.ephemeral.sessionId));
      }
      return Result.ok();
    });
  }

  return { auth, handle, reap };
}
