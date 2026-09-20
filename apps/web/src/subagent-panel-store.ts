import { createStore } from "zustand/vanilla";

export function createSubagentPanelStore() {
  return createStore<{
    open: boolean;
    selection?: { threadId: string; agentId: string };
    toggle: () => void;
    close: () => void;
    select: (threadId: string, agentId: string) => void;
    back: () => void;
  }>((set) => ({
    open: false,
    toggle: () => set((state) => ({ open: !state.open })),
    close: () => set({ open: false }),
    select: (threadId, agentId) => set({ open: true, selection: { threadId, agentId } }),
    back: () => set({ selection: undefined }),
  }));
}
