import { expect, test } from "bun:test";
import { createDraftStore } from "../src/draft-store";
import { newDraftThread, prepareDraftSend } from "../src/draft-thread";

test("draft edits retain sidebar snapshots when the visible summary is unchanged", () => {
  const store = createDraftStore();
  const first = newDraftThread();
  first.draft.text = "a".repeat(80);
  const second = newDraftThread();
  second.draft.text = "Other draft";
  store.getState().setLocalDrafts(
    new Map([
      [first.id, first],
      [second.id, second],
    ]),
  );
  const summaries = store.getState().summaries;
  const edited = { ...first, draft: { ...first.draft, text: first.draft.text + " more typing" } };
  store.getState().setLocalDrafts(
    new Map([
      [first.id, edited],
      [second.id, second],
    ]),
  );
  expect(store.getState().summaries).toBe(summaries);
  expect(store.getState().localDrafts.get(first.id)).toBe(edited);
  expect(store.getState().localDrafts.get(second.id)).toBe(second);
  store.getState().setLocalDrafts(
    new Map([
      [first.id, { ...edited, title: "Renamed" }],
      [second.id, second],
    ]),
  );
  expect(store.getState().summaries[0]?.title).toBe("Renamed");
  expect(store.getState().summaries[1]).toBe(summaries[1]);
});

test("draft summaries track creation, clearing and removal without crossing sessions", () => {
  const store = createDraftStore();
  const other = createDraftStore();
  const draft = newDraftThread();
  draft.draft.text = "Ready";
  const creation = prepareDraftSend(draft, {
    text: "Ready",
    skillIds: [],
    attachments: [],
    mode: "steer",
  });
  store.getState().setLocalDrafts(new Map([[draft.id, { ...draft, creation }]]));
  expect(store.getState().summaries[0]?.editable).toBe(false);
  expect(other.getState().summaries).toEqual([]);
  expect(other.getState().localDrafts.has(draft.id)).toBe(false);
  store
    .getState()
    .setLocalDrafts(new Map([[draft.id, { ...draft, draft: { ...draft.draft, text: "" } }]]));
  expect(store.getState().summaries).toEqual([]);
  store.getState().setLocalDrafts(new Map());
  expect(store.getState().localDrafts.size).toBe(0);
});
