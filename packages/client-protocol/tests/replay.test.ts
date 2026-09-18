import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  MAX_REPLAY_BATCH_BYTES,
  MAX_REPLAY_SLOTS,
  MAX_REPLAY_TEXT_LENGTH,
  hydrationSchema,
  liveUpdateSchema,
  replayCheckpointSchema,
  replayReplySchema,
  turnSlotSchema,
  type Hydration,
  type ReadyTurnSlot,
  type ReplayCheckpoint,
  type TurnSlot,
} from "../src/replay";
import { applyHydration, applyLiveUpdate, applyReplayReply } from "./support/replay-reducer";

function checkpoint(revision = 1, generation = 0): ReplayCheckpoint {
  return {
    protocolVersion: 1,
    historyGeneration: generation,
    projectionRevision: revision,
    cursor: `c${generation}_${revision}`,
  };
}

function ready(position: number, text = `turn ${position}`): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `slot-${position}`,
    position,
    turnId: `turn-${position}`,
    messages: [{ id: `message-${position}`, role: "assistant", parts: [{ type: "text", text }] }],
  };
}

function deferred(position: number, endPosition = position + 1): TurnSlot {
  return { kind: "deferred", slotId: `slot-${position}`, position, endPosition };
}

function state(slots: TurnSlot[] = [deferred(0, 2), ready(2)]) {
  const result = applyReplayReply(undefined, { kind: "window", checkpoint: checkpoint(), slots });
  if (!result) throw new Error("Invalid test window");
  return result;
}

function hydrate(slotId: string, slots: TurnSlot[], revision = 1, generation = 0): Hydration {
  return { slotId, slots, projectionRevision: revision, historyGeneration: generation };
}

