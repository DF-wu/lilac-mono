import type { ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";

export type OptimisticTurn = {
  slot: ReadyTurnSlot;
  precedingSlotIds: readonly string[];
  confirmedSlotId?: string;
};

export class OptimisticTurns {
  private readonly keys = new Map<string, string>();

  key(slotId: string): string {
    return this.keys.get(slotId) ?? slotId;
  }

  reconcile(storedIds: readonly string[], pending?: OptimisticTurn): readonly string[] {
    if (!pending) return storedIds;
    const { slot, confirmedSlotId, precedingSlotIds } = pending;
    // Replay can beat the receipt. Wait for its identity before mounting the new turn.
    if (!confirmedSlotId) {
      const preceding = new Set(precedingSlotIds);
      const precedingEnd = storedIds.findLastIndex((id) => preceding.has(id));
      return [...storedIds.slice(0, precedingEnd + 1), slot.slotId];
    }
    this.keys.set(confirmedSlotId, slot.slotId);
    if (storedIds.includes(confirmedSlotId)) return storedIds;
    return [...storedIds, confirmedSlotId];
  }
}
