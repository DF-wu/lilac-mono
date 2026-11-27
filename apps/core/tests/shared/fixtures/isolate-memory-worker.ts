import { installIsolateMemoryResponder } from "../../../src/shared/isolate-memory";

// Holds a known amount of heap so the test can tell this worker's counters from the main isolate's.
const retained = Array.from({ length: 2_000 }, (_, index) => ({ index, text: `entry-${index}` }));

installIsolateMemoryResponder("fixture-worker");
self.addEventListener("message", () => {
  postMessage({ ready: true, retained: retained.length });
});
