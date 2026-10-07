import { describe, expect, it } from "bun:test";
import { createOpenAIDecisionModel } from "../openai-decision-model";

describe("OpenAI decision images", () => {
  it("uses native image parts while preserving SDK predicate mapping and usage", async () => {
    const requests: unknown[] = [];
    const fetch = Object.assign(
      async (_request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          model: "gpt-6-luna",
          answers: [{ type: "predicate", name: "helps", probability: 0.8 }],
          usage: { input_tokens: 100, output_tokens: 0 },
        });
      },
      { preconnect: () => {} },
    );
    const model = createOpenAIDecisionModel({
      model: "gpt-6-luna",
      apiKey: "test",
      images: ["data:image/png;base64,test"],
      fetch,
    });
    const result = await model.doDecide({
      state: { message: "recall this diagram" },
      questions: { helps: { type: "boolean", instructions: "Would past context help?" } },
    });
    expect(requests).toEqual([
      {
        model: "gpt-6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: JSON.stringify({ message: "recall this diagram" }) },
              { type: "input_image", image_url: "data:image/png;base64,test" },
            ],
          },
        ],
        questions: [{ type: "predicate", name: "helps", instructions: "Would past context help?" }],
      },
    ]);
    expect(result.answers).toEqual({ helps: { type: "boolean", probability: 0.8 } });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 0 });
  });

  it("keeps text-only state and concurrent request images separate", async () => {
    const inputs: unknown[] = [];
    const fetch = Object.assign(
      async (_request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        inputs.push(JSON.parse(String(init?.body)).input);
        return Response.json({ answers: [{ type: "predicate", name: "helps", probability: 0.5 }] });
      },
      { preconnect: () => {} },
    );
    const call = {
      state: "message",
      questions: { helps: { type: "boolean" as const, instructions: "helpful?" } },
    };
    await Promise.all(
      [[], ["image-a"], ["image-b"]].map((images) =>
        createOpenAIDecisionModel({ model: "gpt-6-luna", apiKey: "test", images, fetch }).doDecide(
          call,
        ),
      ),
    );
    expect(inputs).toEqual([
      "message",
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "message" },
            { type: "input_image", image_url: "image-a" },
          ],
        },
      ],
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "message" },
            { type: "input_image", image_url: "image-b" },
          ],
        },
      ],
    ]);
  });
});
