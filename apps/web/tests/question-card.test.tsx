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
import { QuestionPanel } from "../src/components/QuestionReply";

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
  onReply: () => {},
  onDismiss: async () => undefined,
};

function render(
  data: NativeQuestion,
  services: Partial<MessageServices> = {},
  reply: QuestionReplyView = {},
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
  test("the respondent's card is one line that opens the question in the composer", () => {
    const html = render(question(pending));
    expect(html).toContain("Needs your answer");
    expect(html).toContain("Database");
    expect(html).toContain("Answer");
    expect(html).not.toContain('data-ui="question-option"');
    expect(html).not.toContain("Which data should the preview use?");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test("a call with several prompts is named by its count", () => {
    const html = render(
      question(pending, "alex", [pending.state === "pending" ? pending.prompt : second, second]),
    );
    expect(html).toContain("2 questions");
    expect(html.match(/class="lucide lucide-message-circle-question/g)).toHaveLength(1);
  });

  test("the card being answered points to the composer instead of offering Answer", () => {
    const html = render(question(pending), {}, { messageId: "call" });
    expect(html).toContain("data-replying");
    expect(html).toContain("Answering below");
    expect(html).not.toContain("<button");
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

describe("question panel", () => {
  const prompt = pending.state === "pending" ? pending.prompt : second;
  const call = question(pending, "alex", [prompt, second]);
  function panel(props: Partial<Parameters<typeof QuestionPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <QuestionPanel
        question={call}
        step={0}
        typed={false}
        answered={[false, false]}
        onChoose={() => {}}
        onStep={() => {}}
        onExit={() => {}}
        onDismiss={async () => undefined}
        {...props}
      />,
    );
  }

  test("shows only the prompt on screen with numbered options and its step", () => {
    const html = panel();
    expect(html).toContain("Which data should the preview use?");
    expect(html).not.toContain("Who should get the link?");
    expect(html.match(/data-ui="question-option"/g)).toHaveLength(2);
    expect(html).toContain('aria-keyshortcuts="1"');
    expect(html).toContain("1/2");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Previous question"|aria-label="Previous question"[^>]*disabled=""/,
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Next question"|aria-label="Next question"[^>]*disabled=""/,
    );
    expect(html).toContain('aria-label="Dismiss question"');
    expect(html).toContain('aria-label="Write a message instead"');
  });

  test("marks the chosen option until a typed answer replaces it", () => {
    expect(panel({ chosen: 2 })).toMatch(/aria-pressed="true"[^>]*>.*Empty/);
    expect(panel({ chosen: 2, typed: true })).not.toContain('aria-pressed="true"');
  });

  test("moves to the second prompt", () => {
    const html = panel({ step: 1, answered: [true, false] });
    expect(html).toContain("Who should get the link?");
    expect(html).toContain("2/2");
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Previous question"|aria-label="Previous question"[^>]*disabled=""/,
    );
  });
});
