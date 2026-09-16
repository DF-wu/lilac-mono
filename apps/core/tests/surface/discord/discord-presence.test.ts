import { afterEach, describe, expect, jest, test } from "bun:test";
import { DiscordPresence } from "../../../src/surface/discord/discord-presence";

const TEN_MINUTES = 600_000;

afterEach(() => jest.useRealTimers());

describe("Discord presence", () => {
  test("starts online and becomes idle after ten minutes", () => {
    jest.useFakeTimers();
    const updates: string[] = [];
    const presence = new DiscordPresence(() => updates.push(presence.status));
    presence.start();
    expect(presence.status).toBe("online");
    jest.advanceTimersByTime(TEN_MINUTES - 1);
    expect(presence.status).toBe("online");
    jest.advanceTimersByTime(1);
    expect(updates).toEqual(["idle"]);
    presence.stop();
  });

  test("wakes immediately and stays online until every distinct request settles", () => {
    jest.useFakeTimers();
    const updates: string[] = [];
    const presence = new DiscordPresence(() => updates.push(presence.status));
    presence.start();
    jest.advanceTimersByTime(TEN_MINUTES);
    presence.requestStarted("first");
    expect(updates).toEqual(["idle", "online"]);
    presence.requestStarted("first");
    presence.requestStarted("second");
    jest.advanceTimersByTime(TEN_MINUTES * 2);
    presence.requestSettled("first");
    presence.requestSettled("first");
    jest.advanceTimersByTime(TEN_MINUTES * 2);
    expect(presence.status).toBe("online");
    presence.requestSettled("second");
    jest.advanceTimersByTime(TEN_MINUTES - 1);
    presence.requestSettled("second");
    presence.requestSettled("unknown");
    expect(presence.status).toBe("online");
    jest.advanceTimersByTime(1);
    expect(updates).toEqual(["idle", "online", "idle"]);
    presence.stop();
  });

  test("new work cancels the previous idle deadline and shutdown clears timers", () => {
    jest.useFakeTimers();
    const updates: string[] = [];
    const presence = new DiscordPresence(() => updates.push(presence.status));
    presence.start();
    jest.advanceTimersByTime(TEN_MINUTES - 1);
    presence.requestStarted("request");
    jest.advanceTimersByTime(TEN_MINUTES);
    expect(updates).toEqual([]);
    presence.requestSettled("request");
    jest.advanceTimersByTime(TEN_MINUTES - 1);
    expect(presence.status).toBe("online");
    presence.stop();
    jest.advanceTimersByTime(TEN_MINUTES);
    expect(updates).toEqual([]);
    presence.start();
    jest.advanceTimersByTime(TEN_MINUTES);
    expect(presence.status).toBe("idle");
    presence.start();
    expect(presence.status).toBe("online");
    presence.stop();
  });
});
