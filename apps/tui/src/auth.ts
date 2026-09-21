import { Result, TaggedError } from "better-result";
import { z } from "zod";

export const OPERATOR_URL = "http://127.0.0.1:8788";
const replySchema = z.strictObject({ threadId: z.string().min(1) });

export class TuiAuthError extends TaggedError("TuiAuthError")<{
  code: "network" | "configuration" | "login";
  message: string;
}> {}
export interface TuiAuthSession {
  readonly token: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly expiresAt: number;
  authorization(): string;
  refresh(): Promise<Result<void, TuiAuthError>>;
  logout(): Promise<Result<void, TuiAuthError>>;
  dispose(): void;
}

export function decodeOperatorSession(value: unknown): Result<string, TuiAuthError> {
  const parsed = replySchema.safeParse(value);
  if (!parsed.success)
    return Result.err(
      new TuiAuthError({ code: "login", message: "Invalid operator session response" }),
    );
  return Result.ok(parsed.data.threadId);
}

export async function createTuiAuth(
  options: { tokenFile?: string; baseUrl?: string } = {},
): Promise<Result<TuiAuthSession, TuiAuthError>> {
  const baseUrl = options.baseUrl ?? OPERATOR_URL;
  const sessionId = crypto.randomUUID();
  const lifetime = new AbortController();
  return Result.gen(async function* () {
    const token = (yield* Result.await(
      Result.tryPromise({
        try: () => Bun.file(options.tokenFile ?? "/run/lilac/operator-token").text(),
        catch: () =>
          new TuiAuthError({
            code: "configuration",
            message:
              "Run lilac-tui inside the container as root. The operator token is not readable.",
          }),
      }),
    )).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Result.err(
        new TuiAuthError({ code: "configuration", message: "Invalid operator token file" }),
      );
    let expiresAt = Date.now() / 1000 + 30;
    async function request(method: "POST" | "DELETE") {
      return Result.gen(async function* () {
        const response = yield* Result.await(
          Result.tryPromise({
            try: () =>
              fetch(new URL("/api/operator/session", baseUrl), {
                method,
                headers: {
                  authorization: `Bearer ${token}`,
                  "x-lilac-operator-session": sessionId,
                },
                redirect: "error",
                signal:
                  method === "DELETE"
                    ? lifetime.signal
                    : AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
              }),
            catch: () =>
              new TuiAuthError({
                code: "network",
                message: "Cannot reach the local operator console",
              }),
          }),
        );
        if (!response.ok)
          return Result.err(
            new TuiAuthError({
              code: "login",
              message: "Temporary conversation has ended. Restart lilac-tui to start another.",
            }),
          );
        return Result.ok(response);
      });
    }
    const response = yield* Result.await(request("POST"));
    const data = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () =>
          new TuiAuthError({ code: "login", message: "Invalid operator session response" }),
      }),
    );
    const threadId = yield* decodeOperatorSession(data);
    return Result.ok({
      token,
      sessionId,
      threadId,
      get expiresAt() {
        return expiresAt;
      },
      authorization: () => `Bearer ${token}`,
      async refresh() {
        return (await request("POST")).map(() => {
          expiresAt = Date.now() / 1000 + 30;
        });
      },
      async logout() {
        return (await request("DELETE")).map(() => undefined);
      },
      dispose() {
        lifetime.abort();
      },
    });
  });
}
