import { describe, expect, test } from "bun:test";
import { MessageArrivals } from "../src/message-arrivals";

describe("message arrivals", () => {
  test("history and already loaded offscreen messages do not fade", () => {
    const arrivals = new MessageArrivals();
    expect(arrivals.claim("visible-history", true)).toBe(false);
    arrivals.activate(["visible-history", "offscreen-history"]);
    expect(arrivals.claim("visible-history", true)).toBe(false);
    expect(arrivals.claim("offscreen-history", true)).toBe(false);
  });

  test("new live messages fade once, including across token updates and remounts", () => {
    const arrivals = new MessageArrivals();
    arrivals.activate([]);
    expect(arrivals.claim("stream", true)).toBe(true);
    expect(arrivals.claim("stream", true)).toBe(false);
    expect(arrivals.claim("stream", false)).toBe(false);
    expect(arrivals.claim("stream", true)).toBe(false);
    expect(arrivals.claim("next", true)).toBe(true);
  });

  test("settled messages and background panel updates do not fade on reveal", () => {
    const arrivals = new MessageArrivals();
    arrivals.activate([]);
    expect(arrivals.claim("settled", false)).toBe(false);
    arrivals.deactivate();
    expect(arrivals.claim("background", true)).toBe(false);
    arrivals.activate(["background", "newly-loaded"]);
    expect(arrivals.claim("background", true)).toBe(false);
    expect(arrivals.claim("newly-loaded", true)).toBe(false);
    expect(arrivals.claim("foreground", true)).toBe(true);
  });
});
