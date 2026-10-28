import { useState } from "react";
import { ChevronDown, CornerDownRight, MessageCircleQuestion, X } from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { nextReplyQuestion, questionPrompts, questionTitle } from "../question-reply";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { QuestionPrompts } from "./QuestionCard";

/** Composer header: the question being answered, or a way back to it. */
export function QuestionReplyBar({
  question,
  waiting,
  chosen,
  onOption,
  onReply,
  onExit,
}: {
  question?: NativeQuestion;
  waiting: readonly NativeQuestion[];
  chosen: readonly string[];
  onOption: (messageId: string, ordinal: number, index: number) => void;
  onReply: (messageId: string) => void;
  onExit: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!question) {
    const latest = waiting.at(-1);
    if (!latest) return null;
    return (
      <div
        data-ui="question-waiting"
        className="flex min-h-8 min-w-0 items-center gap-2 pb-2 pl-1 text-sm text-muted-foreground"
      >
        <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 truncate">
          {waiting.length > 1 ? `${waiting.length} questions waiting` : "Question waiting"}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          className="-mr-1 h-7 px-2 text-primary"
          onClick={() => onReply(latest.questionCallId)}
        >
          <CornerDownRight aria-hidden="true" />
          Reply
        </Button>
      </div>
    );
  }
  const prompts = questionPrompts(question);
  const title = questionTitle(prompts);
  const position = waiting.findIndex((item) => item.questionCallId === question.questionCallId);
  const next = nextReplyQuestion(waiting, question.questionCallId);
  return (
    <div data-ui="question-reply" data-open={open ? "" : undefined} className="min-w-0 pb-2">
      <div className="flex min-h-8 min-w-0 items-center gap-1 pl-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setOpen(!open)}
        >
          <CornerDownRight aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground">Answering </span>
            <span className="font-medium text-foreground">{title}</span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {next ? (
          <Button
            variant="ghost"
            data-ui="question-next"
            aria-label={`Next question, ${position + 1} of ${waiting.length}`}
            className="h-7 shrink-0 px-2 text-xs text-muted-foreground tabular-nums"
            onClick={() => onReply(next)}
          >
            {position + 1}/{waiting.length}
          </Button>
        ) : null}
        <IconButton
          label="Stop answering"
          tooltip="Write a regular message"
          className="size-7 shrink-0"
          onClick={() => onExit(question.questionCallId)}
        >
          <X />
        </IconButton>
      </div>
      {open ? (
        <div className="max-h-[40dvh] overflow-y-auto px-1 pt-2 pb-1">
          <QuestionPrompts
            compact
            hideDescriptions
            prompts={prompts}
            chosen={chosen}
            onOption={(ordinal, index) => onOption(question.questionCallId, ordinal, index)}
          />
        </div>
      ) : null}
    </div>
  );
}
