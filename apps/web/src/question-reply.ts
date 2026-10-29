import { createStore } from "zustand/vanilla";
import type { NativeQuestion, TurnSlot } from "@stanley2058/lilac-client-protocol";

export type QuestionPrompt = Extract<NativeQuestion["view"], { state: "pending" }>["prompt"];
export type QuestionReplyTarget = { messageId: string; token: string };

/** Every prompt in the call; one composer reply answers all of them. Settled calls keep theirs. */
export function questionPrompts(question: NativeQuestion): QuestionPrompt[] {
  if (question.prompts?.length) return question.prompts;
  return question.view.state === "pending" ? [question.view.prompt] : [];
}

/** The call's name: its header, or a count when it asks several things. */
export function questionTitle(prompts: readonly QuestionPrompt[]): string | undefined {
  return prompts.length > 1 ? `${prompts.length} questions` : prompts[0]?.header;
}

export function questionReplyTarget(question: NativeQuestion): QuestionReplyTarget | undefined {
  if (question.view.state !== "pending") return undefined;
  const first = questionPrompts(question)[0];
  return first ? { messageId: question.questionCallId, token: first.customToken } : undefined;
}

/** Each prompt keeps its own typed answer, so moving between prompts never mixes them. */
export function questionDraftKey(threadId: string, messageId: string, ordinal: number) {
  return `${threadId}:question:${messageId}:${ordinal}`;
}

/** A prompt's answer: typed text wins over the chosen option. */
export type PromptAnswer = { option?: number; text: string; attachments: number };

export function promptAnswered(answer: PromptAnswer): boolean {
  return !!answer.text.trim() || answer.option !== undefined || answer.attachments > 0;
}

/** The reply message for a call. One prompt sends its answer alone; several get labeled blocks. */
export function replyText(
  prompts: readonly QuestionPrompt[],
  answers: ReadonlyMap<number, PromptAnswer>,
): string {
  return prompts
    .map((prompt) => {
      const answer = answers.get(prompt.ordinal);
      const typed = answer?.text.trim() ?? "";
      const value =
        typed || prompt.options.find((option) => option.index === answer?.option)?.label || "";
      if (prompts.length === 1) return value;
      return value.includes("\n") ? `${prompt.header}:\n${value}` : `${prompt.header}: ${value}`;
    })
    .join("\n\n");
}

/** The send button's name while answering. */
export function answerLabel(last: boolean, promptCount: number): string {
  if (!last) return "Continue";
  return promptCount > 1 ? "Submit answers" : "Submit answer";
}

export function answerPlaceholder(chosen: boolean): string {
  return chosen ? "Type a different answer…" : "Or type your own answer…";
}

/** Where to go after a prompt is answered: the next unanswered prompt, or the reply when none is left. */
export function nextPromptStep(answered: readonly boolean[], current: number): number | "submit" {
  for (let offset = 1; offset <= answered.length; offset++) {
    const step = (current + offset) % answered.length;
    if (!answered[step]) return step;
  }
  return "submit";
}

/** Pending questions the viewer can answer, oldest first. */
export function answerableQuestions(
  questions: readonly NativeQuestion[] | undefined,
  viewerId: string | undefined,
) {
  return (questions ?? []).filter(
    (question) => question.view.state === "pending" && question.respondentId === viewerId,
  );
}

type ReplyChoice = { messageId: string; replying: boolean };
/** The prompt on screen and the options chosen so far, by prompt ordinal. */
export type ReplyProgress = { step: number; options: Readonly<Record<number, number>> };
type ReplyState = {
  choices: ReadonlyMap<string, ReplyChoice>;
  progress: ReadonlyMap<string, ReplyProgress>;
  choose: (threadId: string, choice: ReplyChoice) => void;
  update: (key: string, change: ProgressChange) => void;
};

export function replyProgressKey(threadId: string, messageId: string) {
  return `${threadId}:${messageId}`;
}
export const emptyProgress: ReplyProgress = { step: 0, options: {} };
/** Returns the next progress, or undefined to forget the call. */
export type ProgressChange = (current: ReplyProgress) => ReplyProgress | undefined;

/** Reply mode per thread and progress per call. It outlives Chat so navigating away keeps both. */
export const questionReplyStore = createStore<ReplyState>((set) => ({
  choices: new Map(),
  progress: new Map(),
  update(key, change) {
    set((state) => {
      const next = change(state.progress.get(key) ?? emptyProgress);
      const progress = new Map(state.progress);
      if (next) progress.set(key, next);
      else progress.delete(key);
      return { progress };
    });
  },
  choose(threadId, choice) {
    set((state) => {
      const current = state.choices.get(threadId);
      if (current?.messageId === choice.messageId && current.replying === choice.replying)
        return state;
      return { choices: new Map(state.choices).set(threadId, choice) };
    });
  },
}));

/** The question the composer answers, or none when the user is writing a regular message. */
export function activeReplyQuestion(
  pending: readonly NativeQuestion[],
  choice: ReplyChoice | undefined,
): NativeQuestion | undefined {
  if (!choice?.replying) return undefined;
  return pending.find((item) => item.questionCallId === choice.messageId);
}

/**
 * The question to open automatically: the oldest one, only when no current choice still applies
 * and the regular draft is empty, so a new question never takes over a message being written.
 */
export function autoReplyQuestion(
  pending: readonly NativeQuestion[],
  choice: ReplyChoice | undefined,
  regularDraftEmpty: boolean,
): string | undefined {
  if (!regularDraftEmpty) return undefined;
  if (choice && pending.some((item) => item.questionCallId === choice.messageId)) return undefined;
  return pending[0]?.questionCallId;
}

type ReplyDraft<Attachment> = { text: string; skillIds: string[]; attachments: Attachment[] };

/** Appends an unsent reply to the regular draft, keeping both drafts' skill references. */
export function mergeClosedReply<Attachment, Draft extends ReplyDraft<Attachment>>(
  regular: Draft,
  leftover: ReplyDraft<Attachment>,
): Draft {
  return {
    ...regular,
    text: [regular.text, leftover.text].filter((text) => text.trim()).join("\n\n"),
    // The composer keeps at most 32 skill references per draft.
    skillIds: [...new Set([...regular.skillIds, ...leftover.skillIds])].slice(0, 32),
    attachments: [...regular.attachments, ...leftover.attachments],
  };
}

/**
 * Records the question signature of each changed slot and reports whether the pending list may be
 * stale. A slot whose turns are not loaded hides its question cards, so any change to it counts.
 */
export function questionSlotsChanged(
  seen: Map<string, string>,
  slotIds: readonly string[],
  get: (slotId: string) => TurnSlot | undefined,
): boolean {
  let changed = false;
  for (const id of slotIds) {
    const slot = get(id);
    if (slot && slot.kind !== "ready") {
      changed = true;
      continue;
    }
    const signature = questionSignature(slot);
    if ((seen.get(id) ?? "") === signature) continue;
    seen.set(id, signature);
    changed = true;
  }
  return changed;
}

/** Identifies the question cards in a slot so a replay that changes one can refresh the list. */
export function questionSignature(slot: TurnSlot | undefined): string {
  if (slot?.kind !== "ready") return "";
  let signature = "";
  for (const message of slot.messages)
    for (const part of message.parts) {
      if (part.type !== "data-question") continue;
      const view = part.data.view;
      signature += `${part.data.questionCallId}:${view.state}:${view.state === "pending" ? view.prompt.customToken : ""};`;
    }
  return signature;
}
