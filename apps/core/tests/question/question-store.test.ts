import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { QuestionInput } from "../../src/question/question-domain";
import { SqliteQuestionStore } from "../../src/question/question-store";

const temporaryDirectories: string[] = [];

async function createStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-question-store-"));
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
  return new SqliteQuestionStore({ dbPath, now: () => 1_000 });
}

const questions: QuestionInput = {
  questions: [
    {
      id: "environment",
      header: "Environment",
      question: "Where should this run?",
      options: [
        { id: "staging", label: "Staging", description: "Use staging." },
        { id: "production", label: "Production", description: "Use production." },
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
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite question store", () => {
  it("maps display indexes back to stable option IDs and consumes each prompt token", async () => {
    const store = await createStore();
    const created = store.create({
      questionCallId: "call-1",
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      questionInput: questions,
      tokens: [
        {
          tokenSha256: "first-token",
          questionIndex: 0,
          kind: "option",
          optionIndex: 2,
        },
      ],
    });
    expect(created.status).toBe("ok");
    store.bindMessage("call-1", "message-1");

    const first = store.applyAnswer({
      tokenSha256: "first-token",
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-1",
      answer: { kind: "option", optionIndex: 2 },
    });
    expect(first.status).toBe("ok");
    if (first.status === "error" || first.value.disposition !== "accepted") return;
    expect(first.value.call).toMatchObject({
      currentIndex: 1,
      state: "pending",
      answers: [{ questionId: "environment", answer: { kind: "option", optionId: "production" } }],
    });
    expect(
      store.applyAnswer({
        tokenSha256: "first-token",
        platform: "discord",
        channelId: "channel-1",
        messageId: "message-1",
        userId: "user-1",
        answer: { kind: "option", optionIndex: 2 },
      }),
    ).toEqual(expect.objectContaining({ status: "ok", value: { disposition: "not-found" } }));

    expect(
      store.replaceTokens("call-1", [
        {
          tokenSha256: "custom-token",
          questionIndex: 1,
          kind: "custom",
          optionIndex: null,
        },
      ]).status,
    ).toBe("ok");
    const final = store.applyAnswer({
      tokenSha256: "custom-token",
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-1",
      answer: { kind: "custom", text: "After the release window" },
    });
    expect(final.status).toBe("ok");
    if (final.status === "error" || final.value.disposition !== "accepted") return;
    expect(final.value.call).toMatchObject({
      state: "answered",
      answers: [
        { questionId: "environment", answer: { kind: "option", optionId: "production" } },
        { questionId: "timing", answer: { kind: "custom", text: "After the release window" } },
      ],
    });

    store.close();
  });

  it("binds a call to its intended Discord user and session", async () => {
    const store = await createStore();
    store.create({
      questionCallId: "call-2",
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-2",
      sessionId: "channel-1",
      userId: "user-1",
      questionInput: questions,
      tokens: [
        {
          tokenSha256: "bound-token",
          questionIndex: 0,
          kind: "option",
          optionIndex: 1,
        },
      ],
    });
    store.bindMessage("call-2", "message-1");

    const wrongUser = store.applyAnswer({
      tokenSha256: "bound-token",
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-2",
      answer: { kind: "option", optionIndex: 1 },
    });
    const wrongMessage = store.applyAnswer({
      tokenSha256: "bound-token",
      platform: "discord",
      channelId: "channel-1",
      messageId: "message-2",
      userId: "user-1",
      answer: { kind: "option", optionIndex: 1 },
    });

    expect(wrongUser).toEqual(
      expect.objectContaining({ status: "ok", value: { disposition: "unauthorized" } }),
    );
    expect(wrongMessage).toEqual(
      expect.objectContaining({ status: "ok", value: { disposition: "stale" } }),
    );

    store.close();
  });
});
