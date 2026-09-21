import { Button } from "./components/ui/button";
import { ClerkProvider, SignIn, UserProfile, useAuth, useClerk, useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { clerkAppearance, clerkProfileAppearance } from "./theme/clerk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NativeClient } from "@stanley2058/lilac-client";
import { Result } from "better-result";

export { signOutActiveClerk } from "./clerk-signout";
import { registerClerkSignOut } from "./clerk-signout";

function RegisterClerk({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  useEffect(() => registerClerkSignOut(() => clerk.signOut()), [clerk]);
  return children;
}

function Provider({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance}>
      <RegisterClerk>{children}</RegisterClerk>
    </ClerkProvider>
  );
}

function SignInView({ onSignedIn }: { onSignedIn: () => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const previous = useRef<boolean | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    const completedSignIn = previous.current === false && isSignedIn;
    previous.current = isSignedIn;
    if (completedSignIn) onSignedIn();
  }, [isLoaded, isSignedIn, onSignedIn]);
  async function switchAccount() {
    setBusy(true);
    setError("");
    const result = await Result.tryPromise({
      try: () => clerk.signOut(),
      catch: () => new Error("Could not sign out. Try again."),
    });
    setBusy(false);
    result.match({ ok: () => {}, err: (failure) => setError(failure.message) });
  }
  if (!isLoaded) return null;
  if (isSignedIn)
    return (
      <div className="login-form grid gap-4">
        <Button type="button" onClick={onSignedIn}>
          Retry connection
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            void switchAccount();
          }}
        >
          Use another account
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  return (
    <SignIn
      routing="hash"
      withSignUp={false}
      transferable={false}
      forceRedirectUrl={location.pathname + location.search}
    />
  );
}

export function ClerkLogin({
  publishableKey,
  onSignedIn,
}: {
  publishableKey: string;
  onSignedIn: () => void;
}) {
  return (
    <Provider publishableKey={publishableKey}>
      <SignInView onSignedIn={onSignedIn} />
    </Provider>
  );
}

function SessionStatus({
  client,
  onLogout,
}: {
  client: NativeClient;
  onLogout: () => Promise<void>;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isLoaded) return;
    const controller = new AbortController();
    let refreshing = false;
    async function endSession() {
      const result = await Result.tryPromise({
        try: onLogout,
        catch: () => new Error("Could not clear the session. Reload to retry."),
      });
      if (controller.signal.aborted) return;
      result.match({ ok: () => {}, err: (failure) => setError(failure.message) });
    }
    if (!isSignedIn) {
      void endSession();
      return () => controller.abort();
    }
    async function refresh() {
      if (refreshing || controller.signal.aborted) return;
      refreshing = true;
      const refreshed = await Result.tryPromise({
        try: async () => {
          const token = await getToken({ skipCache: true });
          if (controller.signal.aborted) return "canceled" as const;
          if (!token) return "signed-out" as const;
          if (!client.rpc) return "pending" as const;
          const accepted = await client.reauthenticate(token);
          return accepted ? ("accepted" as const) : ("retry" as const);
        },
        catch: () => new Error("Session refresh failed. Reconnecting will retry."),
      });
      refreshing = false;
      if (controller.signal.aborted) return;
      const outcome = refreshed.match({ ok: (value) => value, err: () => "retry" as const });
      if (outcome === "signed-out") {
        await endSession();
        return;
      }
      setError(outcome === "retry" ? "Session refresh failed. Reconnecting will retry." : "");
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 40_000);
    const retry = () => {
      void refresh();
    };
    const stop = client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") retry();
    });
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    return () => {
      controller.abort();
      clearInterval(timer);
      stop();
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
    };
  }, [client, getToken, isLoaded, isSignedIn, onLogout]);
  return error ? <span role="status">{error}</span> : null;
}

export function ClerkSession({
  publishableKey,
  client,
  onLogout,
}: {
  publishableKey: string;
  client: NativeClient;
  onLogout: () => Promise<void>;
}) {
  return (
    <Provider publishableKey={publishableKey}>
      <SessionStatus client={client} onLogout={onLogout} />
    </Provider>
  );
}

function AccountView() {
  const { user } = useUser();
  const queries = useQueryClient();
  const updatedAt = user?.updatedAt?.getTime();
  useEffect(() => {
    if (!updatedAt) return;
    async function refreshProfile() {
      await queries.invalidateQueries({ queryKey: ["profile"] });
      await queries.invalidateQueries({ queryKey: ["participants"] });
    }
    void refreshProfile();
  }, [queries, updatedAt]);
  return (
    <UserProfile
      routing="hash"
      appearance={clerkProfileAppearance}
      fallback={<p role="status">Loading account…</p>}
    />
  );
}

export function ClerkAccount({ publishableKey }: { publishableKey: string }) {
  return (
    <Provider publishableKey={publishableKey}>
      <AccountView />
    </Provider>
  );
}
