import {
  clearCodexTokensResult,
  getCodexAuthStoragePath,
  readCodexTokensResult,
  startCodexOAuthLogin,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";
import { z } from "zod";
import { Panic, Result, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function captureCodexFailure(cause: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(cause)) return { cause };
  if (cause instanceof Error) return { cause };
  return { cause: new Error("Codex operation failed", { cause }) };
}

async function settleCapturedPromise<T, E>(
  result: Promise<ResultType<T, { readonly cause: Error | Panic }>>,
  resolve: (cause: Error | Panic) => E,
): Promise<ResultType<T, E>> {
  return (await result).mapError(({ cause }) => resolve(cause));
}

function codexFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `codex_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

async function observeCodexLogin(
  login: CodexOAuthLogin,
): Promise<ResultType<void, ServerToolFailure>> {
  return (
    await settleCapturedPromise(
      Result.tryPromise({
        try: () => login.result,
        catch: captureCodexFailure,
      }),
      (cause) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return codexFailure("unavailable", cause.message);
      },
    )
  ).map(() => undefined);
}

const loginInputSchema = z
  .object({
    mode: z
      .enum(["start", "exchange"])
      .describe(
        "start: returns a URL to open in a browser; exchange: manually paste callback URL/code.",
      ),
    callbackUrl: z
      .string()
      .optional()
      .describe(
        "Callback URL from the browser (e.g. http://localhost:1455/auth/callback?code=...&state=...).",
      ),
    code: z.string().optional().describe("Authorization code (if you extracted it manually)."),
    state: z.string().optional().describe("State value (if you extracted it manually)."),
    pkceVerifier: z.string().optional().describe("PKCE code verifier (from the start step)."),
  })
  .superRefine((input, context) => {
    if (input.mode === "start") return;
    if (!input.callbackUrl && !input.code) {
      context.addIssue({
        code: "custom",
        message: "exchange mode requires either callbackUrl or code.",
      });
    }
    if (input.code && !input.callbackUrl && !input.state) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "exchange mode with a manual code requires state from the start step.",
      });
    }
    if (!input.pkceVerifier) {
      context.addIssue({
        code: "custom",
        path: ["pkceVerifier"],
        message: "exchange mode requires pkceVerifier from the start step.",
      });
    }
  });

const statusInputSchema = z.object({});
const logoutInputSchema = z.object({});

let pending: CodexOAuthLogin | null = null;
let pendingGeneration = 0;
let pendingTransition = Promise.resolve();

async function runPendingTransition<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pendingTransition;
  let release = () => {};
  pendingTransition = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return await operation().finally(release);
}

export type CodexDependencies = {
  startLogin: typeof startCodexOAuthLogin;
  readTokens: typeof readCodexTokensResult;
  clearTokens: typeof clearCodexTokensResult;
  storagePath: typeof getCodexAuthStoragePath;
};

const defaultDependencies: CodexDependencies = {
  startLogin: startCodexOAuthLogin,
  readTokens: readCodexTokensResult,
  clearTokens: clearCodexTokensResult,
  storagePath: getCodexAuthStoragePath,
};

export class Codex implements ServerTool {
  id = "codex";

  private readonly tool = defineServerTool({
    id: this.id,
    destroy: async () => {
      pendingGeneration += 1;
      await runPendingTransition(async () => {
        const login = pending;
        pending = null;
        await login?.close();
      });
    },
    callables: ({ callable }) => ({
      "codex.login": callable({
        name: "Codex Login",
        description: [
          "Authenticate to OpenAI Codex via ChatGPT OAuth.",
          "Use mode=start to get a browser URL. If the localhost callback doesn't work, use mode=exchange and paste the callback URL.",
        ].join("\n"),
        inputSchema: loginInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("codex.login", input),
      }),
      "codex.status": callable({
        name: "Codex Status",
        description: "Show whether Codex OAuth tokens are configured.",
        inputSchema: statusInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("codex.status", input),
      }),
      "codex.logout": callable({
        name: "Codex Logout",
        description: "Clear stored Codex OAuth tokens.",
        inputSchema: logoutInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("codex.logout", input),
      }),
    }),
  });

  constructor(private readonly dependencies: CodexDependencies = defaultDependencies) {}

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    if (
      callableId !== "codex.login" &&
      callableId !== "codex.status" &&
      callableId !== "codex.logout"
    ) {
      return Result.err(codexFailure("usage", "Invalid callable ID"));
    }
    return this.tool.call(callableId, input, opts);
  }

  private async runCallable(
    callableId: "codex.login" | "codex.status" | "codex.logout",
    input: Record<string, unknown>,
  ): Promise<ServerToolResult> {
    if (callableId === "codex.login") {
      const payload = input as z.output<typeof loginInputSchema>;
      if (payload.mode === "start") {
        const generation = ++pendingGeneration;
        return (
          await settleCapturedPromise(
            Result.tryPromise({
              try: () =>
                runPendingTransition(async () => {
                  if (generation !== pendingGeneration) {
                    return Result.err(codexFailure("conflict", "Codex OAuth login was superseded"));
                  }
                  const previous = pending;
                  pending = null;
                  await previous?.close();
                  if (generation !== pendingGeneration) {
                    return Result.err(codexFailure("conflict", "Codex OAuth login was superseded"));
                  }

                  const login = await this.dependencies.startLogin({ callbackServer: "optional" });
                  if (generation !== pendingGeneration) {
                    await login.close();
                    return Result.err(codexFailure("conflict", "Codex OAuth login was superseded"));
                  }
                  pending = login;
                  void observeCodexLogin(login).then(() => {
                    if (pending === login) pending = null;
                  });
                  return Result.ok({
                    step: "start" as const,
                    authorizeUrl: login.authorizeUrl,
                    redirectUri: login.redirectUri,
                    port: login.port,
                    state: login.state,
                    pkceVerifier: login.pkce.verifier,
                    storagePath: login.storagePath,
                    instructions: [
                      "1) Open authorizeUrl in your browser.",
                      "2) Sign in and approve.",
                      "3) The localhost callback exchanges and stores tokens automatically. If it cannot connect, run codex.login mode=exchange with callbackUrl and pkceVerifier. A manually extracted code also requires state.",
                    ].join("\n"),
                  });
                }),
              catch: captureCodexFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return codexFailure("unavailable", cause.message);
            },
          )
        ).andThen((result) => result);
      }

      if (!pending) {
        return Result.err(
          codexFailure(
            "conflict",
            "Missing PKCE challenge. Re-run codex.login mode=start before manual exchange.",
          ),
        );
      }
      const login = pending;
      return (
        await settleCapturedPromise(
          Result.tryPromise({
            try: () => login.exchange(payload),
            catch: captureCodexFailure,
          }),
          (cause) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return codexFailure("denied", cause.message);
          },
        )
      ).map((result) => {
        if (pending === login) pending = null;
        return { step: "exchange" as const, ...result };
      });
    }

    if (callableId === "codex.status") {
      const loaded = await this.dependencies.readTokens();
      return loaded.match<() => ServerToolResult>({
        ok:
          ({ value: tokens }) =>
          () =>
            Result.ok({
              configured: tokens !== null,
              storagePath: this.dependencies.storagePath(),
              expires: tokens?.expires,
              accountId: tokens?.accountId,
            }),
        err: (error) => () => {
          if (Panic.is(error)) return preserveToolPanic(error);
          switch (error._tag) {
            case "CodexTokensReadFailed":
              if (error.operation === "inspect") {
                return Result.err(codexFailure("unavailable", error.message));
              }
              return Result.ok({
                configured: false,
                storagePath: this.dependencies.storagePath(),
              });
            case "CodexTokensMalformed":
            case "CodexTokensCorrupt":
            case "CodexTokensUnsupportedVersion":
              return Result.ok({
                configured: false,
                storagePath: this.dependencies.storagePath(),
              });
          }
        },
      })();
    }

    if (callableId === "codex.logout") {
      pendingGeneration += 1;
      return (
        await settleCapturedPromise(
          Result.tryPromise({
            try: () =>
              runPendingTransition(async () => {
                const login = pending;
                pending = null;
                await login?.close();
                const cleared = await this.dependencies.clearTokens();
                return cleared.match<() => ServerToolResult>({
                  ok: () => () =>
                    Result.ok({ ok: true as const, storagePath: this.dependencies.storagePath() }),
                  err: (error) => () => {
                    if (Panic.is(error)) return preserveToolPanic(error);
                    return Result.err(codexFailure("unavailable", error.message));
                  },
                })();
              }),
            catch: captureCodexFailure,
          }),
          (cause) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return codexFailure("unavailable", cause.message);
          },
        )
      ).andThen((result) => result);
    }
    return Result.err(codexFailure("internal", `Unhandled callable ID '${callableId}'`));
  }
}
