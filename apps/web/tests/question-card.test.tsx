import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeQuestionSchema, type NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { QuestionCard } from "../src/components/QuestionCard";
import { MessageIdentityContext } from "../src/components/message-identity";
import {
  MessageServicesContext,
  QuestionReplyContext,
  type MessageServices,
  type QuestionReplyView,
  type QuestionServices,
} from "../src/components/message-services";

const pending: NativeQuestion["view"] = {
  state: "pending",
  prompt: {
    ordinal: 2,
    total: 3,
    header: "Database",
    question: "Which data should the preview use?",
    options: [
      {
        index: 1,
        label: "Snapshot",
        description: "Copy last night's data.",
        token: "t1",
      },
      {
        index: 2,
        label: "Empty",
        description: "Start with the schema only.",
        token: "t2",
      },
    ],
    customToken: "custom",
  },
};

const second = {
  ...(pending.state === "pending" ? pending.prompt : undefined)!,
  ordinal: 3,
  header: "Notify",
  question: "Who should get the link?",
  customToken: "custom-3",
};

function question(
  view: NativeQuestion["view"],
  respondentId = "alex",
  prompts?: NativeQuestion["prompts"],
): NativeQuestion {
  return nativeQuestionSchema.parse({
    questionCallId: "call",
    requestId: "request",
    respondentId,
    historyGeneration: 0,
    mode: "deferred",
    ...(prompts ? { prompts } : {}),
    view,
  });
}

const questions: QuestionServices = {
  onOption: () => {},
  onReply: () => {},
  onDismiss: async () => undefined,
};

function render(
  data: NativeQuestion,
  services: Partial<MessageServices> = {},
  reply: QuestionReplyView = { chosen: [] },
) {
  return renderToStaticMarkup(
    <MessageIdentityContext
      value={{
        viewerId: "alex",
        agent: { displayName: "Lilac" },
        users: new Map(),
      }}
    >
      <MessageServicesContext
        value={{
          canEdit: true,
          resourceUrl: () => "",
          onAction: () => {},
          onReaction: () => {},
          questions,
          ...services,
        }}
      >
        <QuestionReplyContext value={reply}>
          <QuestionCard question={data} />
        </QuestionReplyContext>
      </MessageServicesContext>
    </MessageIdentityContext>,
  );
}

describe("question card", () => {
  test("the respondent gets numbered option shortcuts, reply, and dismiss without a form", () => {
    const html = render(question(pending));
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Other");
    expect(html.match(/data-ui="question-option"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="1. Snapshot"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Reply");
    expect(html).toContain('aria-label="Dismiss question"');
    expect(html).not.toContain('type="submit"');
  });

  test("every prompt in the call is shown at once under one title", () => {
    const html = render(
      question(pending, "alex", [pending.state === "pending" ? pending.prompt : second, second]),
    );
    expect(html).toContain("2 questions");
    expect(html).toContain("2. Database");
    expect(html).toContain("3. Notify");
    expect(html.match(/data-ui="question-option"/g)).toHaveLength(4);
    expect(html.match(/Dismiss question/g)).toHaveLength(1);
    expect(html.match(/class="lucide lucide-message-circle-question/g)).toHaveLength(1);
  });

  test("the reply target marks options already in the draft", () => {
    const html = render(question(pending), {}, { messageId: "call", chosen: ["2:2"] });
    expect(html).toContain("data-replying");
    expect(html).toContain("Answer in the message box");
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="2. Empty"/);
  });

  test("other viewers and viewers without edit access get a read-only card", () => {
    for (const html of [
      render(question(pending, "morgan")),
      render(question(pending), { canEdit: false }),
      render(question(pending), { questions: undefined }),
    ]) {
      expect(html).toContain("data-readonly");
      expect(html).toContain("Waiting for an answer");
      expect(html).toContain("Snapshot");
      expect(html).not.toContain("<button");
    }
  });

  test("settled cards keep the original question behind a collapsed toggle", () => {
    const prompt = pending.state === "pending" ? pending.prompt : second;
    for (const view of [
      { state: "answered", summary: { answers: [] }, replyMessageId: "reply" },
      { state: "cancelled" },
      { state: "expired" },
      { state: "interrupted" },
    ] satisfies NativeQuestion["view"][]) {
      const html = render(question(view, "alex", [prompt]));
      expect(html).toContain("Database");
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain("Which data should the preview use?");
      expect(html).not.toContain('data-ui="question-option"');
    }
    expect(render(question({ state: "cancelled" }, "alex", [prompt, second]))).toContain(
      "2 questions",
    );
  });

  test("settled cards without stored prompts summarize without controls", () => {
    const answered = render(
      question({
        state: "answered",
        summary: {
          answers: [
            {
              header: "Target",
              answer: { kind: "option", label: "Preview link" },
            },
            { header: "Database", answer: { kind: "custom" } },
          ],
        },
      }),
    );
    expect(answered).toContain("Question answered");
    expect(answered).toContain("Preview link");
    expect(answered).not.toContain("<button");
    expect(render(question({ state: "expired" }))).toContain("Question expired");
    expect(render(question({ state: "cancelled" }))).toContain("Question dismissed");
    expect(render(question({ state: "interrupted" }))).toContain("Question interrupted");
  });
});
