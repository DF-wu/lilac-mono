import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { expect, test } from "bun:test";
import {
  draftAttachment,
  draftThreadTitle,
  hasDraftContent,
  newDraftThread,
  restoreDraftThread,
  prepareDraftSend,
  applyDraftTitleChanges,
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

test("first-send titles use attachment labels without Markdown escapes", () => {
  const thread = newDraftThread();
  const creation = prepareDraftSend(thread, {
    text: "polish-preview\\.md ",
    attachmentText: "[polish-preview.md](attachment:file-key) ",
    skillIds: [],
    mode: "steer",
    attachments: [],
  });
  expect(creation.title).toBe("polish-preview.md");
});

test("automatic first-line titles allow generation while manual draft titles do not", () => {
  const draft = newDraftThread();
  const submission = {
    text: "First line\nMore details",
    skillIds: [],
    attachments: [],
    mode: "steer" as const,
  };
  const automatic = prepareDraftSend(draft, submission);
  expect(automatic.title).toBe("First line");
  expect(automatic.autoTitle).toBe(true);
  const manual = prepareDraftSend({ ...draft, title: "My chosen title" }, submission);
  expect(manual.title).toBe("My chosen title");
  expect(manual.autoTitle).toBe(false);
});

function createdThread(): NativeThread {
  return {
    id: "thread",
    title: "First line",
    starterId: "owner",
    archived: false,
    updatedAt: 0,
    revision: 1,
    capabilities: { read: true, edit: true, share: true },
  };
}

test("first-send handoff preserves renames during creation and while the rename request is pending", async () => {
  const created = Promise.withResolvers<NativeThread>();
  const renameStarted = Promise.withResolvers<void>();
  const rename = Promise.withResolvers<NativeThread>();
  let title: string | undefined;
  const updates: Array<{ revision: number; title: string }> = [];
  const handoff = (async () =>
    applyDraftTitleChanges({
      thread: await created.promise,
      initialTitle: undefined,
      getTitle: () => title,
      updateTitle: async (thread, nextTitle) => {
        updates.push({ revision: thread.revision, title: nextTitle });
        if (updates.length === 1) {
          renameStarted.resolve();
          return rename.promise;
        }
        return { ...thread, title: nextTitle, revision: thread.revision + 1 };
      },
    }))();
  title = "Renamed while creating";
  created.resolve(createdThread());
  await renameStarted.promise;
  title = "Renamed again";
  rename.resolve({ ...createdThread(), title: "Renamed while creating", revision: 2 });
  expect((await handoff)?.title).toBe("Renamed again");
  expect(updates).toEqual([
    { revision: 1, title: "Renamed while creating" },
    { revision: 2, title: "Renamed again" },
  ]);
});

test("same-text manual rename still disables automatic titles, and failed handoff remains retryable", async () => {
  let calls = 0;
  const result = await applyDraftTitleChanges({
    thread: createdThread(),
    initialTitle: undefined,
    getTitle: () => "First line",
    updateTitle: async () => {
      calls++;
      return undefined;
    },
  });
  expect(calls).toBe(1);
  expect(result).toBeUndefined();
  const unchanged = await applyDraftTitleChanges({
    thread: createdThread(),
    initialTitle: "First line",
    getTitle: () => "First line",
    updateTitle: async () => {
      calls++;
      return undefined;
    },
  });
  expect(unchanged?.title).toBe("First line");
  expect(calls).toBe(1);
});
