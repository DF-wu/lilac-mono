import { expect, it } from "bun:test";
import { mergeExternalPage, type ExternalPage } from "../src/external-pages";
function page(surface: "discord" | "github", ids: string[]): ExternalPage {
  return {
    thread: { id: "external", title: "External", surface, retrievedAt: 123 },
    messages: ids.map((id) => ({ id, role: "user", parts: [{ type: "text", text: id }] })),
  };
}
it("prepends older Discord pages and removes overlapping boundary messages", () => {
  expect(
    mergeExternalPage(page("discord", ["b", "c"]), page("discord", ["a", "b"]), true).messages.map(
      (message) => message.id,
    ),
  ).toEqual(["a", "b", "c"]);
});
it("prepends older GitHub pages and replaces the snapshot on refresh", () => {
  const old = page("github", ["b", "c"]);
  expect(
    mergeExternalPage(old, page("github", ["a", "b"]), true).messages.map((message) => message.id),
  ).toEqual(["a", "b", "c"]);
  expect(
    mergeExternalPage(old, page("github", ["c"]), false).messages.map((message) => message.id),
  ).toEqual(["c"]);
});

it("preserves canonical run order even when timestamps tie or go backward", () => {
  const latest = page("discord", ["c", "d"]);
  const older = page("discord", ["a", "b", "c"]);
  for (const current of [latest, older])
    for (const message of current.messages)
      message.metadata = { createdAt: 100 - message.id.charCodeAt(0), externalRunId: "run" };
  expect(
    mergeExternalPage(mergeExternalPage(undefined, latest, true), older, true).messages.map(
      (message) => message.id,
    ),
  ).toEqual(["a", "b", "c", "d"]);
});
