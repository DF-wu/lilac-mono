import type { ModelMessage } from "ai";
import { z } from "zod";

export const openAICompactionPartSchema = z
  .object({
    type: z.literal("custom"),
    kind: z.literal("openai.compaction"),
    providerOptions: z.unknown().optional(),
  })
  .passthrough();

export type OpenAICompactionPart = z.infer<typeof openAICompactionPartSchema>;

export const openAIMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export type OpenAIMessagePhase = z.infer<typeof openAIMessagePhaseSchema>;

const openAIMessagePhaseMetadataSchema = z.object({
  openai: z.object({ phase: openAIMessagePhaseSchema }),
});

export function openAIMessagePhase(value: unknown): OpenAIMessagePhase | undefined {
  const parsed = openAIMessagePhaseMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data.openai.phase : undefined;
}

export function decodeOpenAICompactionPart(value: unknown): OpenAICompactionPart | undefined {
  const parsed = openAICompactionPartSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Compatibility predicate for consumers that narrow AI SDK message parts. */
export function isOpenAICompactionPart(value: unknown): value is OpenAICompactionPart {
  return decodeOpenAICompactionPart(value) !== undefined;
}

function withoutOpenAIItemId(
  providerOptions: ModelMessage["providerOptions"],
): ModelMessage["providerOptions"] {
  const openai = providerOptions?.openai;
  if (!openai || !("itemId" in openai)) return providerOptions;

  const { itemId: _itemId, ...openaiWithoutItemId } = openai;
  return { ...providerOptions, openai: openaiWithoutItemId };
}

/**
 * Clones model messages for stateless OpenAI Responses replay without changing
 * the canonical transcript or discarding other provider metadata.
 */
export function withoutOpenAIItemIds(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) =>
          "providerOptions" in part
            ? Object.assign(structuredClone(part), {
                providerOptions: isOpenAICompactionPart(part)
                  ? part.providerOptions
                  : withoutOpenAIItemId(part.providerOptions),
              })
            : structuredClone(part),
        ),
      };
    }

    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) =>
          "providerOptions" in part
            ? Object.assign(structuredClone(part), {
                providerOptions: withoutOpenAIItemId(part.providerOptions),
              })
            : structuredClone(part),
        ),
      };
    }

    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) =>
          Object.assign(structuredClone(part), {
            providerOptions: withoutOpenAIItemId(part.providerOptions),
          }),
        ),
      };
    }

    return { ...message };
  });
}
