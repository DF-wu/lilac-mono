import { afterEach, describe, expect, it, jest } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";

import type { QuestionActionToken, QuestionInput } from "../../src/question/question-domain";
import {
  QUESTION_INACTIVITY_TIMEOUT_MS,
  QuestionService,
} from "../../src/question/question-service";
import { QuestionStoreFailed, SqliteQuestionStore } from "../../src/question/question-store";
import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";
import type {
  SurfaceQuestionAnswerHandler,
  SurfaceQuestionActivityHandler,
  SurfaceQuestionFinishInput,
  SurfaceQuestionInteractionUpdate,
  SurfaceQuestionPort,
  SurfaceQuestionPrompt,
} from "../../src/surface/question";
import type { SurfaceQuestionResolver } from "../../src/surface/runtime-descriptor";
import type { MsgRefFor, SessionRefFor } from "../../src/surface/types";

const temporaryDirectories: string[] = [];

async function createStore(
  create: (dbPath: string) => SqliteQuestionStore = (dbPath) => new SqliteQuestionStore({ dbPath }),
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-question-service-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "request-delivery.db");
  const owner = new Database(dbPath, { create: true, strict: true });
  owner.run(`
    CREATE TABLE request_delivery_records (
      request_delivery_id TEXT PRIMARY KEY NOT NULL
    ) STRICT
  `);
  owner.run("INSERT INTO request_delivery_records (request_delivery_id) VALUES (?)", [
    "delivery-1",
  ]);
  owner.close();
  return create(dbPath);
}

class ReplaceFailingQuestionStore extends SqliteQuestionStore {
  override replaceTokens(_questionCallId: string, _tokens: readonly QuestionActionToken[]) {
    return Result.err(
      new QuestionStoreFailed({
        operation: "replace-tokens",
        code: "SQLITE_IOERR",
        message: "Question store SQLite replace-tokens failed",
      }),
    );
  }
}

class TransitionFailingQuestionStore extends SqliteQuestionStore {
  override transitionPending() {
    return Result.err(
      new QuestionStoreFailed({
        operation: "transition-pending",
        code: "SQLITE_IOERR",
        message: "Question store SQLite transition-pending failed",
      }),
    );
  }
}

class TestQuestionPort implements SurfaceQuestionPort<"discord"> {
  prompts: SurfaceQuestionPrompt[] = [];
  presentations: Array<{
    readonly sessionRef: SessionRefFor<"discord">;
    readonly replyTo?: MsgRefFor<"discord">;
  }> = [];
  finishes: SurfaceQuestionFinishInput<"discord">[] = [];
  interactionUpdates: SurfaceQuestionInteractionUpdate[] = [];
  handler: SurfaceQuestionAnswerHandler<"discord"> | null = null;
  activityHandler: SurfaceQuestionActivityHandler<"discord"> | null = null;
  finishGate: Promise<void> | null = null;
  finishStarted: (() => void) | null = null;

