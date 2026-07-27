import { z } from "zod";

import type { Message, Update } from "grammy/types";

/**
 * A minimal Telegram Bot API server.
 *
 * A bot cannot send messages to itself, so there is no way to drive a real
 * end-to-end test against api.telegram.org without a user account on MTProto.
 * Pointing the adapter's `apiRoot` here instead lets the real adapter run
 * against a scripted transport: tests enqueue updates and assert on the calls
 * the adapter made.
 */
export type RecordedCall = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

export type ProgrammedFailure = {
  readonly errorCode: number;
  readonly description: string;
  readonly retryAfter?: number;
};

const requestBodySchema = z.record(z.string(), z.unknown());

/** Only the fields the fake needs to interpret; the rest is echoed back. */
const sendMessageSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  text: z.string(),
  message_thread_id: z.number().optional(),
});

const editMessageTextSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  message_id: z.number(),
  text: z.string(),
});

const getUpdatesSchema = z.object({
  offset: z.number().optional(),
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class FakeBotApiServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly calls: RecordedCall[] = [];
  private readonly pending: Update[] = [];
  private readonly failures = new Map<string, ProgrammedFailure[]>();
  /** message_id -> current text, so edits can be asserted against. */
  private readonly sentText = new Map<number, string>();

  private nextUpdateId = 1;
  private nextMessageId = 1000;
  private waiter: { resolve: (value: void) => void } | null = null;
  private callWaiters: {
    method: string;
    count: number;
    resolve: (call: RecordedCall) => void;
  }[] = [];

  constructor(
    readonly botId = 8_792_842_071,
    readonly botUsername = "Catalina_agentbot",
  ) {
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => this.handle(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  async close(): Promise<void> {
    // Release any in-flight long poll so the server can stop promptly.
    this.waiter?.resolve();
    this.waiter = null;
    await this.server.stop(true);
  }

  // --- test control ---------------------------------------------------------

  enqueueUpdate(update: Omit<Update, "update_id">): number {
    const updateId = this.nextUpdateId++;
    this.pending.push({ update_id: updateId, ...update });
    this.waiter?.resolve();
    this.waiter = null;
    return updateId;
  }

  /**
   * `Update["message"]` is narrower than `Message` (channel posts arrive on a
   * different field), so the parameter mirrors the update shape exactly.
   */
  enqueueMessage(message: NonNullable<Update["message"]>): number {
    return this.enqueueUpdate({ message });
  }

  /** Makes the next call to `method` fail. Failures are consumed in order. */
  failNext(method: string, failure: ProgrammedFailure): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(failure);
    this.failures.set(method, queue);
  }

  /**
   * Resolves once `method` has been called at least `count` times, so tests can
   * assert on a call without guessing when it happens.
   */
  waitForCall(method: string, count = 1): Promise<RecordedCall> {
    const existing = this.callsOf(method);
    if (existing.length >= count) return Promise.resolve(existing[count - 1] as RecordedCall);

    return new Promise<RecordedCall>((resolve, reject) => {
      this.callWaiters.push({ method, count, resolve });
      // Rejection-only guard; it never delays the successful path.
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method} call #${count}`)),
        10_000,
      );
      void Promise.resolve().then(() => timer.unref?.());
    });
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  allCalls(): readonly RecordedCall[] {
    return this.calls;
  }

  textOf(messageId: number): string | undefined {
    return this.sentText.get(messageId);
  }

  // --- transport ------------------------------------------------------------

  private async handle(req: Request): Promise<Response> {
    // grammY calls POST {apiRoot}/bot{token}/{method}
    const method = new URL(req.url).pathname.split("/").pop() ?? "";

    const raw = await req.text();
    const parsedBody = raw.length > 0 ? requestBodySchema.safeParse(JSON.parse(raw)) : null;
    const params: Record<string, unknown> = parsedBody?.success ? parsedBody.data : {};

    this.calls.push({ method, params });
    this.callWaiters = this.callWaiters.filter((waiter) => {
      const matching = this.callsOf(waiter.method);
      if (matching.length < waiter.count) return true;
      waiter.resolve(matching[waiter.count - 1] as RecordedCall);
      return false;
    });

    const failure = this.failures.get(method)?.shift();
    if (failure) {
      return Response.json({
        ok: false,
        error_code: failure.errorCode,
        description: failure.description,
        ...(failure.retryAfter === undefined
          ? {}
          : { parameters: { retry_after: failure.retryAfter } }),
      });
    }

    try {
      return Response.json({ ok: true, result: await this.dispatch(method, params) });
    } catch (error: unknown) {
      if (error instanceof UnmodifiedEditError) {
        return Response.json({ ok: false, error_code: 400, description: error.message });
      }
      throw error;
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "getMe":
        return {
          id: this.botId,
          is_bot: true,
          first_name: "Catalina-agent",
          username: this.botUsername,
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        };

      case "getUpdates":
        return await this.getUpdates(params);

      case "sendMessage":
      case "sendPhoto":
      case "sendDocument":
        return this.sendMessage(method, params);

      case "editMessageText":
        return this.editMessageText(params);

      case "deleteMessage":
        return true;

      case "getFile":
        return { file_id: "f", file_unique_id: "u", file_path: "photos/file_0.jpg" };

      case "setMyCommands":
      case "sendChatAction":
      case "answerCallbackQuery":
      case "setMessageReaction":
      case "deleteWebhook":
        return true;

      default:
        return true;
    }
  }

  private async getUpdates(params: Record<string, unknown>): Promise<Update[]> {
    const parsed = getUpdatesSchema.safeParse(params);
    const offset = parsed.success ? parsed.data.offset : undefined;

    if (offset !== undefined) {
      // Telegram treats `offset` as "everything below this is acknowledged".
      while (this.pending.length > 0 && (this.pending[0]?.update_id ?? 0) < offset) {
        this.pending.shift();
      }
    }

    if (this.pending.length > 0) return this.pending.splice(0, this.pending.length);

    // Behave like a real long poll: hold the request until something is
    // enqueued, so the adapter is not spun in a tight loop.
    const gate = deferred<void>();
    this.waiter = { resolve: gate.resolve };
    const timeout = setTimeout(() => gate.resolve(), 50);
    await gate.promise;
    clearTimeout(timeout);

    return this.pending.splice(0, this.pending.length);
  }

  private sendMessage(method: string, params: Record<string, unknown>): Message {
    const messageId = this.nextMessageId++;

    const parsed = sendMessageSchema.safeParse(params);
    const chatId = parsed.success ? Number(parsed.data.chat_id) : 0;
    const text = parsed.success ? parsed.data.text : "";
    const threadId = parsed.success ? parsed.data.message_thread_id : undefined;

    if (method === "sendMessage") this.sentText.set(messageId, text);

    const message = {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Ada" },
      from: { id: this.botId, is_bot: true, first_name: "Catalina", username: this.botUsername },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(method === "sendMessage" ? { text } : {}),
    };

    return message as Message;
  }

  private editMessageText(params: Record<string, unknown>): Message | true {
    const parsed = editMessageTextSchema.safeParse(params);
    if (!parsed.success) return true;

    const { message_id: messageId, text } = parsed.data;
    if (this.sentText.get(messageId) === text) {
      // Mirror the real API, which rejects an unchanged edit outright.
      throw new UnmodifiedEditError();
    }
    this.sentText.set(messageId, text);

    return {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(parsed.data.chat_id), type: "private", first_name: "Ada" },
      text,
    } as Message;
  }
}

class UnmodifiedEditError extends Error {
  constructor() {
    super("Bad Request: message is not modified");
    this.name = "UnmodifiedEditError";
  }
}
