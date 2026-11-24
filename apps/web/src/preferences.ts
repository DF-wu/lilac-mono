import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import type { CacheScope } from "@stanley2058/lilac-client";
import { validateDictationEndpoint } from "./dictation";

export type AnimationSpeed = "off" | "fast" | "slow";
export function createPreferences(scope: Pick<CacheScope, "installationId" | "principalId">) {
  const key = `lilac-animation-v1:${JSON.stringify([scope.installationId, scope.principalId])}`;
  const animation = Result.try({
    try: () => localStorage.getItem(key),
    catch: () => "Storage unavailable",
  }).match({
    ok: (value): AnimationSpeed => (value === "off" || value === "slow" ? value : "fast"),
    err: (): AnimationSpeed => "fast",
  });
  const asrKey = `lilac-dictation-v1:${JSON.stringify([scope.installationId, scope.principalId])}`;
  const read = (suffix: string, fallback: string) =>
    Result.try({
      try: () => localStorage.getItem(`${asrKey}:${suffix}`),
      catch: () => "Storage unavailable",
    }).match({ ok: (value) => value ?? fallback, err: () => fallback });
  const save = (suffix: string, value: string) =>
    Result.try({
      try: () => localStorage.setItem(`${asrKey}:${suffix}`, value),
      catch: () => "Storage unavailable",
    }).match({ ok: () => {}, err: () => {} });
  return createStore<{
    animation: AnimationSpeed;
    setAnimation: (animation: AnimationSpeed) => void;
    asrEndpoint: string;
    asrModel: string;
    asrToken: string;
    setAsrEndpoint: (value: string) => void;
    setAsrModel: (value: string) => void;
    setAsrToken: (value: string) => void;
  }>((set) => ({
    animation,
    asrEndpoint: read("endpoint", ""),
    asrModel: read("model", "whisper-1"),
    asrToken: "",
    setAsrEndpoint(value) {
      set({ asrEndpoint: value, asrToken: "" });
      save("endpoint", value && !validateDictationEndpoint(value) ? value : "");
    },
    setAsrModel(value) {
      set({ asrModel: value });
      save("model", value);
    },
    setAsrToken(value) {
      set({ asrToken: value });
    },
    setAnimation(value) {
      set({ animation: value });
      Result.try({
        try: () => localStorage.setItem(key, value),
        catch: () => "Storage unavailable",
      }).match({ ok: () => {}, err: () => {} });
    },
  }));
}
