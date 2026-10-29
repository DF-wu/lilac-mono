import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import {
  answerLabel,
  answerPlaceholder,
  nextPromptStep,
  promptAnswered,
  questionPrompts,
  replyText,
  type PromptAnswer,
  type QuestionPrompt,
} from "../question-reply";
import type { Attachment } from "../types";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./QuestionCard";
import { QuestionPanel, QuestionWaiting } from "./QuestionReply";
import { MessageIdentityContext } from "./message-identity";
import {
  MessageServicesContext,
  QuestionReplyContext,
  type MessageServices,
} from "./message-services";
import { IconButton } from "./ui";

const sources = [
  {
    header: "Deploy target",
    question: "Where should I deploy the preview build?",
    options: [
      ["Preview link", "Create an isolated link that expires in 7 days."],
      ["Staging", "Replace the shared staging build. Teammates see it right away."],
    ],
  },
  {
    header: "Database",
    question: "Which data should the preview use?",
    options: [
      ["Nightly snapshot", "Copy last night's data with personal fields removed."],
      ["Empty", "Start with the schema and fixture users only."],
      ["Read replica", "Read live production data. Writes stay disabled."],
    ],
  },
] as const;

function prompts(total: number): QuestionPrompt[] {
  return sources.slice(0, total).map((source, position) => ({
    ordinal: position + 1,
    total,
    header: source.header,
    question: source.question,
    options: source.options.map(([label, description], index) => ({
      index: index + 1,
      label,
      description,
      token: `demo-${position}-${index}`,
    })),
    customToken: `demo-${position}-custom`,
  }));
}

function question(
  id: string,
  view: NativeQuestion["view"] | "pending",
  total = 1,
  respondentId = "alex",
): NativeQuestion {
  const all = prompts(total);
  return {
    questionCallId: id,
    requestId: `${id}-request`,
    respondentId,
    historyGeneration: 0,
    mode: "deferred",
    prompts: all,
    view: view === "pending" ? { state: "pending", prompt: all[0]! } : view,
  };
}

const identities = {
  viewerId: "alex",
  agent: { displayName: "Lilac" },
  users: new Map(),
};
const noop = () => {};
const baseServices: MessageServices = {
  canEdit: true,
  resourceUrl: () => "",
  onAction: noop,
  onReaction: noop,
};
const settled = [
  question("answered", {
    state: "answered",
    summary: {
      answers: [
        {
          header: "Deploy target",
          answer: { kind: "option", label: "Preview link" },
        },
      ],
    },
  }),
  question("cancelled", { state: "cancelled" }, 2),
  question("expired", { state: "expired" }),
  question("interrupted", { state: "interrupted" }),
];

function demoAttachment(file: File): Attachment {
  const key = crypto.randomUUID();
  return {
    key,
    file,
    reservation: Promise.resolve(key),
    state: "ready",
    progress: 1,
  };
}

type ReplySummary = Extract<NativeQuestion["view"], { state: "answered" }>["summary"];

/**
 * Preview-only answering state for a question, mirroring Chat: one prompt at a time, options
 * move on after a short pause, and the message box holds a typed answer for the prompt on screen.
 */
export function useQuestionReplyDemo(
  item: NativeQuestion,
  onSend: (text: string, summary: ReplySummary) => void,
) {
  const [step, setStep] = useState(0);
  const [options, setOptions] = useState<Record<number, number>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [files, setFiles] = useState(0);
  const all = questionPrompts(item);
  const prompt = all[Math.min(step, all.length - 1)]!;
  const answers = new Map<number, PromptAnswer>(
    all.map((entry) => [
      entry.ordinal,
      {
        option: options[entry.ordinal],
        text: typed[entry.ordinal] ?? "",
        attachments: entry.ordinal === prompt.ordinal ? files : 0,
      },
    ]),
  );
  const answered = all.map((entry) => promptAnswered(answers.get(entry.ordinal)!));
  const next = nextPromptStep(
    answered.map((value, index) => value || index === step),
    step,
  );
  const advance = useRef(() => {});
  advance.current = () => {
    if (next !== "submit") return setStep(next);
    onSend(replyText(all, answers), {
      answers: all.map((entry) => {
        const answer = answers.get(entry.ordinal)!;
        const option = entry.options.find((choice) => choice.index === answer.option);
        return {
          header: entry.header,
          answer:
            option && !answer.text.trim()
              ? { kind: "option" as const, label: option.label }
              : { kind: "custom" as const },
        };
      }),
    });
  };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const chosen = options[prompt.ordinal];
  return {
    documentKey: `${item.questionCallId}-reply-${prompt.ordinal}`,
    text: typed[prompt.ordinal] ?? "",
    onText: (text: string) => setTyped((current) => ({ ...current, [prompt.ordinal]: text })),
    setFiles,
    reset() {
      setStep(0);
      setOptions({});
      setTyped({});
      setFiles(0);
    },
    panel: (props: { onExit: () => void; onDismiss: () => void }) => (
      <QuestionPanel
        question={item}
        step={step}
        chosen={chosen}
        typed={!!typed[prompt.ordinal]?.trim()}
        answered={answered}
        onChoose={(ordinal, index) => {
          setTyped((current) => ({ ...current, [ordinal]: "" }));
          setOptions((current) => ({ ...current, [ordinal]: index }));
          clearTimeout(timer.current);
          timer.current = setTimeout(() => advance.current(), 200);
        }}
        onStep={setStep}
        onExit={props.onExit}
        onDismiss={async () => {
          props.onDismiss();
          return undefined;
        }}
      />
    ),
    placeholder: answerPlaceholder(chosen !== undefined),
    answer: {
      label: answerLabel(next === "submit", all.length),
      last: next === "submit",
      ready: chosen !== undefined,
      onAdvance: () => advance.current(),
    },
  };
}

