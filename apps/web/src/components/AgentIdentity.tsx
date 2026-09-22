import { useQueryClient } from "@tanstack/react-query";
import type { AgentIdentity as AgentProfile } from "@stanley2058/lilac-client-protocol";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
  identity: ActorIdentity & Pick<AgentProfile, "discordUserId">;
}) {
  const queries = useQueryClient();
  const [discordUserId, setDiscordUserId] = useState(identity.discordUserId ?? "");
  const [name, setName] = useState(identity.displayName);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const online = useNativeOnline(client);
  async function updateIdentity(input: { displayName: string; discordUserId?: string | null }) {
    if (!client.rpc || !input.displayName.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    await attempt(async () => {
      await client.rpc!.identity.update(input);
      await queries.invalidateQueries({ queryKey: ["external", "read"] });
    }, setError);
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
        onSave={() => void updateIdentity({ displayName: name.trim() })}
        onAvatarChange={(file) => void avatar(file ?? undefined)}
      />
      <AgentDiscordLink
        value={discordUserId}
        savedValue={identity.discordUserId ?? ""}
        disabled={busy || !online}
        onChange={setDiscordUserId}
        onSave={() =>
          void updateIdentity({
            displayName: identity.displayName,
            discordUserId: discordUserId.trim() || null,
          })
        }
      />
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
    </section>
  );
}

export function AgentDiscordLink({
  value,
  savedValue,
  disabled,
  onChange,
  onSave,
}: {
  value: string;
  savedValue: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-2 max-w-112"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label htmlFor="agent-discord-id" className="text-sm">
        Discord user ID (optional)
      </label>
      <div className="flex gap-2">
        <Input
          id="agent-discord-id"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="numeric"
          pattern="[0-9]{1,20}"
          maxLength={20}
          disabled={disabled}
          aria-describedby="agent-discord-description"
        />
        <Button
          type="submit"
          disabled={disabled || value.trim() === savedValue}
          aria-label="Save Discord ID"
        >
          Save
        </Button>
      </div>
      <p id="agent-discord-description" className="text-xs text-muted-foreground">
        Messages from this Discord user appear as the agent.
      </p>
    </form>
  );
}
