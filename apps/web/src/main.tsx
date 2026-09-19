import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Result } from "better-result";
import { WebSessionController, webCache } from "./bootstrap";
import { LocalLogin } from "./auth";
import { readAuthInfo, resourceUrl, uploadResource, type AuthInfo } from "./http";
import { watchAppUpdates, type AppUpdate } from "./updates";
import { AccountLoadBoundary } from "./AccountLoadBoundary";
import App from "./App";
import "./styles.css";

const ClerkLogin = lazy(() => import("./clerk").then((module) => ({ default: module.ClerkLogin })));
const ClerkUserControl = lazy(() =>
  import("./clerk").then((module) => ({ default: module.ClerkUserControl })),
);
const sessions = new WebSessionController();
const authInfo = readAuthInfo();
const start = () => {
  void sessions.start();
};
const logout = async () => {
  const auth = await authInfo;
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
start();

function Root() {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const [auth, setAuth] = useState<AuthInfo>();
  const [authError, setAuthError] = useState("");
  const [update, setUpdate] = useState<AppUpdate>();
  useEffect(() => {
    void authInfo.then((result) =>
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
  const withUpdate = (content: ReactNode) => (
    <>
      {content}
      {update ? (
        <div className="app-update" role="status">
          <span>Update available</span>
          <button onClick={update.activate}>Reload</button>
        </div>
      ) : null}
    </>
  );
  const reload = update?.activate ?? (() => location.reload());
  if (state.kind === "starting")
    return withUpdate(
      <div className="login-shell">
        <span className="brand">Lilac</span>
      </div>,
    );
  if (state.kind === "offline")
    return withUpdate(
      <main className="login-shell">
        <h1>Lilac</h1>
        <p role="status">{state.message}</p>
        <button onClick={start}>Reconnect</button>
      </main>,
    );
  if (state.kind === "login")
    return withUpdate(
      <main className="login-shell">
        <h1>Lilac</h1>
        {state.message ? <p role="status">{state.message}</p> : null}
        {authError ? <p role="alert">{authError}</p> : null}
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
      </main>,
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
  return withUpdate(
    <App
      {...session}
      draftCache={webCache}
      upload={uploadResource}
      resourceUrl={resourceUrl}
      onLogout={logout}
      userControl={userControl}
    />,
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Root />);
