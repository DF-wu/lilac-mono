import type {
  Hydration,
  LiveUpdate,
  ReplayCheckpoint,
  ReplayReply,
  TurnSlot,
} from "../../src/replay";

type VersionedSlot = { revision: number; slot: TurnSlot };
export type ReplayState = {
  checkpoint: ReplayCheckpoint;
  slots: VersionedSlot[];
  resyncRequired: boolean;
  resyncTarget?: ReplayCheckpoint;
};

function endPosition(slot: TurnSlot): number {
  if (slot.kind === "ready") return slot.position + 1;
  return slot.endPosition;
}

function validSlots(slots: TurnSlot[]): boolean {
  const identities = new Set<string>();
  const turns = new Set<string>();
  let previousEnd = -1;
  for (const slot of slots) {
    if (identities.has(slot.slotId) || slot.position < previousEnd) return false;
    if (slot.kind === "ready" && turns.has(slot.turnId)) return false;
    identities.add(slot.slotId);
    if (slot.kind === "ready") turns.add(slot.turnId);
    previousEnd = endPosition(slot);
  }
  return true;
}

export function applyReplayReply(
  state: ReplayState | undefined,
  reply: ReplayReply,
): ReplayState | undefined {
  if (reply.kind === "delta") {
    if (!state) return state;
    if (state.checkpoint.projectionRevision !== reply.fromRevision)
      return requireResync(state, reply.checkpoint);
    return applyChanges(state, reply);
  }
  if (reply.kind === "unchanged") {
    if (!state || state.resyncRequired) return state;
    const sameGeneration =
      state.checkpoint.historyGeneration === reply.checkpoint.historyGeneration;
    const sameRevision =
      state.checkpoint.projectionRevision === reply.checkpoint.projectionRevision;
    if (!sameGeneration || !sameRevision) return state;
    return { ...state, checkpoint: reply.checkpoint };
  }
  if (state?.resyncTarget && olderThan(reply.checkpoint, state.resyncTarget)) return state;
  if (state && reply.checkpoint.historyGeneration < state.checkpoint.historyGeneration)
    return state;
  if (
    state &&
    reply.checkpoint.historyGeneration === state.checkpoint.historyGeneration &&
    reply.checkpoint.projectionRevision <= state.checkpoint.projectionRevision
  )
    return state;
  if (!validSlots(reply.slots)) return state;
  return {
    checkpoint: reply.checkpoint,
    resyncRequired: false,
    slots: reply.slots.map((slot) => ({ revision: reply.checkpoint.projectionRevision, slot })),
  };
}

export function applyHydration(state: ReplayState, hydration: Hydration): ReplayState {
  if (state.resyncRequired || state.checkpoint.historyGeneration !== hydration.historyGeneration)
    return state;
  const index = state.slots.findIndex(({ slot }) => slot.slotId === hydration.slotId);
  const target = state.slots[index];
  if (!target || target.slot.kind === "ready") return state;
  if (target.revision !== hydration.projectionRevision) return state;
  if (!validSlots(hydration.slots)) return state;
  const first = hydration.slots[0];
  const last = hydration.slots.at(-1);
  if (!first || !last) return state;
  if (first.position !== target.slot.position || endPosition(last) !== endPosition(target.slot))
    return state;
  for (let offset = 1; offset < hydration.slots.length; offset++) {
    const previous = hydration.slots[offset - 1];
    const current = hydration.slots[offset];
    if (!previous || !current || endPosition(previous) !== current.position) return state;
  }
  const slots = state.slots.toSpliced(
    index,
    1,
    ...hydration.slots.map((slot) => ({
      revision: hydration.projectionRevision,
      slot,
    })),
  );
  if (!validSlots(slots.map(({ slot }) => slot))) return state;
  return { ...state, slots };
}

type ChangeOutcome = { kind: "applied"; slots: VersionedSlot[] } | { kind: "resync" };

