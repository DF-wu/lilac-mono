import { expect, test } from "bun:test";
import { corePrimaryLineageV2Schema } from "@stanley2058/lilac-event-bus";
import type { ModelMessage } from "ai";
import {
  degradeCorePrimaryLineageForMutation,
  mapCorePrimaryCompactionCurrentCanonicalStart,
} from "../../../src/surface/bridge/bus-agent-runner/lineage";

test("restored current-input lineage follows repeated canonical compaction replacements", () => {
  const current = {
    role: "user",
    content: [
      { type: "text", text: "Keep this exact active input" },
      { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
    ],
  } satisfies ModelMessage;
  const original: ModelMessage[] = [
    { role: "user", content: "older one" },
    { role: "assistant", content: "older answer" },
    { role: "user", content: "retained older turn" },
    { role: "assistant", content: "retained answer" },
    current,
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "read",
          output: { type: "text", value: "exact tool result" },
        },
      ],
    },
  ];
  const first = [
    { role: "user", content: "first summary" } satisfies ModelMessage,
    ...original.slice(2),
  ];
  const firstBoundary = mapCorePrimaryCompactionCurrentCanonicalStart({
    previousCurrentCanonicalStart: 4,
    replacement: {
      originalSuffixStart: 2,
      replacementSuffixStart: 1,
      replacementMessageCount: first.length,
    },
  });
  const checkpoint = corePrimaryLineageV2Schema.parse(
    JSON.parse(
      JSON.stringify(
        degradeCorePrimaryLineageForMutation("compaction-checkpoint-transform", firstBoundary),
      ),
    ),
  );
  expect(checkpoint.currentCanonicalStart).toBe(3);
  expect(first.slice(checkpoint.currentCanonicalStart)).toEqual(original.slice(4));

  const second = [
    { role: "user", content: "second summary" } satisfies ModelMessage,
    ...first.slice(3),
  ];
  const secondBoundary = mapCorePrimaryCompactionCurrentCanonicalStart({
    previousCurrentCanonicalStart: checkpoint.currentCanonicalStart,
    replacement: {
      originalSuffixStart: 3,
      replacementSuffixStart: 1,
      replacementMessageCount: second.length,
    },
  });
  expect(secondBoundary).toBe(1);
  expect(second.slice(secondBoundary)).toEqual(original.slice(4));
  expect(second[secondBoundary]).toBe(current);
});
