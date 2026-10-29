import { useContext, useState, type ReactNode } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  CircleCheck,
  CornerDownRight,
  MessageCircleQuestion,
  TimerOff,
  Unplug,
  X,
} from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { questionPrompts, questionTitle, type QuestionPrompt } from "../question-reply";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { LoadingSpinner } from "./ui/loading-spinner";
import { MessageIdentityContext } from "./message-identity";
import { QuestionReplyContext, useMessageServices } from "./message-services";

type SettledView = Exclude<NativeQuestion["view"], { state: "pending" }>;

const endings = {
  answered: { label: "Answered", icon: CircleCheck, tone: "text-success" },
  cancelled: { label: "Dismissed", icon: Ban, tone: "text-muted-foreground" },
  expired: { label: "Expired", icon: TimerOff, tone: "text-muted-foreground" },
  interrupted: {
    label: "Interrupted",
    icon: Unplug,
    tone: "text-muted-foreground",
  },
} as const;

const cardStyles = "flex w-full min-w-0 flex-col gap-3 rounded-xl bg-muted px-4 py-3";

export function QuestionCard({ question }: { question: NativeQuestion }) {
  const { canEdit, questions } = useMessageServices();
  const { viewerId } = useContext(MessageIdentityContext);
  const view = question.view;
  if (view.state !== "pending") return <SettledQuestion question={question} view={view} />;
  if (canEdit && !!questions && viewerId === question.respondentId)
    return <PendingQuestion question={question} />;
  const prompts = questionPrompts(question);
  return (
    <section data-ui="question-card" data-state="pending" data-readonly="" className={cardStyles}>
      <CardHeader title={questionTitle(prompts)} />
      <QuestionPrompts prompts={prompts} />
      <p className="m-0 text-sm text-muted-foreground">Waiting for an answer</p>
    </section>
  );
}

function CardHeader({ title, action }: { title?: string; action?: ReactNode }) {
  return (
    <header className="flex min-h-7 min-w-0 items-center gap-2">
      <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <h3 className="m-0 min-w-0 flex-1 text-sm font-semibold text-foreground wrap-anywhere">
        {title}
      </h3>
      {action}
    </header>
  );
}

function PendingQuestion({ question }: { question: NativeQuestion }) {
  const { questions } = useMessageServices();
  const reply = useContext(QuestionReplyContext);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string>();
  const messageId = question.questionCallId;
  const replying = reply.messageId === messageId;
  const prompts = questionPrompts(question);
  async function dismiss() {
    if (dismissing || !questions) return;
    setDismissing(true);
    setError(undefined);
    const failure = await questions.onDismiss(question);
    // On success the replayed card replaces this one, so the button stays busy until then.
    if (!failure) return;
    setError(failure);
    setDismissing(false);
  }
  return (
    <section
      data-ui="question-card"
      data-state="pending"
      data-replying={replying ? "" : undefined}
      aria-busy={dismissing}
      className={`${cardStyles} ring-1 transition-shadow ${replying ? "ring-primary/40" : "ring-transparent"}`}
    >
      <CardHeader
        title={questionTitle(prompts)}
        action={
          <IconButton
            label="Dismiss question"
            tooltip="Dismiss"
            className="-my-1 -mr-2 size-7 shrink-0"
            disabled={dismissing}
            onClick={() => void dismiss()}
          >
            {dismissing ? <LoadingSpinner size={14} /> : <X />}
          </IconButton>
        }
      />
      <QuestionPrompts
        prompts={prompts}
        chosen={replying ? reply.chosen : undefined}
        disabled={dismissing}
        onOption={(ordinal, index) => questions?.onOption(messageId, ordinal, index)}
      />
      <footer className="flex min-h-7 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <PendingFooter
          error={error}
          replying={replying}
          disabled={dismissing}
          onReply={() => questions?.onReply(messageId)}
        />
      </footer>
    </section>
  );
}

function PendingFooter(props: {
  error?: string;
  replying: boolean;
  disabled: boolean;
  onReply: () => void;
}) {
  if (props.error)
    return (
      <p role="alert" className="m-0 min-w-0 text-danger wrap-anywhere">
        {props.error}
      </p>
    );
  if (props.replying)
    return (
      <p className="m-0 flex min-w-0 items-center gap-1.5">
        <CornerDownRight aria-hidden="true" className="size-4 shrink-0" />
        Answer in the message box
      </p>
    );
  return (
    <Button
      variant="ghost"
      className="-ml-2 h-7 px-2 text-primary"
      disabled={props.disabled}
      onClick={props.onReply}
    >
      <CornerDownRight aria-hidden="true" />
      Reply
    </Button>
  );
}

