import { describe, expect, it } from "bun:test";

import type { ModelMessage } from "ai";

import {
  projectTranscriptForPersistence,
  TELEGRAM_INBOUND_FILE_TRANSIENT_PROVIDER_OPTIONS,
} from "../../src/transcript/transcript-persistence-projection";

describe("projectTranscriptForPersistence", () => {
  it("projects an exact marked user file once without mutating the source", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "file",
            data: "telegram-base64",
            mediaType: "image/png",
            providerOptions: TELEGRAM_INBOUND_FILE_TRANSIENT_PROVIDER_OPTIONS,
          },
          { type: "text", text: "after" },
        ],
      },
    ] satisfies ModelMessage[];

    const projected = projectTranscriptForPersistence(messages);

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "text",
            text: '[telegram_attachment mime="image/png"]\n(file content omitted from persisted transcript)',
          },
          { type: "text", text: "after" },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).toContain("telegram-base64");
    expect(projectTranscriptForPersistence(projected)).toBe(projected);
  });

  it("preserves message-level markers, near-marked files, and non-user messages", () => {
    const messages = [
      {
        role: "user",
        content: "message-level marker",
        providerOptions: TELEGRAM_INBOUND_FILE_TRANSIENT_PROVIDER_OPTIONS,
      },
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "unmarked-user-base64",
            mediaType: "image/jpeg",
          },
          {
            type: "file",
            data: "near-marked-user-base64",
            mediaType: "application/pdf",
            providerOptions: {
              lilac: {
                transient: { version: 2, source: "telegram-inbound-file" },
              },
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "assistant unchanged",
        providerOptions: TELEGRAM_INBOUND_FILE_TRANSIENT_PROVIDER_OPTIONS,
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  mediaType: "application/pdf",
                  data: { type: "data", data: "tool-base64" },
                },
              ],
            },
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(projectTranscriptForPersistence(messages)).toBe(messages);
  });
});
