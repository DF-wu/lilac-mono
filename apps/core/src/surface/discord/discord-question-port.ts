import type { SurfaceAdapter } from "../adapter";
import type {
  SurfaceQuestionAnswerHandler,
  SurfaceQuestionAnswerSubscription,
  SurfaceQuestionInteractionUpdate,
  SurfaceQuestionPort,
  SurfaceQuestionPrompt,
  SurfaceQuestionSummary,
  SurfaceQuestionTerminalState,
} from "../question";
import {
  buildDiscordQuestionCustomActionId,
  buildDiscordQuestionOptionActionId,
} from "./discord-question-interactions";

export type DiscordQuestionAnswerSource = {
  subscribeQuestionAnswers(
    handler: SurfaceQuestionAnswerHandler<"discord">,
  ): Promise<SurfaceQuestionAnswerSubscription>;
};

export const DISCORD_QUESTION_ACTIVE_COLOR = 0x5865f2;
export const DISCORD_QUESTION_ANSWERED_COLOR = 0x57f287;
export const DISCORD_QUESTION_CANCELLED_COLOR = 0x99aab5;
export const DISCORD_QUESTION_INTERRUPTED_COLOR = 0xfee75c;

function questionText(prompt: SurfaceQuestionPrompt): string {
  const options = prompt.options
    .map((option) => `**${option.index}. ${option.label}**\n${option.description}`)
    .join("\n\n");
  return `**Q: ${prompt.header} (${prompt.ordinal}/${prompt.total})**\n\n${prompt.question}\n\n${options}`;
}

function questionActions(prompt: SurfaceQuestionPrompt) {
  return [
    ...prompt.options.map((option) => ({
      actionId: buildDiscordQuestionOptionActionId(option.token, option.index),
      label: String(option.index),
      style: "primary" as const,
    })),
    {
      actionId: buildDiscordQuestionCustomActionId(prompt.customToken),
      label: "Other…",
      style: "secondary" as const,
    },
  ];
}

function answeredText(summary: SurfaceQuestionSummary): string {
  const answers = summary.answers
    .map((entry, index) => {
      const value =
        entry.answer.kind === "option" ? entry.answer.label : "Custom response submitted";
      return `${index + 1}. **${entry.header}:** ${value}`;
    })
    .join("\n");
  return `**Answers**\n\n${answers}`;
}

export function discordQuestionInteractionContent(
  update: SurfaceQuestionInteractionUpdate,
): Parameters<SurfaceAdapter["editMsg"]>[1] {
  switch (update.state) {
    case "pending":
      return {
        text: questionText(update.prompt),
        format: "markdown",
        accentColor: DISCORD_QUESTION_ACTIVE_COLOR,
        actions: questionActions(update.prompt),
      };
    case "answered":
      return {
        text: answeredText(update.summary),
        format: "markdown",
        accentColor: DISCORD_QUESTION_ANSWERED_COLOR,
        actions: [],
      };
  }
}

function terminalText(state: SurfaceQuestionTerminalState): string {
  switch (state) {
    case "cancelled":
      return "**Question cancelled**";
    case "expired":
      return "**Question expired**";
    case "interrupted":
      return "**Question interrupted**";
  }
}

function terminalColor(state: SurfaceQuestionTerminalState): number {
  switch (state) {
    case "cancelled":
    case "expired":
      return DISCORD_QUESTION_CANCELLED_COLOR;
    case "interrupted":
      return DISCORD_QUESTION_INTERRUPTED_COLOR;
  }
}

export function createDiscordQuestionPort(input: {
  readonly adapter: SurfaceAdapter;
  readonly answers: DiscordQuestionAnswerSource;
}): SurfaceQuestionPort<"discord"> {
  return {
    present: async ({ sessionRef, replyTo, prompt }) =>
      await input.adapter
        .sendMsg(
          sessionRef,
          discordQuestionInteractionContent({ state: "pending", prompt }),
          replyTo ? { replyTo } : undefined,
        )
        .then((sent) =>
          sent.map((ref) => ({
            platform: "discord" as const,
            channelId: ref.channelId,
            messageId: ref.messageId,
          })),
        ),
    finish: async ({ messageRef, state }) =>
      await input.adapter.editMsg(messageRef, {
        text: terminalText(state),
        format: "markdown",
        accentColor: terminalColor(state),
        actions: [],
      }),
    subscribeAnswers: async (handler) => await input.answers.subscribeQuestionAnswers(handler),
  };
}
