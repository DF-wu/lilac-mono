import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LanguageModel } from "ai";
import { Panic, Result } from "better-result";

export {
  getSessionInfo,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

type UtilityModel = Extract<LanguageModel, { specificationVersion: "v4" }>;
type UtilityInput = Parameters<UtilityModel["doGenerate"]>[0];
type UtilityOutput = Awaited<ReturnType<UtilityModel["doGenerate"]>>;
export type MessageInjector = {
  inject(message: string, onResult?: (delivered: boolean) => void): void;
  close(): void;
};
export type ClaudeCodeQueryController = {
  rawQuery: Pick<Query, "return">;
  getContextUsage(): Promise<unknown>;
  interrupt(): Promise<void>;
};
export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, "close" | "interrupt" | "getContextUsage" | "return">;
export type ClaudeQueryFactory = (input: Parameters<typeof query>[0]) => ClaudeQuery;
export type ClaudeCodeSettings = Options & {
  queryFactory?: ClaudeQueryFactory;
  streamingInput?: "always";
  onStreamStart?: (injector: MessageInjector) => void;
  onQueryControllerCreated?: (controller: ClaudeCodeQueryController) => void | PromiseLike<void>;
  onSdkMessage?: (message: object) => void | PromiseLike<void>;
};

export type ClaudeRuntime = {
  readonly modelId: string;
  readonly settings: ClaudeCodeSettings;
};
const runtimes = new WeakMap<object, ClaudeRuntime>();

export function claudeRuntime(model: LanguageModel): ClaudeRuntime | undefined {
  return typeof model === "string" ? undefined : runtimes.get(model);
}

export function claudeUsage(usage: SDKResultMessage["usage"]): UtilityOutput["usage"] {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: {
      total: usage.input_tokens + read + write,
      noCache: usage.input_tokens,
      cacheRead: read,
      cacheWrite: write,
    },
    outputTokens: { total: usage.output_tokens, text: undefined, reasoning: undefined },
  };
}

async function generateUtility(
  runtime: ClaudeRuntime,
  input: UtilityInput,
): Promise<UtilityOutput> {
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.abortSignal?.reason);
  if (input.abortSignal?.aborted) abort();
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  const prompt = input.prompt
    .map(
      (message) =>
        `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`,
    )
    .join("\n\n");
  let run: ClaudeQuery | undefined;
  const result = await Result.tryPromise({
    try: async () => {
      const activeQuery = (runtime.settings.queryFactory ?? query)({
        prompt,
        options: {
          model: runtime.modelId,
          cwd: runtime.settings.cwd,
          pathToClaudeCodeExecutable: runtime.settings.pathToClaudeCodeExecutable,
          tools: [],
          settingSources: [],
          persistSession: false,
          abortController,
        },
      });
      run = activeQuery;
      for await (const message of activeQuery) {
        if (message.type !== "result") continue;
        if (message.subtype !== "success") throw new Error(message.errors.join("\n"));
        return {
          content: [{ type: "text", text: message.result }],
          finishReason: { unified: "stop", raw: message.stop_reason ?? undefined },
          usage: claudeUsage(message.usage),
          warnings: [],
        } satisfies UtilityOutput;
      }
      throw new Error("Claude utility query ended without a result");
    },
    catch: (cause): {} | null | undefined => cause,
  });
  const cleanup = Result.try({
    try: () => run?.close(),
    catch: (cause): {} | null | undefined => cause,
  });
  input.abortSignal?.removeEventListener("abort", abort);
  const outcome = result.match<
    { kind: "success"; value: UtilityOutput } | { kind: "failure"; error: {} | null | undefined }
  >({
    ok: (value) => ({ kind: "success" as const, value }),
    err: (error) => ({ kind: "failure" as const, error }),
  });
  const cleanupFailure = cleanup.match({ ok: () => null, err: (error) => ({ error }) });
  if (outcome.kind === "failure" && Panic.is(outcome.error))
    return signalClaudeUtilityFailure(outcome.error);
  if (cleanupFailure && Panic.is(cleanupFailure.error))
    return signalClaudeUtilityFailure(cleanupFailure.error);
  if (outcome.kind === "failure") return signalClaudeUtilityFailure(outcome.error);
  if (cleanupFailure) return signalClaudeUtilityFailure(cleanupFailure.error);
  return outcome.value;
}

/** Model-shaped handles serve existing summarizers; agent execution reads the native runtime. */
export function createClaudeCode(options: { defaultSettings?: ClaudeCodeSettings } = {}) {
  return (modelId: string, settings: ClaudeCodeSettings = {}): UtilityModel => {
    const runtime = { modelId, settings: { ...options.defaultSettings, ...settings } };
    const model: UtilityModel = {
      specificationVersion: "v4",
      provider: "claude-code",
      modelId,
      supportedUrls: {},
      doGenerate: (input) => generateUtility(runtime, input),
      doStream: async (input) => {
        const result = await generateUtility(runtime, input);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "summary" });
              for (const content of result.content) {
                if (content.type === "text")
                  controller.enqueue({ type: "text-delta", id: "summary", delta: content.text });
              }
              controller.enqueue({ type: "text-end", id: "summary" });
              controller.enqueue({
                type: "finish",
                finishReason: result.finishReason,
                usage: result.usage,
              });
              controller.close();
            },
          }),
        };
      },
    };
    runtimes.set(model, runtime);
    return model;
  };
}

export function createClaudeInput(initial: SDKUserMessage) {
  const pending: Array<{ message: SDKUserMessage; acknowledged?: (delivered: boolean) => void }> = [
    { message: initial },
  ];
  let wake: (() => void) | undefined;
  let closed = false;
  const injector: MessageInjector = {
    inject(text, acknowledged) {
      if (closed) {
        acknowledged?.(false);
        return;
      }
      pending.push({
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          uuid: crypto.randomUUID(),
        },
        acknowledged,
      });
      wake?.();
    },
    close() {
      closed = true;
      for (const entry of pending.splice(0)) entry.acknowledged?.(false);
      wake?.();
    },
  };
  const acknowledgements = new Map<string, (delivered: boolean) => void>();
  return {
    injector,
    acknowledge(id: string) {
      acknowledgements.get(id)?.(true);
      acknowledgements.delete(id);
    },
    hasPending() {
      return pending.length > 0 || acknowledgements.size > 0;
    },
    finish() {
      injector.close();
      // Once yielded, missing acknowledgement is uncertain delivery, not proof of rejection.
      acknowledgements.clear();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        const entry = pending.shift();
        if (!entry) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (entry.message.uuid && entry.acknowledged)
          acknowledgements.set(entry.message.uuid, entry.acknowledged);
        yield entry.message;
      }
    },
  };
}

function signalClaudeUtilityFailure(error: {} | null | undefined): never {
  throw error;
}