/** The call's prompts and options. Several prompts get numbered subheadings under one card title. */
export function QuestionPrompts({
  prompts,
  chosen,
  disabled,
  onOption,
  compact,
  hideDescriptions,
}: {
  prompts: readonly QuestionPrompt[];
  chosen?: readonly string[];
  disabled?: boolean;
  onOption?: (ordinal: number, index: number) => void;
  compact?: boolean;
  hideDescriptions?: boolean;
}) {
  const many = prompts.length > 1;
  return (
    <div className={`flex min-w-0 flex-col ${compact ? "gap-4" : "gap-5"}`}>
      {prompts.map((prompt) => (
        <div key={prompt.ordinal} className="flex min-w-0 flex-col gap-2">
          {many ? (
            <h4 className="m-0 text-sm font-semibold text-muted-foreground wrap-anywhere">
              {prompt.ordinal}. {prompt.header}
            </h4>
          ) : null}
          <p
            className={`m-0 text-foreground whitespace-pre-wrap wrap-anywhere ${compact ? "text-sm" : "text-base"}`}
          >
            {prompt.question}
          </p>
          <ol className={`m-0 flex list-none flex-col p-0 ${onOption ? "gap-1.5" : "gap-2.5"}`}>
            {prompt.options.map((option) => (
              <li key={option.index} className="min-w-0">
                <QuestionOption
                  number={option.index}
                  label={option.label}
                  description={hideDescriptions ? undefined : option.description}
                  selected={chosen?.includes(`${prompt.ordinal}:${option.index}`)}
                  disabled={disabled}
                  onChoose={onOption ? () => onOption(prompt.ordinal, option.index) : undefined}
                />
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function QuestionOption({
  number,
  label,
  description,
  selected,
  disabled,
  onChoose,
}: {
  number: number;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onChoose?: () => void;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`grid size-5 shrink-0 place-items-center rounded-md text-xs font-semibold tabular-nums transition-colors ${selected ? "bg-primary text-primary-foreground" : "bg-foreground/8 text-muted-foreground"}`}
      >
        {selected ? <Check className="size-3.5" /> : number}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground wrap-anywhere">{label}</span>
        {description ? (
          <span className="text-sm text-muted-foreground text-pretty">{description}</span>
        ) : null}
      </span>
    </>
  );
  if (!onChoose) return <div className="flex w-full min-w-0 items-start gap-3">{content}</div>;
  const shape = "flex w-full min-w-0 items-start gap-3 rounded-lg bg-background/60 px-3 py-2.5";
  return (
    <button
      type="button"
      data-ui="question-option"
      aria-pressed={!!selected}
      aria-label={`${number}. ${label}`}
      disabled={disabled}
      className={`${shape} cursor-pointer text-left ring-1 transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default ${selected ? "bg-background ring-primary" : "ring-transparent"}`}
      onClick={onChoose}
    >
      {content}
    </button>
  );
}

/** A finished call: its outcome in one line, with the original prompts a click away. */
function SettledQuestion({ question, view }: { question: NativeQuestion; view: SettledView }) {
  const [open, setOpen] = useState(false);
  const prompts = questionPrompts(question);
  const title = questionTitle(prompts);
  const { label, icon: Icon, tone } = endings[view.state];
  const answers =
    view.state === "answered"
      ? view.summary.answers.flatMap((item) =>
          item.answer.kind === "option" ? [{ header: item.header, label: item.answer.label }] : [],
        )
      : [];
  const status = (
    <>
      <Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">
          {title ? label : `Question ${label.toLowerCase()}`}
        </span>
        {title ? <span className="font-medium text-foreground"> · {title}</span> : null}
      </span>
    </>
  );
  const summary = answers.length ? (
    <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
      {answers.map((item, index) => (
        <div key={index} className="contents">
          <dt className="truncate text-muted-foreground">{item.header}</dt>
          <dd className="m-0 min-w-0 text-foreground wrap-anywhere">{item.label}</dd>
        </div>
      ))}
    </dl>
  ) : null;
  const shape = `${cardStyles} gap-2 text-sm`;
  if (!prompts.length)
    return (
      <section data-ui="question-card" data-state={view.state} className={shape}>
        <p className="m-0 flex min-h-7 min-w-0 items-center gap-2">{status}</p>
        {summary}
      </section>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section data-ui="question-card" data-state={view.state} className={shape} />}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="-mx-1 flex min-h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left focus-visible:outline-2 focus-visible:outline-focus"
          />
        }
      >
        {status}
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      {summary}
      <CollapsibleContent className="pt-1 pb-1">
        <QuestionPrompts compact prompts={prompts} />
      </CollapsibleContent>
    </Collapsible>
  );
}
