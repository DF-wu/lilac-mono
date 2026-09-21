import { useState } from "react";
import type { NativeClient } from "@stanley2058/lilac-client";
import { Result } from "better-result";
import type { ActorIdentity } from "./ActorAvatar";
import { attempt, ErrorNotice } from "./ui";
import { ProfileEditor } from "./ProfileEditor";
import { useNativeOnline } from "../queries";

export function AgentIdentity({
  client,
  identity,
}: {
  client: NativeClient;
  identity: ActorIdentity;
}) {
  const [name, setName] = useState(identity.displayName);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const online = useNativeOnline(client);
  async function save() {
    if (!client.rpc || !name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    await attempt(() => client.rpc!.identity.update({ displayName: name.trim() }), setError);
    setBusy(false);
  }
  async function avatar(file?: File) {
    if (busy) return;
    if (
      file &&
      (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) ||
        file.size > 2 * 1024 * 1024)
    ) {
      setError("Choose a PNG, JPEG, WebP or GIF up to 2 MB.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await Result.tryPromise({
      try: () =>
        fetch("/api/identity/avatar", {
          method: file ? "PUT" : "DELETE",
          credentials: "same-origin",
          headers: file ? { "content-type": file.type } : undefined,
          body: file,
        }),
      catch: () => "Could not update avatar. Check your connection and try again.",
    });
    result.match({
      ok: (response) => {
        if (!response.ok)
          setError("Could not update avatar. Check the file and your owner access.");
      },
      err: setError,
    });
    setBusy(false);
  }
  return (
    <section aria-label="Agent identity">
      <ProfileEditor
        identity={identity}
        name={name}
        onNameChange={setName}
        disabled={busy || !online}
        onSave={() => void save()}
        onAvatarChange={(file) => void avatar(file ?? undefined)}
      />
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </section>
  );
}