/** The card in the conversation and the composer answering it one prompt at a time. */
function ReplyDemo({ total }: { total: number }) {
  const [state, setState] = useState<"pending" | "regular" | "sent">("pending");
  const [regular, setRegular] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sent, setSent] = useState<string>();
  const item = useMemo(
    () =>
      question(
        `demo-${total}`,
        state === "sent"
          ? {
              state: "answered",
              summary: { answers: [] },
              replyMessageId: "demo-reply",
            }
          : "pending",
        total,
      ),
    [state, total],
  );
  const reply = useQuestionReplyDemo(item, (text) => {
    setSent(text);
    setAttachments([]);
    setState("sent");
  });
  const replying = state === "pending";
  const services: MessageServices = {
    ...baseServices,
    questions: {
      onReply: () => setState("pending"),
      onDismiss: async () => {
        setState("sent");
        return undefined;
      },
    },
  };
  function header() {
    if (state === "sent") return undefined;
    if (replying)
      return reply.panel({
        onExit: () => setState("regular"),
        onDismiss: () => setState("sent"),
      });
    return <QuestionWaiting waiting={[item]} onReply={() => setState("pending")} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex justify-end">
        <IconButton
          label="Reset question demo"
          tooltip="Reset"
          onClick={() => {
            reply.reset();
            setState("pending");
            setSent(undefined);
            setAttachments([]);
          }}
        >
          <RotateCcw />
        </IconButton>
      </div>
      <MessageServicesContext value={services}>
        <QuestionReplyContext value={{ messageId: replying ? item.questionCallId : undefined }}>
          <QuestionCard question={item} />
        </QuestionReplyContext>
      </MessageServicesContext>
      {sent !== undefined ? (
        <div className="self-end max-w-[85%] rounded-xl bg-surface px-4 py-2">
          <Markdown text={sent} preserveLineBreaks />
        </div>
      ) : null}
      <Composer
        documentKey={replying ? reply.documentKey : `demo-${total}`}
        text={replying ? reply.text : regular}
        onText={replying ? reply.onText : setRegular}
        header={header()}
        placeholder={replying ? reply.placeholder : undefined}
        answer={replying ? reply.answer : undefined}
        attachments={replying ? attachments : []}
        onAttach={(files) => {
          const added = files.map(demoAttachment);
          setAttachments((items) => [...items, ...added]);
          reply.setFiles((count) => count + added.length);
          return added;
        }}
        onRemoveAttachment={(key) => {
          setAttachments((items) => items.filter((attachment) => attachment.key !== key));
          reply.setFiles((count) => Math.max(0, count - 1));
        }}
        onRetryAttachment={noop}
        skillIds={[]}
        onSkills={noop}
        onCommand={noop}
        active={false}
        canCancel={false}
        disabled={false}
        onModelChange={noop}
        onSubmit={() => setRegular("")}
        onCancel={noop}
      />
    </div>
  );
}

export function QuestionDemo() {
  return (
    <MessageIdentityContext value={identities}>
      <div className="grid grid-cols-1 gap-6 workspace:grid-cols-2">
        <ReplyDemo total={1} />
        <ReplyDemo total={2} />
        <div className="flex min-w-0 flex-col gap-3 workspace:col-span-2">
          <MessageServicesContext value={baseServices}>
            <QuestionCard question={question("readonly", "pending", 1, "morgan")} />
            {settled.map((item) => (
              <QuestionCard key={item.questionCallId} question={item} />
            ))}
          </MessageServicesContext>
        </div>
      </div>
    </MessageIdentityContext>
  );
}
