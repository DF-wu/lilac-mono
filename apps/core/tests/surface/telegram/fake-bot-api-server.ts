import { isDeepStrictEqual } from "node:util";

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

/**
 * Recorded stand-in for an uploaded file. Only metadata: the bytes are of no
 * interest to a test and would bloat every recorded call.
 */
const uploadedFileSchema = z.object({ filename: z.string(), size: z.number() });

export type UploadedFile = z.infer<typeof uploadedFileSchema>;

/**
 * `req.formData()` yields `string | File` per part. A file part is recorded as
 * small, assertable metadata so attachment bytes never land in
 * `RecordedCall.params`.
 */
const formEntrySchema = z.union([
  z.instanceof(File).transform((file): UploadedFile => ({ filename: file.name, size: file.size })),
  z.string(),
]);

/**
 * Multipart carries every field as text, so scalars that the JSON transport
 * delivers as numbers/booleans arrive here as strings (`message_thread_id: "7"`
 * rather than `7`).
 *
 * The conversion happens here, driven by an explicit field list, rather than by
 * relaxing `sendMessageSchema` to `z.coerce.number()`: schema-level coercion
 * would leave the *recorded* params shape different between the two transports
 * (a string for multipart, a number for JSON) so tests would have to assert
 * differently depending on how grammY happened to encode the call, and
 * `z.coerce.number()` turns a malformed value into `NaN` instead of rejecting
 * it. Conversion only applies to fields Telegram actually types as non-strings,
 * and only when the text round-trips exactly, so `message_thread_id: "abc"`
 * stays the string it was and a free-text field such as `caption: "42"` is
 * never rewritten.
 */
const NUMERIC_FORM_FIELDS: ReadonlySet<string> = new Set([
  "chat_id",
  "message_id",
  "message_thread_id",
  "reply_to_message_id",
  "offset",
  "limit",
  "timeout",
]);

const BOOLEAN_FORM_FIELDS: ReadonlySet<string> = new Set([
  "disable_notification",
  "disable_web_page_preview",
  "protect_content",
  "allow_sending_without_reply",
  "has_spoiler",
]);

function coerceFormScalar(key: string, value: string): string | number | boolean {
  if (BOOLEAN_FORM_FIELDS.has(key) && (value === "true" || value === "false")) {
    return value === "true";
  }

  if (NUMERIC_FORM_FIELDS.has(key)) {
    const asNumber = Number(value);
    // Round-trip guard: only an exact numeric literal converts, never `NaN`.
    if (Number.isFinite(asNumber) && String(asNumber) === value) return asNumber;
  }

  return value;
}

/** grammY names the file part with a random id and points at it from the field. */
const ATTACH_PREFIX = "attach://";

async function readMultipartParams(req: Request): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  const files: Record<string, UploadedFile> = {};

  for (const [key, value] of (await req.formData()).entries()) {
    const parsed = formEntrySchema.safeParse(value);
    // Neither text nor a file: nothing assertable to record, so skip the part
    // rather than fabricating a value for it.
    if (!parsed.success) continue;

    if (typeof parsed.data === "string") {
      params[key] = coerceFormScalar(key, parsed.data);
      continue;
    }
    // Park the file under its part name; the `attach://` pass below moves it to
    // whichever logical field refers to it.
    files[key] = parsed.data;
  }

  // grammY does not put the upload on `photo`/`document` directly: it emits a
  // randomly named file part and sets the logical field to
  // `attach://<part-name>`. Resolving that indirection here is what lets a test
  // assert `params.photo` instead of hunting for a random key.
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !value.startsWith(ATTACH_PREFIX)) continue;

    const partName = value.slice(ATTACH_PREFIX.length);
    const file = files[partName];
    if (file === undefined) continue;

    params[key] = file;
    delete files[partName];
  }

  // Any file part nothing pointed at stays recorded under its own name so it is
  // still visible to a test rather than silently dropped.
  return { ...params, ...files };
}

function readJsonParams(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // A body that is not JSON must not escape the handler as a 500; the call is
    // still recorded, just without params.
    return {};
  }

  const parsed = requestBodySchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
}

async function readParams(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  // grammY switches to multipart/form-data as soon as an `InputFile` is in play
  // (sendPhoto/sendDocument uploads); everything else stays JSON.
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    return await readMultipartParams(req);
  }

  return readJsonParams(await req.text());
}

