import type { ConversationThreadEmbeddingFacet } from "./thread-embedding";

export const CONVERSATION_FACET_WEIGHTS = {
  combined: 0.2,
  aboutnessDomains: 0.85,
  aboutnessSituations: 0.7,
  aboutnessComplaintTargets: 1.1,
  aboutnessEntities: 0.55,
  userWouldAskForThisAs: 1.25,
  retrievalHints: 1,
  title: 0.6,
  brief: 0.45,
  topics: 0.3,
} satisfies Record<ConversationThreadEmbeddingFacet, number>;