describe("native replay contracts", () => {
  test("rejects unsupported versions, unsafe revisions and duplicated envelope metadata", () => {
    expect(replayCheckpointSchema.safeParse({ ...checkpoint(), protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(
      replayCheckpointSchema.safeParse({
        ...checkpoint(),
        projectionRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      replayReplySchema.safeParse({ kind: "unchanged", checkpoint: checkpoint(), messages: [] })
        .success,
    ).toBe(false);
    expect(turnSlotSchema.safeParse({ ...ready(0), historyGeneration: 0 }).success).toBe(false);
    expect(replayCheckpointSchema.safeParse({ ...checkpoint(), cursor: "界" }).success).toBe(false);
    expect(turnSlotSchema.safeParse({ ...ready(0), turnId: 'escape"' }).success).toBe(false);
    expect(turnSlotSchema.safeParse({ ...deferred(0), endPosition: 0 }).success).toBe(false);
    expect(hydrationSchema.safeParse(hydrate("slot-0", [])).success).toBe(false);
    expect(
      liveUpdateSchema.safeParse({
        checkpoint: checkpoint(),
        changes: [
          {
            kind: "append-text",
            turnId: "t",
            position: 0,
            messageId: "m",
            partIndex: -1,
            text: "x",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("bounds slot counts, individual text and total encoded payload", () => {
    expect(turnSlotSchema.safeParse(ready(0, "x".repeat(MAX_REPLAY_TEXT_LENGTH + 1))).success).toBe(
      false,
    );
    expect(
      replayReplySchema.safeParse({
        kind: "window",
        checkpoint: checkpoint(),
        slots: Array.from({ length: MAX_REPLAY_SLOTS + 1 }, (_, index) => deferred(index)),
      }).success,
    ).toBe(false);
    const slots = Array.from({ length: 4 }, (_, index) =>
      ready(index, "界".repeat(MAX_REPLAY_TEXT_LENGTH / 2)),
    );
    expect(new TextEncoder().encode(JSON.stringify(slots)).byteLength).toBeGreaterThan(
      MAX_REPLAY_BATCH_BYTES,
    );
    expect(
      replayReplySchema.safeParse({ kind: "window", checkpoint: checkpoint(), slots }).success,
    ).toBe(false);
    expect(hydrationSchema.safeParse(hydrate("slot-0", slots)).success).toBe(false);
  });

  test("display messages remain assignable to AI SDK UIMessage", () => {
    const messages: UIMessage[] = ready(0).messages;
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "turn 0" }]);
  });

  test("unchanged replies only renew the cursor and keep unresolved coverage", () => {
    const cached = state();
    const renewed = { ...checkpoint(), cursor: "fresh-cursor-after-log-expiry" };
    const result = applyReplayReply(cached, { kind: "unchanged", checkpoint: renewed });
    expect(result?.slots).toBe(cached.slots);
    expect(result?.checkpoint.cursor).toBe(renewed.cursor);
    expect(applyReplayReply(cached, { kind: "unchanged", checkpoint: checkpoint(2) })).toBe(cached);
    expect(
      applyReplayReply(undefined, { kind: "unchanged", checkpoint: checkpoint() }),
    ).toBeUndefined();
  });

  test("a range hydrates incrementally and duplicate hydration cannot replace ready content", () => {
    const initial = state();
    const partial = hydrate("slot-0", [ready(0), deferred(1)]);
    const next = applyHydration(initial, partial);
    expect(next.slots.map(({ slot }) => slot.kind)).toEqual(["ready", "deferred", "ready"]);
    expect(next.checkpoint).toBe(initial.checkpoint);
    expect(applyHydration(next, partial)).toBe(next);
    const final = applyHydration(next, hydrate("slot-1", [ready(1)]));
    expect(final.slots.map(({ slot }) => slot.kind)).toEqual(["ready", "ready", "ready"]);
  });

  test("independent slots hydrate out of order around current live content", () => {
    const initial = state([deferred(0), deferred(1), ready(2)]);
    const newestFirst = applyHydration(initial, hydrate("slot-1", [ready(1)]));
    const advanced = applyLiveUpdate(newestFirst, {
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "message-2",
          partIndex: 0,
          text: " live",
        },
      ],
    });
    const final = applyHydration(advanced, hydrate("slot-0", [ready(0)]));
    expect(final.slots.map(({ slot }) => slot.position)).toEqual([0, 1, 2]);
    expect(final.slots[2]?.slot).toEqual(ready(2, "turn 2 live"));
    expect(final.checkpoint.projectionRevision).toBe(2);
  });

  test("late hydration cannot overwrite a changed unresolved turn", () => {
    const initial = state([deferred(0), ready(1)]);
    const updated = applyLiveUpdate(initial, {
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn-0",
          position: 0,
          messageId: "message-0",
          partIndex: 0,
          text: " new",
        },
      ],
    });
    expect(updated.slots[0]?.slot.kind).toBe("deferred");
    expect(applyHydration(updated, hydrate("slot-0", [ready(0)]))).toBe(updated);
    expect(
      applyHydration(updated, hydrate("slot-0", [ready(0, "turn 0 new")], 2)).slots[0]?.slot,
    ).toEqual(ready(0, "turn 0 new"));
  });

  test("a live turn inside a deferred range only invalidates that range", () => {
    const initial = state([deferred(0), deferred(1, 4), ready(4)]);
    const updated = applyLiveUpdate(initial, {
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "message-2",
          partIndex: 0,
          text: " new",
        },
      ],
    });
    expect(applyHydration(updated, hydrate("slot-1", [ready(1), ready(2), ready(3)]))).toBe(
      updated,
    );
    const unrelated = applyHydration(updated, hydrate("slot-0", [ready(0)]));
    expect(unrelated.slots[0]?.slot.kind).toBe("ready");
    const current = applyHydration(
      unrelated,
      hydrate("slot-1", [ready(1), ready(2, "turn 2 new"), ready(3)], 2),
    );
    expect(current.slots.map(({ slot }) => slot.kind)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
  });

  test("rewind fences old hydration, live updates and old snapshots", () => {
    const initial = state();
    const rewound = applyReplayReply(initial, {
      kind: "window",
      checkpoint: checkpoint(0, 1),
      slots: [ready(0)],
    });
    if (!rewound) throw new Error("Expected rewind window");
    expect(applyHydration(rewound, hydrate("slot-0", [ready(0), ready(1)]))).toBe(rewound);
    expect(
      applyLiveUpdate(rewound, {
        checkpoint: checkpoint(2),
        changes: [{ kind: "insert", slot: ready(3) }],
      }),
    ).toBe(rewound);
    expect(
      applyReplayReply(rewound, {
        kind: "window",
        checkpoint: checkpoint(3),
        slots: [ready(0), ready(1)],
      }),
    ).toBe(rewound);
  });

  test("observing a new generation fences delayed old-generation windows during resync", () => {
    const initial = state();
    const waiting = applyLiveUpdate(initial, { checkpoint: checkpoint(0, 1), changes: [] });
    expect(waiting.resyncRequired).toBe(true);
    const stale = applyReplayReply(waiting, {
      kind: "window",
      checkpoint: checkpoint(2, 0),
      slots: [ready(0), ready(1), ready(2)],
    });
    expect(stale).toBe(waiting);
    const observedLater = applyLiveUpdate(waiting, { checkpoint: checkpoint(3, 1), changes: [] });
    expect(
      applyReplayReply(observedLater, {
        kind: "window",
        checkpoint: checkpoint(2, 1),
        slots: [ready(0)],
      }),
    ).toBe(observedLater);
    const recovered = applyReplayReply(observedLater, {
      kind: "window",
      checkpoint: checkpoint(3, 1),
      slots: [ready(0)],
    });
    expect(recovered?.resyncRequired).toBe(false);
    expect(recovered?.checkpoint.historyGeneration).toBe(1);
  });

  test("removal fences late hydration and duplicate live updates are idempotent", () => {
    const initial = state([deferred(0), ready(1)]);
    const update = liveUpdateSchema.parse({
      checkpoint: checkpoint(2),
      changes: [{ kind: "remove", turnId: "turn-0", position: 0 }],
    });
    const removed = applyLiveUpdate(initial, update);
    expect(removed.slots.length).toBe(1);
    expect(applyHydration(removed, hydrate("slot-0", [ready(0)]))).toBe(removed);
    expect(applyLiveUpdate(removed, update)).toBe(removed);
    expect(applyLiveUpdate(initial, { ...update, checkpoint: checkpoint(3) }).resyncRequired).toBe(
      true,
    );
  });

  test("unsupported live changes require resync without advancing checkpoint", () => {
    const initial = state();
    const cases = [
      [
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "missing",
          partIndex: 0,
          text: "x",
        },
      ],
      [
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "message-2",
          partIndex: 1,
          text: "x",
        },
      ],
      [{ kind: "insert", slot: ready(1) }],
      [{ kind: "remove", turnId: "turn-1", position: 1 }],
      [
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "message-2",
          partIndex: 0,
          text: "valid first",
        },
        {
          kind: "append-text",
          turnId: "turn-2",
          position: 2,
          messageId: "missing",
          partIndex: 0,
          text: "invalid second",
        },
      ],
    ];
    for (const changes of cases) {
      const update = liveUpdateSchema.parse({ checkpoint: checkpoint(2), changes });
      const result = applyLiveUpdate(initial, update);
      expect(result.resyncRequired).toBe(true);
      expect(result.checkpoint).toBe(initial.checkpoint);
      expect(result.slots).toBe(initial.slots);
      expect(applyHydration(result, hydrate("slot-0", [ready(0), ready(1)]))).toBe(result);
      const recovered = applyReplayReply(result, {
        kind: "window",
        checkpoint: checkpoint(2),
        slots: [ready(2)],
      });
      expect(recovered?.resyncRequired).toBe(false);
    }
  });

  test("failed hydration remains unresolved and can retry in place", () => {
    const initial = state([deferred(0), ready(1)]);
    const failed = turnSlotSchema.parse({
      kind: "failed",
      slotId: "slot-0",
      position: 0,
      endPosition: 1,
      message: "Could not load turn",
      retryable: true,
    });
    const failure = applyHydration(initial, hydrate("slot-0", [failed]));
    expect(failure.slots[0]?.slot.kind).toBe("failed");
    const retried = applyHydration(failure, hydrate("slot-0", [ready(0)]));
    expect(retried.slots[0]?.slot.kind).toBe("ready");
  });

  test("invalid range coverage or identity reuse never partially changes state", () => {
    const initial = state([deferred(0, 3), ready(3)]);
    expect(applyHydration(initial, hydrate("slot-0", [ready(0), ready(2)]))).toBe(initial);
    expect(
      applyHydration(initial, hydrate("slot-0", [ready(0), ready(1), ready(2), ready(3)])),
    ).toBe(initial);
    expect(
      applyHydration(
        initial,
        hydrate("slot-0", [ready(0), { ...ready(1), slotId: "slot-3" }, ready(2)]),
      ),
    ).toBe(initial);
    expect(
      applyHydration(
        initial,
        hydrate("slot-0", [ready(0), { ...ready(1), turnId: "turn-3" }, ready(2)]),
      ),
    ).toBe(initial);
    expect(initial.slots[0]?.slot.kind).toBe("deferred");
  });
});
