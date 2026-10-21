import { Result } from "better-result";

export async function currentPushDeviceId(): Promise<string | undefined> {
  const captured = await Result.tryPromise({
    try: async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      if (!subscription) return undefined;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(subscription.endpoint),
      );
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: () => undefined,
  });
  return captured.match({ ok: (value) => value, err: () => undefined });
}
