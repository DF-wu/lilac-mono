import { describe, expect, test } from "bun:test";
import { NativeClient } from "@stanley2058/lilac-client";
import type { NativeQuestion, ReplayCheckpoint } from "@stanley2058/lilac-client-protocol";
import {
  activeReplyQuestion,
  applyOptionShortcut,
  autoReplyQuestion,
  nextReplyQuestion,
  chosenOptions,
  mergeClosedReply,
  questionPrompts,
  questionSignature,
  questionSlotsChanged,
  questionReplyTarget,
  questionTitle,
  type QuestionPrompt,
} from "../src/question-reply";

function prompt(ordinal: number, header: string, labels: string[]): QuestionPrompt {
  return {
    ordinal,
    total: 2,
    header,
    question: `${header}?`,
    options: labels.map((label, index) => ({
      index: index + 1,
      label,
      description: label,
      token: `${ordinal}-${index}`,
    })),
    customToken: `custom-${ordinal}`,
  };
}

const target = prompt(1, "Deploy target", ["Preview link", "Staging"]);
const database = prompt(2, "Database", ["Snapshot", "Empty", "Replica"]);

function question(id: string, prompts?: QuestionPrompt[]): NativeQuestion {
  return {
    questionCallId: id,
    requestId: id,
    respondentId: "alex",
    historyGeneration: 0,
    mode: "deferred",
    prompts,
    view: { state: "pending", prompt: target },
  };
}

