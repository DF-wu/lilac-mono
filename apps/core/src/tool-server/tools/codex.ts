import {
  clearCodexTokensResult,
  getCodexAuthStoragePath,
  readCodexTokensResult,
  startCodexOAuthLogin,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { ServerTool } from "../types";
import { parseToolInputPreservingZodError as parseToolInput } from "../validation-error-message";
import { zodObjectToCliLines } from "./zod-cli";

class CodexToolFailure extends TaggedError("CodexToolFailure")<{
  readonly message: string;
}> {}

function adaptCodexResultToToolHost<TValue>(result: ResultType<TValue, CodexToolFailure>): TValue {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function signalCodexFailureToToolHost(message: string): never {
  return adaptCodexResultToToolHost(Result.err(new CodexToolFailure({ message })));
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
  try {
    return await operation();
  } finally {
    release();
  }
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

  constructor(private readonly dependencies: CodexDependencies = defaultDependencies) {}

  async init(): Promise<void> {}

  async destroy(): Promise<void> {
    pendingGeneration += 1;
    await runPendingTransition(async () => {
      const login = pending;
      pending = null;
      await login?.close();
    });
  }

  async list() {
    return [
      {
        callableId: "codex.login",
        name: "Codex Login",
        description: [
          "Authenticate to OpenAI Codex via ChatGPT OAuth.",
          "Use mode=start to get a browser URL. If the localhost callback doesn't work, use mode=exchange and paste the callback URL.",
        ].join("\n"),
        shortInput: zodObjectToCliLines(loginInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(loginInputSchema),
        hidden: true,
      },
      {
        callableId: "codex.status",
        name: "Codex Status",
        description: "Show whether Codex OAuth tokens are configured.",
        shortInput: [],
        input: zodObjectToCliLines(statusInputSchema),
        hidden: true,
      },
      {
        callableId: "codex.logout",
        name: "Codex Logout",
        description: "Clear stored Codex OAuth tokens.",
        shortInput: [],
        input: zodObjectToCliLines(logoutInputSchema),
        hidden: true,
      },
    ];
  }

  async call(callableId: string, input: Record<string, unknown>): Promise<unknown> {
    if (callableId === "codex.login") {
      const payload = parseToolInput({ callableId, input, schema: loginInputSchema });
      if (payload.mode === "start") {
        const generation = ++pendingGeneration;
        return runPendingTransition(async () => {
          if (generation !== pendingGeneration) {
            signalCodexFailureToToolHost("Codex OAuth login was superseded");
          }
          const previous = pending;
          pending = null;
          await previous?.close();
          if (generation !== pendingGeneration) {
            signalCodexFailureToToolHost("Codex OAuth login was superseded");
          }

          const login = await this.dependencies.startLogin({ callbackServer: "optional" });
          if (generation !== pendingGeneration) {
            await login.close();
            signalCodexFailureToToolHost("Codex OAuth login was superseded");
          }
          pending = login;
          void login.result.then(
            () => {
              if (pending === login) pending = null;
            },
            () => {
              if (pending === login) pending = null;
            },
          );
          return {
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
          };
        });
      }

      if (!pending) {
        return signalCodexFailureToToolHost(
          "Missing PKCE challenge. Re-run codex.login mode=start before manual exchange.",
        );
      }
      const login = pending;
      const result = await login.exchange(payload);
      if (pending === login) pending = null;
      return { step: "exchange" as const, ...result };
    }

    if (callableId === "codex.status") {
      parseToolInput({ callableId, input, schema: statusInputSchema });
      const loaded = await this.dependencies.readTokens();
      let tokens = null;
      if (loaded.status === "ok") {
        tokens = loaded.value.value;
      } else {
        switch (loaded.error._tag) {
          case "CodexTokensReadFailed":
            if (loaded.error.operation === "inspect")
              return signalCodexFailureToToolHost(loaded.error.message);
            break;
          case "CodexTokensMalformed":
          case "CodexTokensCorrupt":
          case "CodexTokensUnsupportedVersion":
            break;
        }
      }
      return {
        configured: tokens !== null,
        storagePath: this.dependencies.storagePath(),
        expires: tokens?.expires,
        accountId: tokens?.accountId,
      };
    }

    if (callableId === "codex.logout") {
      parseToolInput({ callableId, input, schema: logoutInputSchema });
      pendingGeneration += 1;
      return runPendingTransition(async () => {
        const login = pending;
        pending = null;
        await login?.close();
        const cleared = await this.dependencies.clearTokens();
        if (cleared.status === "error") {
          switch (cleared.error._tag) {
            case "CodexTokensReadFailed":
              return signalCodexFailureToToolHost(cleared.error.message);
            case "CodexTokensWriteFailed":
            case "CodexTokensCleanupFailed":
            case "CodexTokensWriteAndCleanupFailed":
              return signalCodexFailureToToolHost(cleared.error.message);
          }
        }
        return { ok: true as const, storagePath: this.dependencies.storagePath() };
      });
    }

    return signalCodexFailureToToolHost("Invalid callable ID");
  }
}
