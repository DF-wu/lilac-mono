import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { SurfaceAdapter } from "../../src/surface/adapter";
import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";
import type { SurfaceQuestionPort } from "../../src/surface/question";
import { SurfaceRuntimeRegistry } from "../../src/surface/runtime-descriptor";

const questionPort: SurfaceQuestionPort<"discord"> = {
  present: async () =>
    Result.ok({ platform: "discord", channelId: "channel", messageId: "message" }),
  finish: async () => Result.ok(undefined),
  subscribeAnswers: async () => ({ stop: async () => undefined }),
};

describe("surface question capability", () => {
  it("is discoverable only when a runtime descriptor advertises it", () => {
    const created = SurfaceRuntimeRegistry.create([
      {
        protocol: BUILTIN_SURFACE_PROTOCOLS.discord,
        adapter: {} as SurfaceAdapter,
        createQuestion: () => questionPort,
      },
      {
        protocol: BUILTIN_SURFACE_PROTOCOLS.github,
        adapter: {} as SurfaceAdapter,
      },
    ]);
    expect(created.status).toBe("ok");
    if (created.status === "error") return;

    const questions = created.value.questionResolver();
    expect(questions.resolve("discord")?.question).toBe(questionPort);
    expect(questions.resolve("github")).toBeNull();
    expect(questions.entries().map(({ platform }) => platform)).toEqual(["discord"]);
  });
});