describe("question reply", () => {
  test("a single prompt gets a readable line that is not a Markdown list", () => {
    expect(applyOptionShortcut("", [target], 1, 2)).toBe("Staging (option 2)");
    expect(applyOptionShortcut("Staging (option 2)", [target], 1, 1)).toBe(
      "Preview link (option 1)",
    );
  });

  test("shortcuts keep the user's own text below the chosen lines", () => {
    expect(applyOptionShortcut("Use the EU region", [target], 1, 1)).toBe(
      "Preview link (option 1)\n\nUse the EU region",
    );
  });

  test("several prompts keep one labeled line each in prompt order", () => {
    const prompts = [target, database];
    const first = applyOptionShortcut("", prompts, 2, 3);
    expect(first).toBe("Database: Replica (option 3)");
    const both = applyOptionShortcut(first, prompts, 1, 1);
    expect(both).toBe("Deploy target: Preview link (option 1)\nDatabase: Replica (option 3)");
    expect(applyOptionShortcut(both, prompts, 2, 2)).toBe(
      "Deploy target: Preview link (option 1)\nDatabase: Empty (option 2)",
    );
    expect(chosenOptions(both, prompts)).toEqual(["1:1", "2:3"]);
  });

  test("the whole call is answered with the first prompt's token", () => {
    const item = question("call", [target, database]);
    expect(questionPrompts(item)).toEqual([target, database]);
    expect(questionPrompts(question("solo"))).toEqual([target]);
    expect(questionReplyTarget(item)).toEqual({
      messageId: "call",
      token: "custom-1",
    });
  });

  test("a settled call keeps its prompts for history but takes no reply", () => {
    const settled: NativeQuestion = {
      ...question("call", [target, database]),
      view: { state: "expired" },
    };
    expect(questionPrompts(settled)).toEqual([target, database]);
    expect(questionTitle(questionPrompts(settled))).toBe("2 questions");
    expect(questionTitle([target])).toBe("Deploy target");
    expect(questionReplyTarget(settled)).toBeUndefined();
    expect(questionPrompts({ ...settled, prompts: undefined })).toEqual([]);
  });

  test("reply mode follows the user's choice and only opens on its own for an idle composer", () => {
    const older = question("older");
    const newer = question("newer");
    const both = [older, newer];
    expect(activeReplyQuestion(both, undefined)).toBe(undefined);
    expect(activeReplyQuestion(both, { messageId: "older", replying: true })).toBe(older);
    expect(activeReplyQuestion(both, { messageId: "newer", replying: false })).toBe(undefined);
    expect(autoReplyQuestion(both, undefined, true)).toBe("newer");
    expect(autoReplyQuestion(both, undefined, false)).toBe(undefined);
    // A new question neither replaces the current reply nor overrides leaving reply mode.
    expect(autoReplyQuestion(both, { messageId: "older", replying: true }, true)).toBe(undefined);
    expect(autoReplyQuestion(both, { messageId: "older", replying: false }, true)).toBe(undefined);
    expect(autoReplyQuestion(both, { messageId: "gone", replying: false }, true)).toBe("newer");
  });

  test("next question cycles through every pending call", () => {
    const items = [question("a"), question("b"), question("c")];
    expect(nextReplyQuestion(items, "a")).toBe("b");
    expect(nextReplyQuestion(items, "b")).toBe("c");
    expect(nextReplyQuestion(items, "c")).toBe("a");
    expect(nextReplyQuestion(items.slice(0, 1), "a")).toBe(undefined);
  });

  test("a closed reply joins the regular draft with its text, files, and skills", () => {
    const regular = {
      text: "Draft note $agent-browser",
      skillIds: ["agent-browser"],
      attachments: ["a"],
    };
    const leftover = {
      text: "Staging (option 2) $deploy",
      skillIds: ["deploy", "agent-browser"],
      attachments: ["b"],
    };
    expect(mergeClosedReply(regular, leftover)).toEqual({
      text: "Draft note $agent-browser\n\nStaging (option 2) $deploy",
      skillIds: ["agent-browser", "deploy"],
      attachments: ["a", "b"],
    });
    const many = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}${index}`);
    const merged = mergeClosedReply(
      { text: "", skillIds: many("a"), attachments: [] },
      { text: "", skillIds: many("b"), attachments: [] },
    );
    expect(merged.skillIds).toHaveLength(32);
    expect(merged.skillIds.slice(0, 20)).toEqual(many("a"));
  });
});

describe("pending list refresh", () => {
  const checkpoint = (revision: number): ReplayCheckpoint => ({
    protocolVersion: 1,
    historyGeneration: 0,
    projectionRevision: revision,
    cursor: `cursor_${revision}`,
  });

  function threadWithHistoryGap() {
    const client = new NativeClient({
      scope: {
        installationId: "fixture",
        principalId: "owner",
        protocolVersion: 1,
        projectionVersion: 1,
      },
      openSocket: () => {
        throw new Error("No socket needed");
      },
      bootstrap: async () => {
        throw new Error("No bootstrap needed");
      },
    });
    const store = client.thread("thread");
    store.replay({
      kind: "window",
      checkpoint: checkpoint(1),
      slots: [
        { kind: "deferred", slotId: "old", position: 0, endPosition: 4 },
        {
          kind: "ready",
          slotId: "latest",
          turnId: "turn_4",
          position: 4,
          messages: [
            {
              id: "reply",
              role: "assistant",
              parts: [{ type: "text", text: "Hi" }],
            },
          ],
        },
      ],
    });
    const seen = new Map(store.slotIds.map((id) => [id, questionSignature(store.get(id))]));
    const refreshes: string[][] = [];
    store.subscribe((change) => {
      if (questionSlotsChanged(seen, change.slotIds, (id) => store.get(id)))
        refreshes.push([...change.slotIds]);
    });
    return { store, refreshes };
  }

  test("a change inside unloaded history refreshes the list", () => {
    const { store, refreshes } = threadWithHistoryGap();
    // A question answered elsewhere rewrites its card in a turn this client never loaded.
    expect(
      store.update({
        checkpoint: checkpoint(2),
        changes: [
          {
            kind: "set-part",
            turnId: "turn_1",
            position: 1,
            messageId: "question",
            partIndex: 0,
            part: { type: "text", text: "answered" },
          },
        ],
      }),
    ).toBe("applied");
    expect(refreshes).toEqual([["old"]]);
  });

  test("streaming text in loaded turns does not refresh the list", () => {
    const { store, refreshes } = threadWithHistoryGap();
    store.update({
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn_4",
          position: 4,
          messageId: "reply",
          partIndex: 0,
          text: " there",
        },
      ],
    });
    expect(refreshes).toEqual([]);
  });
});
