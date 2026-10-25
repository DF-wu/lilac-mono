import { Copy } from "lucide-react";
import { attempt } from "./ui";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { ContextMenuItem } from "./ui/context-menu";
import { toast } from "./ui/toast";

function copySessionId(threadId: string) {
  void attempt(
    async () => {
      await navigator.clipboard.writeText(`native:${threadId}`);
      toast.add({ title: "Session ID copied" });
    },
    () => toast.add({ title: "Could not copy session ID", type: "error" }),
  );
}

export function CopySessionIdMenuItem({ threadId }: { threadId: string }) {
  return (
    <DropdownMenuItem onClick={() => copySessionId(threadId)}>
      <Copy />
      Copy session ID
    </DropdownMenuItem>
  );
}

export function CopySessionIdContextMenuItem({ threadId }: { threadId: string }) {
  return (
    <ContextMenuItem onClick={() => copySessionId(threadId)}>
      <Copy />
      Copy session ID
    </ContextMenuItem>
  );
}
