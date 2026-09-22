import { expect, test } from "bun:test";
import { OptimisticTurns, type OptimisticTurn } from "../src/optimistic-turns";

function pending(): OptimisticTurn {
  return {
    slot: {
      kind: "ready",
      slotId: "sending:command",
      turnId: "sending:command",
      position: 1,
      state: "pending",
      messages: [],
    },
    precedingSlotIds: ["previous"],
  };
}

test("replay before the receipt keeps the optimistic row instead of mounting a duplicate", () => {
  const identities = new OptimisticTurns();
  const optimistic = pending();
  expect(identities.reconcile(["previous"], optimistic)).toEqual(["previous", "sending:command"]);
  expect(identities.reconcile(["previous", "server"], optimistic)).toEqual([
    "previous",
    "sending:command",
  ]);
  expect(
    identities.reconcile(["previous", "server"], { ...optimistic, confirmedSlotId: "server" }),
  ).toEqual(["previous", "server"]);
  expect(identities.key("server")).toBe("sending:command");
  expect(identities.reconcile(["previous", "server"])).toEqual(["previous", "server"]);
  expect(identities.key("server")).toBe("sending:command");
});

test("receipt before replay preserves the fallback row and its key until the server turn arrives", () => {
  const identities = new OptimisticTurns();
  const optimistic = { ...pending(), confirmedSlotId: "server" };
  expect(identities.reconcile(["previous"], optimistic)).toEqual(["previous", "server"]);
  expect(identities.key("server")).toBe("sending:command");
  expect(identities.reconcile(["previous", "server"], optimistic)).toEqual(["previous", "server"]);
  expect(identities.key("server")).toBe("sending:command");
});

test("a failed send releases deferred server rows and later sends retain independent keys", () => {
  const identities = new OptimisticTurns();
  identities.reconcile(["previous", "server"], pending());
  expect(identities.reconcile(["previous", "server"])).toEqual(["previous", "server"]);
  identities.reconcile(["previous", "server"], { ...pending(), confirmedSlotId: "server" });
  const second = pending();
  second.slot = { ...second.slot, slotId: "sending:second" };
  second.precedingSlotIds = ["previous", "server"];
  expect(identities.reconcile(["previous", "server"], second)).toEqual([
    "previous",
    "server",
    "sending:second",
  ]);
  expect(identities.key("server")).toBe("sending:command");
});

test("history hydration retains replacement rows while replay waits for the receipt", () => {
  const identities = new OptimisticTurns();
  const optimistic = { ...pending(), precedingSlotIds: ["deferred-history", "previous"] };
  expect(identities.reconcile(["deferred-history", "previous"], optimistic)).toEqual([
    "deferred-history",
    "previous",
    "sending:command",
  ]);
  expect(identities.reconcile(["older-a", "older-b", "previous", "server"], optimistic)).toEqual([
    "older-a",
    "older-b",
    "previous",
    "sending:command",
  ]);
});
