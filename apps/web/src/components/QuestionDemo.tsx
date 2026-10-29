import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import {
  applyOptionShortcut,
  chosenOptions,
  questionPrompts,
  type QuestionPrompt,
} from "../question-reply";
import type { Attachment } from "../types";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./QuestionCard";
import { QuestionReplyBar } from "./QuestionReply";
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

/** The card in the conversation and the composer answering it, sharing one reply draft. */
function ReplyDemo({ total }: { total: number }) {
  const [state, setState] = useState<"pending" | "regular" | "sent">("pending");
  const [reply, setReply] = useState("");
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
  const all = questionPrompts(item);
  const replying = state === "pending";
  const chosen = useMemo(() => chosenOptions(reply, all), [reply, all]);
  const choose = (_messageId: string, ordinal: number, index: number) => {
    setState("pending");
    setReply((text) => applyOptionShortcut(text, all, ordinal, index));
  };
  const services: MessageServices = {
    ...baseServices,
    questions: {
      onOption: choose,
      onReply: () => setState("pending"),
      onDismiss: async () => {
        setState("sent");
        return undefined;
      },
    },
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex justify-end">
        <IconButton
          label="Reset question demo"
          tooltip="Reset"
          onClick={() => {
            setState("pending");
            setReply("");
            setSent(undefined);
            setAttachments([]);
          }}
        >
          <RotateCcw />
        </IconButton>
      </div>
      <MessageServicesContext value={services}>
        <QuestionReplyContext
          value={{
            messageId: replying ? item.questionCallId : undefined,
            chosen,
          }}
        >
          <QuestionCard question={item} />
        </QuestionReplyContext>
      </MessageServicesContext>
      {sent !== undefined ? (
        <div className="self-end max-w-[85%] rounded-xl bg-surface px-4 py-2">
          <Markdown text={sent} preserveLineBreaks />
        </div>
      ) : null}
      <Composer
        documentKey={replying ? `demo-${total}-reply` : `demo-${total}`}
        text={replying ? reply : regular}
        onText={replying ? setReply : setRegular}
        header={
          state === "sent" ? undefined : (
            <QuestionReplyBar
              question={replying ? item : undefined}
              waiting={[item]}
              chosen={chosen}
              onOption={choose}
              onReply={() => setState("pending")}
              onExit={() => setState("regular")}
            />
          )
        }
        placeholder={replying ? "Answer Lilac…" : undefined}
        attachments={replying ? attachments : []}
        onAttach={(files) => {
          const added = files.map(demoAttachment);
          setAttachments((items) => [...items, ...added]);
          return added;
        }}
        onRemoveAttachment={(key) =>
          setAttachments((items) => items.filter((attachment) => attachment.key !== key))
        }
        onRetryAttachment={noop}
        skillIds={[]}
        onSkills={noop}
        onCommand={noop}
        active={false}
        canCancel={false}
        disabled={false}
        onModelChange={noop}
        onSubmit={(submission) => {
          if (!replying) {
            setRegular("");
            return;
          }
          setSent(submission.text);
          setReply("");
          setAttachments([]);
          setState("sent");
        }}
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
