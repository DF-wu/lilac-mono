import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type ChatModel = ReturnType<OpenAICompatibleProvider>;
type Prompt = Parameters<ChatModel["doGenerate"]>[0]["prompt"];
type UserMessage = Extract<Prompt[number], { role: "user" }>;

function liftToolImages(prompt: Prompt): Prompt {
  const transformed: Prompt = [];
  let attachments: UserMessage["content"] = [];

  for (const message of prompt) {
    if (message.role !== "tool") {
      if (attachments.length > 0) {
        transformed.push({ role: "user", content: attachments });
        attachments = [];
      }
      transformed.push(message);
      continue;
    }

    const content = message.content.map((result) => {
      if (result.type !== "tool-result" || result.output.type !== "content") return result;

      const value = result.output.value.map((part) => {
        if (part.type !== "file" || part.mediaType.split("/")[0] !== "image") return part;

        const label = `Tool image from ${result.toolName} (call ${result.toolCallId})${part.filename ? `: ${part.filename}` : ""}`;
        attachments.push({ type: "text", text: label }, part);
        return { type: "text" as const, text: `${label}; attached after the tool results.` };
      });
      return { ...result, output: { ...result.output, value } };
    });
    transformed.push({ ...message, content });
  }

  // Chat Completions requires the entire parallel tool reply group before the
  // user image message. This view never changes the canonical transcript.
  if (attachments.length > 0) transformed.push({ role: "user", content: attachments });
  return transformed;
}

const toolImageMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => ({ ...params, prompt: liftToolImages(params.prompt) }),
};

export function withOpenAICompatibleToolImages(
  provider: OpenAICompatibleProvider,
): OpenAICompatibleProvider {
  const languageModel: OpenAICompatibleProvider["languageModel"] = (modelId, config) =>
    wrapLanguageModel({
      model: provider.languageModel(modelId, config),
      middleware: toolImageMiddleware,
    });
  const chatModel: OpenAICompatibleProvider["chatModel"] = (modelId) =>
    wrapLanguageModel({ model: provider.chatModel(modelId), middleware: toolImageMiddleware });

  return Object.assign((modelId: string) => languageModel(modelId), provider, {
    languageModel,
    chatModel,
  });
}
