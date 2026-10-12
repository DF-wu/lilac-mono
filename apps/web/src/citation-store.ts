import { createStore } from "zustand/vanilla";
import type { AssistantCitation } from "@stanley2058/lilac-client-protocol";
import type { CitationAnchor } from "./assistant-selection";

type Cite = (citation: AssistantCitation, anchor: CitationAnchor) => boolean;
export type CitationNavigation = { citation: AssistantCitation; key: string };
export const citationStore = createStore<{
  composers: Map<string, Cite>;
  navigation?: CitationNavigation;
}>(() => ({ composers: new Map() }));

export function registerCitationComposer(threadId: string, cite: Cite): () => void {
  citationStore.setState((state) => ({ composers: new Map(state.composers).set(threadId, cite) }));
  return () => {
    if (citationStore.getState().composers.get(threadId) !== cite) return;
    citationStore.setState((state) => {
      const composers = new Map(state.composers);
      composers.delete(threadId);
      return { composers };
    });
  };
}

export function revealCitation(citation: AssistantCitation): void {
  citationStore.setState({ navigation: { citation, key: crypto.randomUUID() } });
}

export function dismissCitation(key: string): void {
  if (citationStore.getState().navigation?.key === key)
    citationStore.setState({ navigation: undefined });
}
