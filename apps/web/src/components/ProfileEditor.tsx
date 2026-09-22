import { useRef } from "react";
import { ImagePlus, RotateCcw, SquarePen } from "lucide-react";
import { ActorAvatar, type ActorIdentity } from "./ActorAvatar";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";

export function ProfileEditor({
  identity,
  name,
  onNameChange,
  disabled,
  saving = false,
  onSave,
  onAvatarChange,
}: {
  identity: ActorIdentity;
  name: string;
  onNameChange: (name: string) => void;
  disabled: boolean;
  saving?: boolean;
  onSave: () => void;
  onAvatarChange: (file: File | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const canSave = !disabled && !!name.trim() && name.trim() !== identity.displayName;
  return (
    <div className="profile-editor flex items-center gap-6 mb-8">
      <div className="profile-avatar-editor relative flex-none">
        <ActorAvatar {...identity} size="lg" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                className="profile-avatar-action absolute right-[calc(-1_*_calc(var(--ui-space-unit)*1))] bottom-[calc(-1_*_calc(var(--ui-space-unit)*1))] bg-background rounded-full"
                label="Edit avatar"
                disabled={disabled}
              >
                <SquarePen />
              </IconButton>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => fileInput.current?.click()}>
              <ImagePlus /> Upload
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!identity.avatarUrl} onClick={() => onAvatarChange(null)}>
              <RotateCcw /> Reset
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInput}
          type="file"
          className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap"
          aria-label="Upload avatar"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onAvatarChange(file);
          }}
        />
      </div>
      <form
        className="profile-name-form flex items-end gap-3 min-w-0 flex-1 max-w-112"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) onSave();
        }}
      >
        <label className="field flex items-center justify-between gap-4 mb-4">
          Display name
          <Input
            maxLength={256}
            value={name}
            disabled={disabled}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}
