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

export function questionDraftKey(threadId: string, messageId: string) {
  return `${threadId}:question:${messageId}`;
}

function shortcutLine(prompts: readonly QuestionPrompt[], prompt: QuestionPrompt, index: number) {
  const option = prompt.options.find((item) => item.index === index);
  if (!option) return undefined;
  // "1." would start a Markdown list in the composer, so the number trails the label.
  const answer = `${option.label} (option ${option.index})`;
  return prompts.length > 1 ? `${prompt.header}: ${answer}` : answer;
}

function lineOwner(line: string, prompts: readonly QuestionPrompt[]) {
  return prompts.findIndex((prompt) =>
    prompt.options.some((option) => line === shortcutLine(prompts, prompt, option.index)),
  );
}

/**
 * Writes the chosen option as one readable line per prompt, kept in prompt order above the rest
 * of the reply. Choosing again for the same prompt replaces its line.
 */
export function applyOptionShortcut(
  text: string,
  prompts: readonly QuestionPrompt[],
  ordinal: number,
  index: number,
): string {
  const target = prompts.findIndex((prompt) => prompt.ordinal === ordinal);
  const line = target < 0 ? undefined : shortcutLine(prompts, prompts[target]!, index);
  if (!line) return text;
  const chosen = new Map<number, string>([[target, line]]);
  const rest: string[] = [];
  for (const current of text ? text.split("\n") : []) {
    const owner = lineOwner(current, prompts);
    if (owner < 0) rest.push(current);
    else if (!chosen.has(owner)) chosen.set(owner, current);
  }
  const answers = [...chosen].sort(([a], [b]) => a - b).map(([, value]) => value);
  while (rest[0] === "") rest.shift();
  return [...answers, ...(rest.length ? ["", ...rest] : [])].join("\n");
}

/** Options whose shortcut line is in the reply, as `ordinal:index`. */
export function chosenOptions(text: string, prompts: readonly QuestionPrompt[]): string[] {
  const lines = new Set(text.split("\n"));
  return prompts.flatMap((prompt) =>
    prompt.options
      .filter((option) => lines.has(shortcutLine(prompts, prompt, option.index)!))
      .map((option) => `${prompt.ordinal}:${option.index}`),
  );
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
type ReplyState = {
  choices: ReadonlyMap<string, ReplyChoice>;
  choose: (threadId: string, choice: ReplyChoice) => void;
};

/** Reply mode per thread. It outlives Chat so navigating away keeps the user's choice. */
export const questionReplyStore = createStore<ReplyState>((set) => ({
  choices: new Map(),
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
 * The question to open automatically: the newest one, only when no current choice still applies
 * and the regular draft is empty, so a new question never takes over a message being written.
 */
export function autoReplyQuestion(
  pending: readonly NativeQuestion[],
  choice: ReplyChoice | undefined,
  regularDraftEmpty: boolean,
): string | undefined {
  if (!regularDraftEmpty) return undefined;
  if (choice && pending.some((item) => item.questionCallId === choice.messageId)) return undefined;
  return pending.at(-1)?.questionCallId;
}

/** The question after `current`, wrapping around, so every pending call stays reachable. */
export function nextReplyQuestion(
  pending: readonly NativeQuestion[],
  current: string,
): string | undefined {
  if (pending.length < 2) return undefined;
  const position = pending.findIndex((item) => item.questionCallId === current);
  return pending[(position + 1) % pending.length]?.questionCallId;
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
