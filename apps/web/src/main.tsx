import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { WebSessionController, webCache } from "./bootstrap";
import { LocalLogin } from "./auth";
import { readAuthInfo, resourceUrl, uploadResource, type AuthInfo } from "./http";
import { watchAppUpdates, type AppUpdate } from "./updates";
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
  const clerk = await import("./clerk");
  await sessions.logout(clerk.signOutActiveClerk);
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
        <p role="status">{state.message}</p>
        <button onClick={start}>Reconnect</button>
      </main>
    );
  if (state.kind === "login")
    return (
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
          <Suspense fallback={<p>Loading sign-in…</p>}>
            <ClerkLogin publishableKey={auth.publishableKey} onSignedIn={start} />
          </Suspense>
        ) : null}
      </main>
    );
  const { session } = state;
  const userControl =
    auth?.provider === "clerk" && auth.publishableKey ? (
      <Suspense fallback={null}>
        <ClerkUserControl
          publishableKey={auth.publishableKey}
          client={session.client}
          onLogout={logout}
        />
      </Suspense>
    ) : undefined;
  return (
    <>
      <App
        {...session}
        draftCache={webCache}
        upload={uploadResource}
        resourceUrl={resourceUrl}
        onLogout={logout}
        userControl={userControl}
      />
      {update ? (
        <div className="app-update" role="status">
          <span>Update available</span>
          <button onClick={update.activate}>Reload</button>
        </div>
      ) : null}
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Root />);
