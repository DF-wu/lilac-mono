import { useState } from "react";
import { Check, Pencil, Undo2 } from "lucide-react";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { moveInQueues, type ThreadQueues } from "../sidebar-order";
import { ThreadQueue } from "./ThreadQueue";
import { ThreadCard } from "./ThreadSelect";
import { IconButton } from "./ui";
const titles = [
  "Plan the next release",
  "Compare the two proposals",
  "Find a quiet place for lunch",
  "Review the weekend itinerary",
  "Write up the meeting notes",
];
function initialQueues(): ThreadQueues {
  const entries = titles.map((title, index) => {
    const source: NativeThread = {
      id: `queue-demo-${index}`,
      title,
      starterId: index % 2 ? "morgan" : "alex",
      starterDisplayName: index % 2 ? "Morgan Lee" : "Alex Chen",
      updatedAt: Date.now() - index * 3_600_000,
      revision: 0,
      archived: false,
      displayStatus: index === 1 ? "working" : "idle",
      capabilities: { read: true, edit: true, share: true },
    };
    return { id: source.id, source };
  });
  return { pinned: entries.slice(0, 1), active: entries.slice(1, 4), settled: entries.slice(4) };
}
export function ThreadQueueDemo() {
  const [queues, setQueues] = useState(initialQueues);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  return (
    <div className="ds-queue-preview">
      <ThreadQueue
        queues={queues}
        totals={{
          pinned: queues.pinned.length,
          active: queues.active.length,
          settled: queues.settled.length,
        }}
        onMove={(move) => setQueues((current) => moveInQueues(current, move))}
        settledOpen={open}
        onSettledOpen={setOpen}
        renderThread={(entry, section) => (
          <ThreadCard
            title={entry.source!.title}
            starterName={entry.source!.starterDisplayName!}
            updatedAt={entry.source!.updatedAt}
            state={entry.source!.displayStatus ?? "idle"}
            selected={selected === entry.id}
            onSelect={() => setSelected(entry.id)}
            actions={
              <>
                <IconButton
                  label={section === "settled" ? "Unsettle" : "Settle"}
                  onClick={() =>
                    setQueues((current) =>
                      moveInQueues(current, {
                        threadId: entry.id,
                        section: section === "settled" ? "active" : "settled",
                        atStart: true,
                      }),
                    )
                  }
                >
                  {section === "settled" ? <Undo2 /> : <Check />}
                </IconButton>
                <IconButton label="Rename" onClick={() => setSelected(entry.id)}>
                  <Pencil />
                </IconButton>
              </>
            }
          />
        )}
      />
    </div>
  );
}
