import { useState } from "react";
import { FaceSlightlySmilingPlus } from "lucide-react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import { useMessageServices } from "./message-services";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type Reaction = Extract<DisplayPart, { type: "data-reactions" }>["data"]["items"][number];
const quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "🔥", "✅", "🤔", "🚀", "💯", "👎"];

export function reactionTooltip(reaction: Reaction): string {
  const names = reaction.userNames?.slice(0, 5) ?? [];
  const overflow = reaction.overflowCount ?? Math.max(0, reaction.count - names.length);
  return [...names, ...(overflow > 0 ? [`+${overflow}`] : [])].join(", ");
}

export function MessageReactions({ messageId, items }: { messageId: string; items: Reaction[] }) {
  const { canEdit, onReaction } = useMessageServices();
  if (!items.length) return null;
  return (
    <div data-ui="message-reactions" className="flex flex-wrap items-center gap-2 mt-3">
      {items.map((reaction) => (
        <Tooltip key={reaction.emoji}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                aria-disabled={!canEdit}
                aria-label={`${reaction.emoji}, ${reaction.count} reactions`}
                aria-pressed={reaction.reacted}
                variant="secondary"
                className="h-7 max-w-full gap-1 rounded-sm bg-surface-hover px-2 text-xs aria-pressed:bg-primary/10 aria-pressed:text-primary"
                onClick={() => {
                  if (canEdit) onReaction(messageId, reaction.emoji, !reaction.reacted);
                }}
              />
            }
          >
            <span className="min-w-0 truncate text-base">{reaction.emoji}</span>
            <span className="shrink-0">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipContent>{reactionTooltip(reaction)}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function AddReaction({
  messageId,
  items,
  disabled,
}: {
  messageId: string;
  items: Reaction[];
  disabled?: boolean;
}) {
  const { canEdit, onReaction } = useMessageServices();
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState("");
  function select(value: string) {
    onReaction(messageId, value, !items.some((item) => item.emoji === value && item.reacted));
    setOpen(false);
    setEmoji("");
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<IconButton label="Add reaction" disabled={!canEdit || disabled} />}>
        <FaceSlightlySmilingPlus />
      </PopoverTrigger>
      <PopoverContent aria-label="Choose a reaction" className="w-64 p-2" align="end">
        <div className="grid grid-cols-6 gap-1">
          {quickReactions.map((value) => (
            <Button
              key={value}
              variant="ghost"
              size="icon"
              aria-label={`React ${value}`}
              onClick={() => select(value)}
            >
              <span className="text-lg">{value}</span>
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (emoji.trim()) select(emoji.trim());
          }}
        >
          <Input
            aria-label="Emoji"
            placeholder="Paste an emoji"
            maxLength={128}
            value={emoji}
            onChange={(event) => setEmoji(event.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!emoji.trim()}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
