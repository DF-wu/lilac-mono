import { useImperativeHandle, useLayoutEffect, useState, type Ref } from "react";
import { useStore } from "zustand";
import { Mic, Square, X } from "lucide-react";
import {
  createDictation,
  dictationSupport,
  validateDictationEndpoint,
  type DictationState,
} from "../dictation";
import type { createPreferences } from "../preferences";
import { IconButton } from "./ui";
import { toast } from "./ui/toast";
import { useEventCallback } from "../use-event-callback";

const statusText: Record<DictationState, string> = {
  idle: "",
  requesting: "Allow microphone…",
  recording: "Recording…",
  transcribing: "Transcribing…",
};

export function DictationButton({
  ref,
  preferences,
  documentKey,
  disabled,
  replacement,
  onText,
}: {
  ref?: Ref<{ cancel: () => void }>;
  preferences: ReturnType<typeof createPreferences>;
  documentKey?: string;
  disabled: boolean;
  replacement?: object;
  onText: (text: string) => void;
}) {
  const endpoint = useStore(preferences, (state) => state.asrEndpoint);
  const model = useStore(preferences, (state) => state.asrModel);
  const token = useStore(preferences, (state) => state.asrToken);
  const [state, setState] = useState<DictationState>("idle");
  const receive = useEventCallback(onText);
  const [dictation] = useState(() =>
    createDictation({
      state: setState,
      text: receive,
      error: (title) => toast.add({ title, type: "error" }),
    }),
  );
  useImperativeHandle(ref, () => ({ cancel: dictation.cancel }), [dictation]);
  useLayoutEffect(
    () => () => dictation.cancel(),
    [dictation, preferences, documentKey, disabled, replacement, endpoint, model, token],
  );
  useLayoutEffect(() => {
    const cancel = () => dictation.cancel();
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [dictation]);
  if (!endpoint) return null;
  const unavailable = validateDictationEndpoint(endpoint, token) ?? dictationSupport();
  const recording = state === "recording";
  const busy = state !== "idle";
  const label = recording ? "Stop dictation" : "Start dictation";
  return (
    <>
      <IconButton
        label={label}
        tooltip={unavailable ?? label}
        className="rounded-full"
        disabled={disabled || !!unavailable || (busy && !recording)}
        aria-pressed={recording}
        onClick={() =>
          recording ? dictation.stop() : void dictation.start({ endpoint, model, token })
        }
      >
        {recording ? <Square className="text-destructive" /> : <Mic />}
      </IconButton>
      {busy ? (
        <>
          <span role="status" className="truncate text-xs text-muted-foreground">
            {statusText[state]}
          </span>
          <IconButton
            label="Cancel dictation"
            className="rounded-full"
            onClick={() => dictation.cancel()}
          >
            <X />
          </IconButton>
        </>
      ) : null}
    </>
  );
}
