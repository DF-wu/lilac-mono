import { expect, it } from "bun:test";
import { hasSkillMention } from "../src/components/Composer";

it("retains only exact visible structured skill mentions", () => {
  expect(hasSkillMention("Use $review now", "review")).toBe(true);
  expect(hasSkillMention("/skill:review", "review")).toBe(true);
  expect(hasSkillMention("Use $reviewer", "review")).toBe(false);
  expect(hasSkillMention("Use $review-next", "review")).toBe(false);
  expect(hasSkillMention("", "review")).toBe(false);
  expect(hasSkillMention("$Better Result, please", "Better Result")).toBe(true);
  expect(hasSkillMention("$a+b", "a+b")).toBe(true);
});

import { inputDeliveryOptions } from "../src/input-mode";

it("queues active custom commands as follow-ups and preserves their next-run model", () => {
  expect(inputDeliveryOptions(true, "steer", "next-model", true)).toEqual({
    mode: "followup",
    modelId: "next-model",
  });
  expect(inputDeliveryOptions(true, "followup", "next-model", true)).toEqual({
    mode: "followup",
    modelId: "next-model",
  });
  expect(inputDeliveryOptions(false, "steer", "next-model", true)).toEqual({
    mode: "prompt",
    modelId: "next-model",
  });
  expect(inputDeliveryOptions(true, "steer", "next-model", false)).toEqual({
    mode: "steer",
    modelId: undefined,
  });
});
