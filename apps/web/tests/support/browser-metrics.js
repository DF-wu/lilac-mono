(() => {
  const metrics = { frames: [], sockets: [], requests: [], longTasks: [], layoutShifts: [] };
  window.__nativeMetrics = metrics;
  window.__nativeSockets = [];
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries())
      metrics.longTasks.push({ at: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries())
      if (!entry.hadRecentInput) metrics.layoutShifts.push(entry.value);
  }).observe({ type: "layout-shift", buffered: true });
  const OriginalSocket = window.WebSocket;
  function measure(value, outgoing) {
    const size =
      typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
    const extended = size < 126 ? 0 : size < 65536 ? 2 : 8;
    metrics.frames.push({
      at: performance.now(),
      outgoing,
      bytes: size + 2 + extended + (outgoing ? 4 : 0),
    });
  }
  window.WebSocket = class MeasuredSocket extends OriginalSocket {
    constructor(...args) {
      super(...args);
      metrics.sockets.push({ at: performance.now(), path: new URL(String(args[0])).pathname });
      window.__nativeSockets.push(this);
      this.addEventListener("message", (event) => measure(event.data, false));
    }
    send(value) {
      measure(value, true);
      return super.send(value);
    }
  };
  const originalFetch = window.fetch;
  window.fetch = (...args) => {
    const input = args[0];
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input, location.href)
        : new URL(input.url);
    metrics.requests.push({ at: performance.now(), path: url.pathname });
    return originalFetch(...args);
  };
})();