/**
 * Only the fields the fake needs to interpret; the rest is echoed back.
 *
 * `text` is optional because `sendPhoto`/`sendDocument` route through the same
 * handler and carry no text. Requiring it would fail the parse for every
 * upload, and the handler would then fall back to `chat_id: 0` and drop the
 * thread id — a response that quietly misdescribes where the message landed.
 */
const sendMessageSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  text: z.string().optional(),
  message_thread_id: z.number().optional(),
});

const editMessageTextSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  message_id: z.number(),
  text: z.string(),
});

const deleteMessageSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  message_id: z.number(),
});

const editableMessagePayloadSchema = z.object({
  text: z.string(),
  parse_mode: z.string().optional(),
  entities: z.array(z.unknown()).optional(),
  link_preview_options: z.unknown().optional(),
  disable_web_page_preview: z.boolean().optional(),
  reply_markup: z.unknown().optional(),
});

type EditableMessagePayload = z.infer<typeof editableMessagePayloadSchema>;

type StoredMessage = {
  readonly chatId: number;
  readonly editablePayload: EditableMessagePayload | null;
};

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
  /** Remote message state, including existence and all text-editable fields. */
  private readonly messages = new Map<number, StoredMessage>();

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
    return this.messages.get(messageId)?.editablePayload?.text;
  }

  editablePayloadOf(messageId: number): EditableMessagePayload | undefined {
    return this.messages.get(messageId)?.editablePayload ?? undefined;
  }

  /** Simulates a user deleting a message without notifying the adapter. */
  removeMessage(messageId: number): boolean {
    return this.messages.delete(messageId);
  }

  // --- transport ------------------------------------------------------------

  private async handle(req: Request): Promise<Response> {
    // grammY calls POST {apiRoot}/bot{token}/{method}
    const method = new URL(req.url).pathname.split("/").pop() ?? "";

    const params = await readParams(req);

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
      if (error instanceof FakeBotApiError) {
        return Response.json({
          ok: false,
          error_code: error.errorCode,
          description: error.message,
        });
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
        return this.deleteMessage(params);

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
    const text = (parsed.success ? parsed.data.text : undefined) ?? "";
    const threadId = parsed.success ? parsed.data.message_thread_id : undefined;

    const message = {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Ada" },
      from: { id: this.botId, is_bot: true, first_name: "Catalina", username: this.botUsername },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(method === "sendMessage" ? { text } : {}),
    };

    const typedMessage = message as Message;
    const editablePayload =
      method === "sendMessage" ? editableMessagePayloadSchema.safeParse(params) : null;
    this.messages.set(messageId, {
      chatId,
      editablePayload: editablePayload?.success ? editablePayload.data : null,
    });
    return typedMessage;
  }

  private editMessageText(params: Record<string, unknown>): Message | true {
    const parsed = editMessageTextSchema.safeParse(params);
    if (!parsed.success) return true;

    const { message_id: messageId, text } = parsed.data;
    const existing = this.messages.get(messageId);
    if (!existing || existing.chatId !== Number(parsed.data.chat_id)) {
      throw new FakeBotApiError(400, "Bad Request: message to edit not found");
    }
    const editablePayload = editableMessagePayloadSchema.safeParse(params);
    if (!editablePayload.success) return true;
    if (isDeepStrictEqual(existing.editablePayload, editablePayload.data)) {
      // Mirror the real API, which rejects an unchanged edit outright.
      throw new FakeBotApiError(400, "Bad Request: message is not modified");
    }

    const message = {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(parsed.data.chat_id), type: "private", first_name: "Ada" },
      text,
    } as Message;
    this.messages.set(messageId, {
      chatId: existing.chatId,
      editablePayload: editablePayload.data,
    });
    return message;
  }

  private deleteMessage(params: Record<string, unknown>): true {
    const parsed = deleteMessageSchema.safeParse(params);
    if (!parsed.success) return true;
    const existing = this.messages.get(parsed.data.message_id);
    if (!existing || existing.chatId !== Number(parsed.data.chat_id)) {
      throw new FakeBotApiError(400, "Bad Request: message to delete not found");
    }
    this.messages.delete(parsed.data.message_id);
    return true;
  }
}

class FakeBotApiError extends Error {
  constructor(
    readonly errorCode: number,
    description: string,
  ) {
    super(description);
    this.name = "FakeBotApiError";
  }
}
