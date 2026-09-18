import { Result } from "better-result";

export type AppUpdate = { activate: () => void };
type UpdateEnvironment = {
  production: boolean;
  workers?: ServiceWorkerContainer;
  events: Pick<Window, "addEventListener" | "removeEventListener">;
  buildId: string;
  reload: () => void;
};

export async function watchAppUpdates(
  onUpdate: (update: AppUpdate) => void,
  environment: UpdateEnvironment = {
    production: import.meta.env.PROD,
    workers: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    events: window,
    buildId: document.querySelector<HTMLMetaElement>('meta[name="lilac-build"]')?.content ?? "",
    reload: () => location.reload(),
  },
): Promise<() => void> {
  if (!environment.production) return () => {};
  let disposed = false;
  let activateUpdate = environment.reload;
  const preloadError = (event: Event) => {
    event.preventDefault();
    if (!disposed) onUpdate({ activate: () => activateUpdate() });
  };
  environment.events.addEventListener("vite:preloadError", preloadError);
  const cleanupPreload = () => {
    disposed = true;
    environment.events.removeEventListener("vite:preloadError", preloadError);
  };
  const workers = environment.workers;
  if (!workers) return cleanupPreload;
  const registration = await Result.tryPromise({
    try: () => workers.register("/sw.js", { updateViaCache: "none" }),
    catch: () => new Error("App cache is unavailable"),
  });
  const worker = registration.match({ ok: (value) => value, err: () => undefined });
  if (!worker) return cleanupPreload;
  let requestedReload = false;
  let watched: ServiceWorker | null = null;
  const report = () =>
    workers.controller?.postMessage({ type: "lilac-build", id: environment.buildId });
  const activate = () => {
    if (disposed || requestedReload) return;
    if (!worker.waiting) {
      environment.reload();
      return;
    }
    requestedReload = true;
    worker.waiting.postMessage("activate-update");
  };
  activateUpdate = activate;
  const available = () => {
    if (disposed || !worker.waiting || !workers.controller) return;
    onUpdate({ activate });
  };
  const installing = () => {
    watched?.removeEventListener("statechange", available);
    watched = worker.installing;
    watched?.addEventListener("statechange", available);
  };
  const controllerChanged = () => {
    if (disposed) return;
    if (requestedReload) {
      disposed = true;
      environment.reload();
      return;
    }
    report();
  };
  const message = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return;
    if (event.data.type === "lilac-build-request") {
      report();
      return;
    }
    if (
      event.data.type !== "lilac-build-version" ||
      !("id" in event.data) ||
      typeof event.data.id !== "string" ||
      !/^[a-f0-9]{20}$/.test(event.data.id) ||
      event.data.id === environment.buildId
    )
      return;
    onUpdate({ activate });
  };
  workers.addEventListener("controllerchange", controllerChanged);
  workers.addEventListener("message", message);
  worker.addEventListener("updatefound", installing);
  installing();
  available();
  report();
  return () => {
    disposed = true;
    watched?.removeEventListener("statechange", available);
    worker.removeEventListener("updatefound", installing);
    workers.removeEventListener("controllerchange", controllerChanged);
    workers.removeEventListener("message", message);
    cleanupPreload();
  };
}
