import { latestUserInput } from "../../../src/surface/bridge/bus-agent-runner/text-units";
import { expect, test } from "bun:test";
import { buildGeneratedMessage } from "@stanley2058/lilac-agent";
import { customCommandUserContent } from "../../../src/surface/bridge/bus-agent-runner/generated-command-content";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";

test("command outputs retain media, references, filenames and provider options", () => {
  const parts = customCommandUserContent(
    {
      type: "content",
      value: [
        { type: "text", text: "command output" },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "url", url: new URL("https://example.com/image.png") },
        },
        { type: "file-data", mediaType: "text/plain", data: "YQ==", filename: "result.txt" },
        {
          type: "image-file-id",
          fileId: "image-1",
          providerOptions: { anthropic: { detail: "high" } },
        },
      ],
    },
    "anthropic",
  );
  expect(parts).toMatchObject([
    { type: "text", text: "command output" },
    { type: "file", mediaType: "image/png", data: { type: "url" } },
    {
      type: "file",
      mediaType: "text/plain",
      filename: "result.txt",
      data: { type: "data", data: "YQ==" },
    },
    {
      type: "file",
      mediaType: "image",
      data: { type: "reference", reference: { anthropic: "image-1" } },
      providerOptions: { anthropic: { detail: "high" } },
    },
  ]);
});

test("generated identity survives stored-message projection", () => {
  const message = buildGeneratedMessage({
    kind: "custom_command_result",
    id: "command-1",
    content: customCommandUserContent({ type: "error-text", value: "command failed" }, "openai"),
  });
  const stored = projectStoredMessagesV1([message]).unwrap();
  expect(stored[0]).toMatchObject({
    role: "user",
    providerOptions: {
      lilac: { generated: { version: 1, kind: "custom_command_result", id: "command-1" } },
    },
  });
  expect(JSON.stringify(stored)).toContain("command failed");
  expect(JSON.stringify(stored)).not.toContain('"tool-call"');
});

test("generated context does not replace the latest human input", () => {
  const generated = buildGeneratedMessage({
    kind: "conversation_recall",
    id: "recall-1",
    content: "retrieval hints",
  });
  expect(
    latestUserInput([{ role: "user", content: "human request" }, generated]).authoredText,
  ).toBe("human request");
  expect(latestUserInput([generated]).text).toBe("");
});
