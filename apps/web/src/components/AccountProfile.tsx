import { useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import type { NativeUser } from "@stanley2058/lilac-client-protocol";
import { ImagePlus, Trash2 } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { ActorAvatar } from "./ActorAvatar";
import { ErrorNotice, IconButton } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function AccountProfile({ viewer }: { viewer: NativeUser }) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const [draftName, setDraftName] = useState<string>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const name = draftName ?? viewer.displayName;
  const save = useMutation({
    mutationFn: (displayName: string) => client.rpc!.profile.update({ displayName }),
    onSuccess: async (profile) => {
      await queries.cancelQueries({ queryKey: ["profile"] });
      queries.setQueryData(["profile"], profile);
      setDraftName(undefined);
      await queries.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (failure) => setError(failure.message),
  });
  const avatar = useMutation({
    mutationFn: async (file: File | null) => {
      if (
        file &&
        (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) ||
          file.size > 2 * 1024 * 1024)
      )
        return Result.err("Choose a PNG, JPEG, WebP or GIF up to 2 MiB.");
      const response = await Result.tryPromise({
        try: () =>
          fetch("/api/profile/avatar", {
            method: file ? "PUT" : "DELETE",
            credentials: "same-origin",
            headers: file ? { "content-type": file.type } : undefined,
            body: file,
          }),
        catch: () => "Could not update your avatar. Check your connection and try again.",
      });
      return response.andThen((value) =>
        value.ok ? Result.ok() : Result.err("Could not update your avatar. Please try again."),
      );
    },
    onSuccess: async (result) => {
      const saved = result.match({
        ok: () => true,
        err: (message) => {
          setError(message);
          return false;
        },
      });
      if (!saved) return;
      await queries.invalidateQueries({ queryKey: ["profile"] });
      await queries.invalidateQueries({ queryKey: ["participants"] });
    },
    onError: (failure) => setError(failure.message),
  });
  const busy = save.isPending || avatar.isPending;
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(undefined);
    avatar.mutate(file);
  }
  return (
    <section className="agent-identity-settings account-profile" aria-label="Your profile">
      <div className="agent-avatar-editor">
        <ActorAvatar {...viewer} size="lg" />
        <Button
          variant="secondary"
          disabled={busy || !online}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus /> Upload avatar
        </Button>
        {viewer.avatarUrl ? (
          <IconButton
            label="Remove avatar"
            disabled={busy || !online}
            onClick={() => {
              setError(undefined);
              avatar.mutate(null);
            }}
          >
            <Trash2 />
          </IconButton>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          aria-label="Your avatar"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={choose}
        />
      </div>
      <form
        className="agent-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || busy || !name.trim() || name.trim() === viewer.displayName) return;
          setError(undefined);
          save.mutate(name.trim());
        }}
      >
        <label className="field">
          Display name
          <Input
            maxLength={256}
            value={name}
            disabled={busy}
            onChange={(event) => setDraftName(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          disabled={busy || !online || !name.trim() || name.trim() === viewer.displayName}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </form>
      <p className="muted">Your name and avatar appear in conversations.</p>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </section>
  );
}
