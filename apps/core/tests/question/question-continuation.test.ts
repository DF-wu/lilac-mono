import {
  createAgentRunCheckpoint,
  agentRunCheckpointV1Schema,
} from "../../src/surface/bridge/agent-run-journal";
import { describe, expect, test } from "bun:test";
import { QuestionContinuation } from "../../src/question/question-continuation";
import type { QuestionCall } from "../../src/question/question-domain";

const call: QuestionCall = {
  questionCallId: "q1",
  requestDeliveryId: "d1",
  requestId: "r1",
  toolCallId: "t1",
  platform: "native",
  mode: "deferred",
  sessionId: "s1",
  userId: "u1",
  input: {
    questions: [
      {
        id: "a",
        header: "Target",
        question: "Where?",
        options: [
          { id: "one", label: "One", description: "Use one" },
          { id: "two", label: "Two", description: "Use two" },
        ],
      },
    ],
  },
  currentIndex: 0,
  answers: [{ questionId: "a", answer: { kind: "custom", text: "Elsewhere" } }],
  messageId: "q1",
  state: "answered",
  createdAt: 1,
  updatedAt: 2,
};

describe("question continuations", () => {
  test("waits for settlement and inserts attributed answers once", () => {
    const continuation = new QuestionContinuation();
    expect(continuation.drain([{ ...call, state: "pending" }], [])).toEqual([]);
    const messages = continuation.drain([call], []);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('"respondentId":"u1"');
    expect(messages[0]?.content).toContain('"text":"Elsewhere"');
    expect(continuation.drain([call], [])).toEqual([]);
  });
  test("recovery recognizes transcript results and checkpointed results after compaction", () => {
    const before = new QuestionContinuation();
    const messages = before.drain([call], []);
    expect(before.checkpoint([])).toEqual([]);
    expect(new QuestionContinuation().drain([call], messages)).toEqual([]);
    const ids = agentRunCheckpointV1Schema.parse(
      createAgentRunCheckpoint({ messages: [], questionResultIds: before.checkpoint(messages) }),
    ).questionResultIds!;
    expect(ids).toEqual(["q1"]);
    expect(new QuestionContinuation(ids).drain([call], [])).toEqual([]);
  });
  test("expiry and interruption resume without inventing an answer", () => {
    for (const state of ["expired", "interrupted", "cancelled"] as const) {
      const messages = new QuestionContinuation().drain([{ ...call, state, answers: [] }], []);
      expect(messages[0]?.content).toContain(`"status":"${state}"`);
      expect(messages[0]?.content).toContain('"answers":[]');
    }
  });
});
