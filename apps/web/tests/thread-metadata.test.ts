import { expect, it } from "bun:test";
import { relativeThreadTime } from "../src/thread-metadata";

it("keeps relative thread activity compact across clock skew and unit boundaries", () => {
  const now = new Date(2026, 8, 19, 12).getTime();
  expect(relativeThreadTime(now + 30_000, now)).toBe("Now");
  expect(relativeThreadTime(now - 59_999, now)).toBe("Now");
  expect(relativeThreadTime(now - 60_000, now)).toBe("1m");
  expect(relativeThreadTime(now - 3_600_000, now)).toBe("1h");
  expect(relativeThreadTime(now - 86_400_000, now)).toBe("1d");
  const old = new Date(2025, 8, 10, 12).getTime();
  expect(relativeThreadTime(old, now)).toBe(
    new Date(old).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  );
});
