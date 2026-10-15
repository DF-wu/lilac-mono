import { Check, Undo2 } from "lucide-react";
import { IconButton } from "./ui";

export function ThreadSettleButton({
  settled = false,
  title = "conversation",
  onClick,
  disabled,
}: {
  settled?: boolean;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const action = settled ? "Unsettle" : "Settle";
  return (
    <IconButton
      className="thread-settle-button rounded-xl"
      label={`${action} ${title || "conversation"}`}
      tooltip={action}
      onClick={onClick}
      disabled={disabled}
    >
      {settled ? (
        <Undo2 className="size-[var(--ui-icon-size)]" />
      ) : (
        <Check className="size-[var(--ui-icon-size)]" />
      )}
      <span className="hidden leading-none [text-box:trim-both_cap_alphabetic] [@media(hover:none)]:block">
        {action}
      </span>
    </IconButton>
  );
}
