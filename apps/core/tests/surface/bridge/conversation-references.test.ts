import { expect, test } from "bun:test";
import type { ModelMessage, UserContent } from "ai";
import { expandConversationReferencesForModel } from "../../../src/surface/bridge/conversation-references";

test("cross-surface model input gains coordinates without changing canonical messages", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Read https://chat.example/?ref=native%3Athread&message=message" },
    { role: "assistant", content: "https://chat.example/?ref=native%3Aother" },
  ];
  const before = structuredClone(messages);
  const expanded = expandConversationReferencesForModel(messages, "https://chat.example/");
  expect(expanded[0]?.content).toContain(
    '"client":"native","sessionId":"thread","messageId":"message","conversationThreadId":"native:thread"',
  );
  expect(expanded[1]).toBe(messages[1]);
  expect(messages).toEqual(before);
  expect(expandConversationReferencesForModel(messages, "https://chat.example/")).toEqual(expanded);
});

test("multipart input preserves media and expands thread-only links", () => {
  const content = [
    { type: "text", text: "[thread](/?ref=discord%3Achannel)" },
    { type: "image", image: new URL("https://example.com/image.png") },
  ] satisfies UserContent;
  const messages: ModelMessage[] = [{ role: "user", content }];
  const expanded = expandConversationReferencesForModel(messages, "https://chat.example");
  expect(expanded[0]?.content).toEqual([
    ...content,
    { type: "text", text: expect.stringContaining('"client":"discord","sessionId":"channel"') },
  ]);
});

test("foreign origins and code examples leave model input unchanged", () => {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: "https://other.example/?ref=native%3Athread\n`/?ref=native%3Ahidden`",
    },
  ];
  expect(expandConversationReferencesForModel(messages, "https://chat.example")[0]).toBe(
    messages[0],
  );
});
