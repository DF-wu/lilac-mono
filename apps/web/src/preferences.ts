import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import type { CacheScope } from "@stanley2058/lilac-client";

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
  return createStore<{
    animation: AnimationSpeed;
    setAnimation: (animation: AnimationSpeed) => void;
  }>((set) => ({
    animation,
    setAnimation(value) {
      set({ animation: value });
      Result.try({
        try: () => localStorage.setItem(key, value),
        catch: () => "Storage unavailable",
      }).match({ ok: () => {}, err: () => {} });
    },
  }));
}
