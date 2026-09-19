import { Button } from "./components/ui/button";
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Result } from "better-result";
import { WebSessionController, webCache } from "./bootstrap";
import { LocalLogin } from "./auth";
import { readAuthInfo, resourceUrl, uploadResource, type AuthInfo } from "./http";
import { watchAppUpdates, type AppUpdate } from "./updates";
import { AccountLoadBoundary } from "./AccountLoadBoundary";
import App from "./App";
import "./styles.css";
import { Toaster, toast } from "./components/ui/toast";
const DesignSystem = lazy(() => import("./DesignSystem"));
const designSystemPage = location.pathname === "/design-system";

const ClerkLogin = lazy(() => import("./clerk").then((module) => ({ default: module.ClerkLogin })));
const ClerkUserControl = lazy(() =>
  import("./clerk").then((module) => ({ default: module.ClerkUserControl })),
);
const sessions = new WebSessionController();
const authInfo = designSystemPage ? undefined : readAuthInfo();
const start = () => {
  void sessions.start();
};
const logout = async () => {
  const auth = await authInfo;
  if (!auth) return;
  const provider = auth.match({ ok: (value) => value.provider, err: () => "local" });
  if (provider !== "clerk") {
    await sessions.logout();
    return;
  }
  const loadedProvider = await Result.tryPromise({
    try: async () => (await import("./clerk")).signOutActiveClerk,
    catch: () =>
      new Error("Could not load account controls. Reload to finish signing out of Clerk."),
  });
  await loadedProvider.match({
    ok: (signOut) => sessions.logout(signOut),
    err: (error) => sessions.logout(async () => Result.err(error)),
  });
};
if (!designSystemPage) start();

function Root() {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const [auth, setAuth] = useState<AuthInfo>();
  const [authError, setAuthError] = useState("");
  const [update, setUpdate] = useState<AppUpdate>();
  useEffect(() => {
    void authInfo?.then((result) =>
      result.match({ ok: setAuth, err: (error) => setAuthError(error.message) }),
    );
    let stop: (() => void) | undefined;
    let disposed = false;
    void watchAppUpdates(setUpdate).then((cleanup) => {
      if (disposed) {
        cleanup?.();
        return;
      }
      stop = cleanup;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!update) return;
    toast.add({
      id: "app-update",
      title: "Update available",
      timeout: 0,
      actionProps: { children: "Reload", onClick: update.activate },
    });
    return () => toast.close("app-update");
  }, [update]);
  const stateMessage =
    state.kind === "offline" || state.kind === "login" ? state.message : undefined;
  useEffect(() => {
    const message = stateMessage === "Sign in to continue" ? authError : stateMessage || authError;
    if (!message) {
      toast.close("session-status");
      return;
    }
    toast.add({ id: "session-status", title: message, type: "error", timeout: 0 });
    return () => toast.close("session-status");
  }, [stateMessage, authError]);
  const reload = update?.activate ?? (() => location.reload());
  if (state.kind === "starting")
    return (
      <div className="login-shell">
        <span className="brand">Lilac</span>
      </div>
    );
  if (state.kind === "offline")
    return (
      <main className="login-shell">
        <h1>Lilac</h1>
        <Button onClick={start}>Reconnect</Button>
      </main>
    );
  if (state.kind === "login")
    return (
      <main className="login-shell">
        <h1>Lilac</h1>
        {state.signingOut ? <p role="status">Signing out…</p> : null}
        {auth?.provider === "local" ? (
          <fieldset disabled={state.signingOut}>
            <LocalLogin onSignedIn={start} />
          </fieldset>
        ) : null}
        {!state.signingOut && auth?.provider === "clerk" && auth.publishableKey ? (
          <AccountLoadBoundary onReload={reload} message="Unable to load sign-in.">
            <Suspense fallback={<p>Loading sign-in…</p>}>
              <ClerkLogin publishableKey={auth.publishableKey} onSignedIn={start} />
            </Suspense>
          </AccountLoadBoundary>
        ) : null}
      </main>
    );
  const { session } = state;
  const userControl =
    auth?.provider === "clerk" && auth.publishableKey ? (
      <AccountLoadBoundary onReload={reload} message="Unable to load account controls.">
        <Suspense fallback={null}>
          <ClerkUserControl
            publishableKey={auth.publishableKey}
            client={session.client}
            onLogout={logout}
          />
        </Suspense>
      </AccountLoadBoundary>
    ) : undefined;
  return (
    <App
      {...session}
      draftCache={webCache}
      upload={uploadResource}
      resourceUrl={resourceUrl}
      onLogout={logout}
      userControl={userControl}
    />
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <Toaster>
      {designSystemPage ? (
        <Suspense fallback={null}>
          <DesignSystem />
        </Suspense>
      ) : (
        <Root />
      )}
    </Toaster>,
  );
