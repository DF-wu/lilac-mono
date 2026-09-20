import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import type { NativeUser } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { ErrorNotice } from "./ui";
import { ProfileEditor } from "./ProfileEditor";

export function AccountProfile({ viewer }: { viewer: NativeUser }) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const [draftName, setDraftName] = useState<string>();
  const [error, setError] = useState<string>();
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
  return (
    <section aria-label="Your profile">
      <ProfileEditor
        identity={viewer}
        name={name}
        onNameChange={setDraftName}
        disabled={busy || !online}
        saving={save.isPending}
        onSave={() => {
          setError(undefined);
          save.mutate(name.trim());
        }}
        onAvatarChange={(file) => {
          setError(undefined);
          avatar.mutate(file);
        }}
      />
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </section>
  );
}
