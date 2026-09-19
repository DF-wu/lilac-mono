import { useRef, useState, type ChangeEvent } from "react";
import type { NativeClient } from "@stanley2058/lilac-client";
import { ImagePlus, Trash2 } from "lucide-react";
import { Result } from "better-result";
import { ActorAvatar, type ActorIdentity } from "./ActorAvatar";
import { attempt, ErrorNotice, IconButton } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
  const fileInput = useRef<HTMLInputElement>(null);
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
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void avatar(file);
  }
  return (
    <section className="agent-identity-settings" aria-label="Agent identity">
      <h2>Agent identity</h2>
      <div className="agent-avatar-editor">
        <ActorAvatar {...identity} size="lg" />
        <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
          <ImagePlus />
          Upload avatar
        </Button>
        {identity.avatarUrl ? (
          <IconButton label="Remove agent avatar" disabled={busy} onClick={() => void avatar()}>
            <Trash2 />
          </IconButton>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          aria-label="Agent avatar"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={choose}
        />
      </div>
      <form
        className="agent-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          Display name
          <Input maxLength={256} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <Button
          type="submit"
          disabled={busy || !name.trim() || name.trim() === identity.displayName}
        >
          Save
        </Button>
      </form>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </section>
  );
}
