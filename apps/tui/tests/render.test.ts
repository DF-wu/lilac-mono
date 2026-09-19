import "@opentui/solid/preload";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createComponent } from "solid-js";
import { controllerFixture } from "./controller.test.ts";

const { TuiApp } = await import("../src/app.tsx");
test("modern-terminal input, plain output, completion and clean exit", async () => {
  const f = controllerFixture();
  let exited = false;
  const exitDone = Promise.withResolvers<void>();
  const rendered = await testRender(
    () =>
      createComponent(TuiApp, {
        controller: f.controller,
        threadId: "thread",
        onExit: async () => {
          exited = true;
          exitDone.resolve();
        },
      }),
    { width: 90, height: 28, kittyKeyboard: true, exitOnCtrlC: false },
  );
  await rendered.waitForFrame((frame) => frame.includes("Fixture"));
  await rendered.mockInput.typeText("$Rev");
  await rendered.waitForFrame((frame) => frame.includes("$Review"));
  rendered.mockInput.pressTab();
  await rendered.waitFor(() => f.controller.state.draft === "$Review ");
  rendered.mockInput.pressEnter({ shift: true });
  await rendered.waitFor(() => f.controller.state.draft.includes("\n"));
  await rendered.mockInput.typeText("message");
  rendered.mockInput.pressEnter();
  await rendered.waitFor(() => f.submitted.length === 1);
  expect(f.submitted[0]?.skillIds).toEqual(["skill"]);
  expect(f.submitted[0]?.text).toContain("\nmessage");
  rendered.mockInput.pressCtrlC();
  await rendered.waitFor(() => f.canceled() === 1);
  expect(exited).toBe(false);
  rendered.mockInput.pressKey("q", { ctrl: true });
  await rendered.flush();
  await exitDone.promise;
  expect(exited).toBe(true);
});
