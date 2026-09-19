import { expect, test } from "bun:test";
import {
  draftAttachment,
  draftThreadTitle,
  hasDraftContent,
  newDraftThread,
  restoreDraftThread,
  prepareDraftSend,
} from "../src/draft-thread";

test("empty conversations stay absent from the sidebar until edited", () => {
  const thread = newDraftThread();
  expect(hasDraftContent(thread)).toBe(false);
  expect(hasDraftContent({ ...thread, draft: { ...thread.draft, text: "  " } })).toBe(false);
  const edited = { ...thread, draft: { ...thread.draft, text: "A local draft\nMore detail" } };
  expect(hasDraftContent(edited)).toBe(true);
  expect(draftThreadTitle(edited)).toBe("A local draft");
  expect(draftThreadTitle({ ...edited, title: "Renamed locally" })).toBe("Renamed locally");
});

test("files remain local before first send and count as draft content", async () => {
  const file = new File(["local-only"], "notes.txt", { type: "text/plain" });
  const attachment = draftAttachment(file);
  const thread = { ...newDraftThread(), attachments: [attachment] };
  expect(attachment.file).toBe(file);
  expect(attachment.resourceId).toBeUndefined();
  expect(await attachment.reservation).toBeUndefined();
  expect(hasDraftContent(thread)).toBe(true);
  expect(draftThreadTitle(thread)).toBe("notes.txt");
});

test("retrying first send preserves thread and message identities and the original payload", () => {
  const draft = newDraftThread();
  const thread = { ...draft, draft: { ...draft.draft, text: "First message" } };
  const submission = {
    text: "First message",
    skillIds: [],
    attachments: [],
    mode: "steer" as const,
    modelId: "original",
  };
  const creation = prepareDraftSend(thread, submission);
  const later = {
    ...thread,
    creation,
    title: "Changed while creating",
    modelId: "later",
    draft: { ...thread.draft, text: "Next message" },
  };
  expect(prepareDraftSend(later, { ...submission, text: "Next message", modelId: "later" })).toBe(
    creation,
  );
  expect(creation.title).toBe("First message");
  expect(creation.modelId).toBe("original");
  expect(creation.entry.text).toBe("First message");
  expect(creation.commandId).not.toBe(creation.entry.commandId);
  expect(hasDraftContent({ ...draft, creation })).toBe(true);
});

test("history restores the exact local draft and creates a fresh empty draft for deleted entries", () => {
  const first = newDraftThread();
  const second = newDraftThread();
  const drafts = new Map([
    [first.id, first],
    [second.id, second],
  ]);
  expect(restoreDraftThread(drafts, { draftThreadId: first.id })).toBe(first);
  expect(restoreDraftThread(drafts, { draftThreadId: second.id })).toBe(second);
  drafts.delete(first.id);
  const fallback = restoreDraftThread(drafts, { draftThreadId: first.id });
  expect(fallback.id).not.toBe(first.id);
  expect(hasDraftContent(fallback)).toBe(false);
  expect(hasDraftContent(restoreDraftThread(drafts, null))).toBe(false);
});

test("draft titles show inline file names without leaking local attachment handles", () => {
  const draft = newDraftThread();
  const withText = (text: string) => ({ ...draft, draft: { ...draft.draft, text } });
  expect(
    draftThreadTitle(withText("Review [my\\_\\[draft\\].png](attachment:local-id) next")),
  ).toBe("Review my_[draft].png next");
  expect(draftThreadTitle(withText("Literal `[image.png](attachment:local-id)` next"))).toBe(
    "Literal `[image.png](attachment:local-id)` next",
  );
  expect(draftThreadTitle(withText("Literal ``[image.png](attachment:local-id)` code``"))).toBe(
    "Literal ``[image.png](attachment:local-id)` code``",
  );
  expect(draftThreadTitle(withText("[website](https://example.com)"))).toBe(
    "[website](https://example.com)",
  );
  const prepared = prepareDraftSend(withText("Review [image.png](attachment:local-id)"), {
    text: "Review image.png",
    skillIds: [],
    mode: "steer",
    attachments: [],
  });
  expect(prepared.title).toBe("Review image.png");
});
