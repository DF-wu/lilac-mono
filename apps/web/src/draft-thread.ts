import { z } from "zod";
import type { ComposerSubmission, Attachment } from "./types";
import type { Draft, PendingInput } from "./components/Chat";

export type DraftThread = {
  id: string;
  draft: Draft;
  attachments: Attachment[];
  title?: string;
  modelId?: string;
  sending?: boolean;
  error?: string;
  creation?: {
    commandId: string;
    title: string;
    modelId?: string;
    entry: PendingInput;
  };
};

export function newDraftThread(): DraftThread {
  return {
    id: `draft:${crypto.randomUUID()}`,
    draft: { text: "", skillIds: [], attachments: [] },
    attachments: [],
  };
}

export function draftThreadTitle(thread: DraftThread): string {
  return (
    (thread.title ?? thread.draft.text.trim().split("\n")[0]?.slice(0, 80) ?? "") ||
    thread.attachments[0]?.file.name ||
    "New conversation"
  );
}

export function hasDraftContent(thread: DraftThread): boolean {
  return !!(
    thread.draft.text.trim() ||
    thread.draft.skillIds.length ||
    thread.draft.commandId ||
    thread.attachments.length ||
    thread.creation
  );
}

export function draftAttachment(file: File): Attachment {
  return {
    key: crypto.randomUUID(),
    file,
    ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    reservation: Promise.resolve(undefined),
    progress: 0,
    state: "ready",
  };
}

export function prepareDraftSend(
  thread: DraftThread,
  submission: ComposerSubmission,
): NonNullable<DraftThread["creation"]> {
  if (thread.creation) return thread.creation;
  return {
    commandId: crypto.randomUUID(),
    title: draftThreadTitle(thread),
    modelId: submission.modelId,
    entry: {
      commandId: crypto.randomUUID(),
      text: submission.text,
      submission,
      state: "preparing",
    },
  };
}

export function releaseDraftAttachments(attachments: readonly Attachment[]) {
  for (const attachment of attachments)
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
}

const draftHistorySchema = z.strictObject({ draftThreadId: z.string() });

export function restoreDraftThread(
  drafts: ReadonlyMap<string, DraftThread>,
  historyState: unknown,
): DraftThread {
  const parsed = draftHistorySchema.safeParse(historyState);
  if (!parsed.success) return newDraftThread();
  return drafts.get(parsed.data.draftThreadId) ?? newDraftThread();
}
