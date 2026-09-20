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
    <div className="profile-editor">
      <div className="profile-avatar-editor">
        <ActorAvatar {...identity} size="lg" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton className="profile-avatar-action" label="Edit avatar" disabled={disabled}>
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
          className="sr-only"
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
        className="profile-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) onSave();
        }}
      >
        <label className="field">
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
