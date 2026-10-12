import { useMemo, useState } from "react";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";

export function CitationDemo() {
  const [text, setText] = useState("");
  const [store] = useState(() => {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: 1,
        cursor: "citation-demo",
      },
      slots: [
        {
          kind: "ready",
          slotId: "citation-demo-turn",
          turnId: "citation-demo-turn",
          position: 0,
          state: "complete",
          messages: [
            {
              id: "citation-demo-message",
              role: "assistant",
              metadata: { phase: "final" },
              parts: [
                {
                  type: "text",
                  text: "Select part of this reply and **Cite** it.\n\nThe comment stays beside the selected text. Your saved quote survives changes to its source.\n\n- Keep the quote and your comment together.\n- Follow [the source](https://example.com).\n\n```ts\nconst reply = { quoted: true };\n```",
                },
              ],
            },
          ],
        },
      ],
    });
    return store;
  });
  const client = useMemo(
    () => ({ thread: () => store, hydrate: async () => {}, loadTurnPage: async () => {} }),
    [store],
  );
  const noop = () => {};
  return (
    <div className="h-120 flex flex-col bg-background rounded-lg" data-thread-id="citation-demo">
      <Timeline
        threadId="citation-demo"
        client={client}
        canEdit
        resourceUrl={(id) => id}
        onAction={noop}
        onReaction={noop}
        onRewind={noop}
        footer={
          <Composer
            documentKey="citation-demo"
            text={text}
            onText={setText}
            attachments={[]}
            skillIds={[]}
            onSkills={noop}
            onCommand={noop}
            onAttach={noop}
            onRemoveAttachment={noop}
            onRetryAttachment={noop}
            active={false}
            canCancel={false}
            disabled={false}
            onModelChange={noop}
            onCancel={noop}
            onSubmit={() => setText("")}
          />
        }
      />
    </div>
  );
}
