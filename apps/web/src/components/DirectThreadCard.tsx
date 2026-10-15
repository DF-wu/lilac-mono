import { MessageCircle } from "lucide-react";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-spinner";

export function DirectThreadCard({
  thread,
  selected,
  onSelect,
}: {
  thread: NativeThread;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      className="mx-2 mb-2 justify-start gap-3 shrink-0"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect(thread.id)}
      data-dm-card
    >
      <MessageCircle />
      <span className="flex-1 text-left">Chat with Lilac</span>
      {thread.displayStatus === "working" ? <LoadingSpinner /> : null}
      {thread.displayStatus === "completed" ? (
        <span className="text-xs text-muted-foreground">Unread</span>
      ) : null}
    </Button>
  );
}
