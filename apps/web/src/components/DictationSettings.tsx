import { useId } from "react";
import { useStore } from "zustand";
import type { createPreferences } from "../preferences";
import { validateDictationEndpoint } from "../dictation";
import { Input } from "./ui/input";

export function DictationSettings({
  preferences,
}: {
  preferences: ReturnType<typeof createPreferences>;
}) {
  const id = useId();
  const endpoint = useStore(preferences, (state) => state.asrEndpoint);
  const model = useStore(preferences, (state) => state.asrModel);
  const token = useStore(preferences, (state) => state.asrToken);
  const error = endpoint ? validateDictationEndpoint(endpoint) : undefined;
  const actions = preferences.getState();
  return (
    <section className="space-y-4 mb-8" aria-label="Dictation">
      <h2 className="text-lg font-semibold">Dictation</h2>
      <p className="text-sm text-muted-foreground" id={`${id}-help`}>
        Recordings go directly to this service. Text is added to your draft, never sent
        automatically. Leave the URL empty to turn dictation off.
      </p>
      <label className="grid gap-2 text-sm" htmlFor={`${id}-endpoint`}>
        Transcription URL
        <Input
          id={`${id}-endpoint`}
          type="url"
          placeholder="https://asr.example.com/v1/audio/transcriptions"
          value={endpoint}
          onChange={(event) => actions.setAsrEndpoint(event.target.value.trim())}
          aria-invalid={!!error}
          aria-describedby={`${id}-help ${id}-error`}
          autoComplete="off"
        />
      </label>
      <p id={`${id}-error`} className="text-sm text-destructive" role={error ? "alert" : undefined}>
        {error}
      </p>
      <label className="grid gap-2 text-sm" htmlFor={`${id}-model`}>
        Transcription model
        <Input
          id={`${id}-model`}
          value={model}
          placeholder="whisper-1"
          maxLength={256}
          onChange={(event) => actions.setAsrModel(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="grid gap-2 text-sm" htmlFor={`${id}-token`}>
        Service API token (optional)
        <Input
          id={`${id}-token`}
          type="password"
          value={token}
          autoComplete="off"
          onChange={(event) => actions.setAsrToken(event.target.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        URL and model are saved for your account on this device. The token stays in this tab's
        memory until reload, sign-out, or a URL change.
      </p>
    </section>
  );
}
