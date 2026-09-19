import { createStore } from "zustand/vanilla";
import {
  draftThreadTitle,
  hasDraftContent,
  newDraftThread,
  type DraftThread,
} from "./draft-thread";

type DraftSummary = { id: string; title: string; editable: boolean };
type DraftState = {
  localDrafts: Map<string, DraftThread>;
  summaries: DraftSummary[];
  setLocalDrafts: (drafts: Map<string, DraftThread>) => void;
};

export function createDraftStore() {
  const first = newDraftThread();
  return createStore<DraftState>((set, get) => ({
    localDrafts: new Map([[first.id, first]]),
    summaries: [],
    setLocalDrafts(localDrafts) {
      const previous = get();
      const byId = new Map(previous.summaries.map((item) => [item.id, item]));
      const summaries: DraftSummary[] = [];
      for (const draft of localDrafts.values()) {
        if (!hasDraftContent(draft)) continue;
        const cached = byId.get(draft.id);
        if (cached && previous.localDrafts.get(draft.id) === draft) {
          summaries.push(cached);
          continue;
        }
        const title = draftThreadTitle(draft);
        const editable = !draft.creation;
        summaries.push(
          cached?.title === title && cached.editable === editable
            ? cached
            : { id: draft.id, title, editable },
        );
      }
      const unchanged =
        summaries.length === previous.summaries.length &&
        summaries.every((item, index) => item === previous.summaries[index]);
      set({ localDrafts, summaries: unchanged ? previous.summaries : summaries });
    },
  }));
}