function applyChange(
  slots: VersionedSlot[],
  change: LiveUpdate["changes"][number],
  revision: number,
): ChangeOutcome {
  if (change.kind === "insert") {
    if (slots.some(({ slot }) => slot.slotId === change.slot.slotId)) return { kind: "resync" };
    return {
      kind: "applied",
      slots: [...slots, { revision, slot: change.slot }].sort(
        (a, b) => a.slot.position - b.slot.position,
      ),
    };
  }
  const targetIndex = slots.findIndex(
    ({ slot }) => change.position >= slot.position && change.position < endPosition(slot),
  );
  const target = slots[targetIndex];
  if (!target) return { kind: "resync" };
  if (change.kind === "remove") {
    if (target.slot.kind === "ready" && target.slot.turnId !== change.turnId)
      return { kind: "resync" };
    if (endPosition(target.slot) !== target.slot.position + 1) return { kind: "resync" };
    return { kind: "applied", slots: slots.toSpliced(targetIndex, 1) };
  }
  if (target.slot.kind !== "ready") {
    return { kind: "applied", slots: slots.with(targetIndex, { ...target, revision }) };
  }
  if (target.slot.turnId !== change.turnId) return { kind: "resync" };
  if (change.kind === "turn-state") {
    const { kind: _kind, turnId: _turnId, position: _position, ...status } = change;
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: { ...target.slot, ...status },
      }),
    };
  }
  if (change.kind === "append-message") {
    if (target.slot.messages.some((message) => message.id === change.message.id))
      return { kind: "resync" };
    const before =
      change.beforeMessageId === undefined
        ? target.slot.messages.length
        : target.slot.messages.findIndex((message) => message.id === change.beforeMessageId);
    if (before === -1) return { kind: "resync" };
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: {
          ...target.slot,
          messages: target.slot.messages.toSpliced(before, 0, change.message),
        },
      }),
    };
  }
  const messageIndex = target.slot.messages.findIndex((message) => message.id === change.messageId);
  if (change.kind === "remove-message") {
    if (messageIndex === -1) return { kind: "resync" };
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: { ...target.slot, messages: target.slot.messages.toSpliced(messageIndex, 1) },
      }),
    };
  }
  const message = target.slot.messages[messageIndex];
  if (change.kind === "truncate-parts") {
    if (!message || message.parts.length < change.length) return { kind: "resync" };
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: {
          ...target.slot,
          messages: target.slot.messages.with(messageIndex, {
            ...message,
            parts: message.parts.slice(0, change.length),
          }),
        },
      }),
    };
  }
  if (change.kind === "message-meta") {
    if (!message) return { kind: "resync" };
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: {
          ...target.slot,
          messages: target.slot.messages.with(messageIndex, {
            ...message,
            metadata: { ...message.metadata, ...change.metadata },
          }),
        },
      }),
    };
  }
  const part = message?.parts[change.partIndex];
  if (!message) return { kind: "resync" };
  if (change.kind === "set-part") {
    if (change.partIndex > message.parts.length) return { kind: "resync" };
    const parts = [...message.parts];
    parts[change.partIndex] = change.part;
    const messages = target.slot.messages.with(messageIndex, { ...message, parts });
    return {
      kind: "applied",
      slots: slots.with(targetIndex, {
        revision,
        slot: { ...target.slot, messages },
      }),
    };
  }
  if (!part || part.type !== "text") return { kind: "resync" };
  const messages = target.slot.messages.with(messageIndex, {
    ...message,
    parts: message.parts.with(change.partIndex, { ...part, text: part.text + change.text }),
  });
  return {
    kind: "applied",
    slots: slots.with(targetIndex, { revision, slot: { ...target.slot, messages } }),
  };
}

function olderThan(checkpoint: ReplayCheckpoint, floor: ReplayCheckpoint): boolean {
  if (checkpoint.historyGeneration !== floor.historyGeneration) {
    return checkpoint.historyGeneration < floor.historyGeneration;
  }
  return checkpoint.projectionRevision < floor.projectionRevision;
}

function requireResync(state: ReplayState, checkpoint: ReplayCheckpoint): ReplayState {
  const floor = state.resyncTarget ?? state.checkpoint;
  if (state.resyncRequired && !olderThan(floor, checkpoint)) return state;
  return { ...state, resyncRequired: true, resyncTarget: checkpoint };
}

export function applyLiveUpdate(state: ReplayState, update: LiveUpdate): ReplayState {
  if (state.resyncRequired) return requireResync(state, update.checkpoint);
  if (update.checkpoint.historyGeneration < state.checkpoint.historyGeneration) return state;
  if (update.checkpoint.historyGeneration > state.checkpoint.historyGeneration)
    return requireResync(state, update.checkpoint);
  if (update.checkpoint.projectionRevision <= state.checkpoint.projectionRevision) return state;
  if (update.checkpoint.projectionRevision !== state.checkpoint.projectionRevision + 1)
    return requireResync(state, update.checkpoint);
  return applyChanges(state, update);
}

function applyChanges(state: ReplayState, update: LiveUpdate): ReplayState {
  if (state.resyncRequired) return requireResync(state, update.checkpoint);
  if (update.checkpoint.historyGeneration !== state.checkpoint.historyGeneration)
    return requireResync(state, update.checkpoint);
  if (update.checkpoint.projectionRevision <= state.checkpoint.projectionRevision) return state;
  let slots = state.slots;
  for (const change of update.changes) {
    const outcome = applyChange(slots, change, update.checkpoint.projectionRevision);
    if (outcome.kind === "resync") return requireResync(state, update.checkpoint);
    slots = outcome.slots;
  }
  if (!validSlots(slots.map(({ slot }) => slot))) return requireResync(state, update.checkpoint);
  return { checkpoint: update.checkpoint, slots, resyncRequired: false };
}
