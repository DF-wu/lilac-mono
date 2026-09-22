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
it("appends later GitHub pages and replaces the snapshot on refresh", () => {
  const old = page("github", ["a", "b"]);
  expect(
    mergeExternalPage(old, page("github", ["b", "c"]), true).messages.map((message) => message.id),
  ).toEqual(["a", "b", "c"]);
  expect(
    mergeExternalPage(old, page("github", ["c"]), false).messages.map((message) => message.id),
  ).toEqual(["c"]);
});

it("orders newest-first Discord responses chronologically across page boundaries", () => {
  const latest = page("discord", ["d", "c"]);
  const older = page("discord", ["c", "b", "a"]);
  for (const current of [latest, older])
    for (const message of current.messages)
      message.metadata = { createdAt: message.id.charCodeAt(0) };
  const first = mergeExternalPage(undefined, latest, true);
  expect(first.messages.map((message) => message.id)).toEqual(["c", "d"]);
  expect(mergeExternalPage(first, older, true).messages.map((message) => message.id)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
});