  async present(input: {
    readonly sessionRef: SessionRefFor<"discord">;
    readonly replyTo?: MsgRefFor<"discord">;
    readonly prompt: SurfaceQuestionPrompt;
  }) {
    this.prompts.push(input.prompt);
    this.presentations.push({
      sessionRef: input.sessionRef,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
    return Result.ok({
      platform: "discord",
      channelId: "channel-1",
      messageId: "card-1",
    } as const);
  }

  async finish(input: SurfaceQuestionFinishInput<"discord">) {
    this.finishes.push(input);
    this.finishStarted?.();
    if (this.finishGate) await this.finishGate;
    return Result.ok(undefined);
  }

  async subscribeAnswers(
    handler: SurfaceQuestionAnswerHandler<"discord">,
    handleActivity: SurfaceQuestionActivityHandler<"discord">,
  ) {
    this.handler = handler;
    this.activityHandler = handleActivity;
    return {
      stop: async () => {
        this.handler = null;
        this.activityHandler = null;
      },
    };
  }

  async openCustomInput() {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    if (!prompt || !this.activityHandler) throw new Error("Question prompt is not ready");
    return await this.activityHandler({
      platform: "discord",
      channelId: "channel-1",
      messageRef: {
        platform: "discord",
        channelId: "channel-1",
        messageId: "card-1",
      },
      principal: { platform: "discord", userId: "user-1" },
      token: prompt.customToken,
    });
  }

  async answerOption(optionIndex: number) {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    const option = prompt?.options[optionIndex - 1];
    if (!option || !this.handler) throw new Error("Question option is not ready");
    return await this.handler(
      {
        platform: "discord",
        channelId: "channel-1",
        messageRef: {
          platform: "discord",
          channelId: "channel-1",
          messageId: "card-1",
        },
        principal: { platform: "discord", userId: "user-1" },
        token: option.token,
        answer: { kind: "option", optionIndex },
      },
      async (update) => {
        this.interactionUpdates.push(update);
        return Result.ok(undefined);
      },
    );
  }

  async answerCustom(text: string) {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    if (!prompt || !this.handler) throw new Error("Question prompt is not ready");
    return await this.handler(
      {
        platform: "discord",
        channelId: "channel-1",
        messageRef: {
          platform: "discord",
          channelId: "channel-1",
          messageId: "card-1",
        },
        principal: { platform: "discord", userId: "user-1" },
        token: prompt.customToken,
        answer: { kind: "custom", text },
      },
      async (update) => {
        this.interactionUpdates.push(update);
        return Result.ok(undefined);
      },
    );
  }
}

function createService(store: SqliteQuestionStore, port: TestQuestionPort): QuestionService {
  const resolved = {
    platform: "discord" as const,
    protocol: BUILTIN_SURFACE_PROTOCOLS.discord,
    question: port,
  };
  const surfaces: SurfaceQuestionResolver = {
    entries: () => [resolved],
    resolve: (platform) => (platform === "discord" ? resolved : null),
  };
  return new QuestionService({
    store,
    surfaces,
    logger: { warn: () => undefined },
  });
}

const input: QuestionInput = {
  questions: [
    {
      id: "environment",
      header: "Environment",
      question: "Where should this run?",
      options: [
        { id: "staging", label: "Staging", description: "Use staging." },
        {
          id: "production",
          label: "Production",
          description: "Use production.",
        },
      ],
    },
    {
      id: "timing",
      header: "Timing",
      question: "When should this run?",
      options: [
        { id: "now", label: "Now", description: "Run now." },
        { id: "later", label: "Later", description: "Run later." },
      ],
    },
  ],
};

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("question service", () => {
  it("runs sequential prompts on one card and returns stable IDs to the model", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    expect(service.supports("discord")).toBe(true);
    expect(service.supports("github")).toBe(false);

    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      replyTo: { platform: "discord", channelId: "channel-1", messageId: "turn-1" },
      questions: input,
    });
    await Promise.resolve();
    expect(port.prompts).toHaveLength(1);
    expect(port.presentations).toEqual([
      {
        sessionRef: { platform: "discord", channelId: "channel-1" },
        replyTo: { platform: "discord", channelId: "channel-1", messageId: "turn-1" },
      },
    ]);

    expect((await port.answerOption(2)).status).toBe("ok");
    expect(port.prompts).toHaveLength(1);
    expect(port.interactionUpdates[0]).toMatchObject({
      state: "pending",
      prompt: { ordinal: 2, total: 2, header: "Timing" },
    });
    expect((await port.answerCustom("After the release window")).status).toBe("ok");

    const result = await pending;
    expect(result).toEqual(
      expect.objectContaining({
        status: "ok",
        value: [
          {
            questionId: "environment",
            answer: { kind: "option", optionId: "production" },
          },
          {
            questionId: "timing",
            answer: { kind: "custom", text: "After the release window" },
          },
        ],
      }),
    );
    expect(port.interactionUpdates[1]).toEqual({
      state: "answered",
      summary: {
        answers: [
          {
            header: "Environment",
            answer: { kind: "option", label: "Production" },
          },
          { header: "Timing", answer: { kind: "custom" } },
        ],
      },
    });
    expect(port.finishes).toEqual([]);

    await service.stop();
    store.close();
  });

  it("waits for cancellation cleanup before settling the tool call", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");

    const finishStarted = Promise.withResolvers<void>();
    const finishGate = Promise.withResolvers<void>();
    port.finishStarted = finishStarted.resolve;
    port.finishGate = finishGate.promise;
    const controller = new AbortController();
    let settled = false;
    const pending = service
      .ask({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "tool-call-cancel",
        sessionId: "channel-1",
        userId: "user-1",
        questions: input,
        signal: controller.signal,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();

    controller.abort();
    await finishStarted.promise;
    expect(settled).toBe(false);
    finishGate.resolve();

    const result = await pending;
    expect(result).toMatchObject({ status: "error", error: { _tag: "QuestionCancelled" } });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "cancelled" })]);

    await service.stop();
    store.close();
  });

  it("expires an unanswered question after ten minutes", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-timeout",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    jest.advanceTimersByTime(QUESTION_INACTIVITY_TIMEOUT_MS);

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionTimedOut" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "expired" })]);

    await service.stop();
    store.close();
  });

  it("resets the timeout after each accepted answer", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    let settled = false;
    const pending = service
      .ask({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "tool-call-reset-timeout",
        sessionId: "channel-1",
        userId: "user-1",
        questions: input,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();

    jest.advanceTimersByTime(9 * 60 * 1_000);
    expect((await port.answerOption(1)).status).toBe("ok");
    jest.advanceTimersByTime(9 * 60 * 1_000);
    expect((await port.openCustomInput()).status).toBe("ok");
    jest.advanceTimersByTime(2 * 60 * 1_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(8 * 60 * 1_000);
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionTimedOut" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "expired" })]);

    await service.stop();
    store.close();
  });

  it("returns a timeout transition failure without changing the card", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore((dbPath) => new TransitionFailingQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-timeout-transition-failure",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    jest.advanceTimersByTime(QUESTION_INACTIVITY_TIMEOUT_MS);

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionStoreFailed", operation: "transition-pending" },
    });
    expect(port.finishes).toEqual([]);

    await service.stop();
    store.close();
  });

  it("interrupts active cards before shutdown settles their tool calls", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-stop",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    await service.stop();

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionInterrupted" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "interrupted" })]);
    store.close();
  });

  it("cancels the card and settles the tool call when next-question token rotation fails", async () => {
    const store = await createStore((dbPath) => new ReplaceFailingQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-rotation",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    const handled = await port.answerOption(1);

    expect(handled).toMatchObject({
      status: "error",
      error: { _tag: "SurfaceQuestionAnswerHandlingFailed" },
    });
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionStoreFailed" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "cancelled" })]);

    await service.stop();
    store.close();
  });
});
