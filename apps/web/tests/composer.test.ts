import { expect, it } from "bun:test";
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
