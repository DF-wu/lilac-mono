import type { DisplayCatalog } from "@stanley2058/lilac-client-protocol";
import type { AppProps, ComposerSubmission } from "../types";
import { draftAttachment, releaseDraftAttachments, type DraftThread } from "../draft-thread";
import { Composer } from "./Composer";
import { Button } from "./ui/button";
import { ErrorNotice } from "./ui";

export function DraftChat(props: {
  client: AppProps["client"];
  scope: AppProps["scope"];
  catalog?: DisplayCatalog;
  thread: DraftThread;
  onChange: (update: (thread: DraftThread) => DraftThread) => void;
  onSubmit: (submission: ComposerSubmission) => void;
}) {
  const { thread, onChange } = props;
  const draft = thread.draft;
  return (
    <div className="chat-workspace draft-workspace chat-scroll">
      <div className="welcome">
        <span className="brand">
          lilac
          <span />
        </span>
      </div>
      <div className="chat-bottom">
        <ErrorNotice
          message={thread.error}
          onDismiss={() => onChange((current) => ({ ...current, error: undefined }))}
        />
        {thread.creation ? (
          <div className="pending-input">
            <span>{thread.creation.entry.text}</span>
            <small>
              {thread.sending ? "Creating conversation…" : "Conversation could not be created."}
            </small>
            {!thread.sending ? (
              <Button
                type="button"
                onClick={() => props.onSubmit(thread.creation!.entry.submission)}
              >
                Retry message
              </Button>
            ) : null}
          </div>
        ) : null}
        <Composer
          windowDrop
          client={props.client}
          scope={props.scope}
          catalog={props.catalog}
          text={draft.text}
          skillIds={draft.skillIds}
          commandId={draft.commandId}
          onSkills={(skillIds) =>
            onChange((current) => ({ ...current, draft: { ...current.draft, skillIds } }))
          }
          onCommand={(commandId) =>
            onChange((current) => ({ ...current, draft: { ...current.draft, commandId } }))
          }
          onText={(text) =>
            onChange((current) => ({ ...current, draft: { ...current.draft, text } }))
          }
          attachments={thread.attachments}
          onAttach={(files) => {
            const added = files.slice(0, 32 - thread.attachments.length).map(draftAttachment);
            onChange((current) => ({
              ...current,
              attachments: [...current.attachments, ...added],
              draft: {
                ...current.draft,
                attachments: [...current.draft.attachments, ...added.map((item) => item.key)],
              },
            }));
          }}
          onRemoveAttachment={(key) => {
            releaseDraftAttachments(thread.attachments.filter((item) => item.key === key));
            onChange((current) => ({
              ...current,
              attachments: current.attachments.filter((item) => item.key !== key),
              draft: {
                ...current.draft,
                attachments: current.draft.attachments.filter((id) => id !== key),
              },
            }));
          }}
          onRetryAttachment={() => {}}
          active={false}
          canCancel={false}
          disabled={false}
          submitting={!!thread.creation}
          modelId={thread.modelId}
          onModelChange={(modelId) => onChange((current) => ({ ...current, modelId }))}
          onSubmit={props.onSubmit}
          onCancel={() => {}}
        />
      </div>
    </div>
  );
}
