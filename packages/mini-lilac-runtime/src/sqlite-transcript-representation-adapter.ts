import type { MiniLilacUIMessage } from "@stanley2058/mini-lilac-client";
import type { ModelMessage } from "ai";

import type {
  MiniLilacPersistedModelMessageProjection,
  MiniLilacPersistedUiMessageProjection,
} from "./sqlite-transcript-projection";

/**
 * The persisted projection is a validated structural subtype of ModelMessage:
 * SDK `unknown` payload slots contain the same recursive SuperJSON values and
 * no field or runtime value is transformed at this representation boundary.
 */
export function adaptPersistedModelMessagesToSdk(
  messages: readonly MiniLilacPersistedModelMessageProjection[],
): ModelMessage[] {
  return messages.map((message): ModelMessage => message);
}

/**
 * The persisted projection mirrors every supported Mini UI field while
 * replacing SDK `unknown` tool slots with validated SuperJSON values. The
 * structural assignment is representation-preserving and requires no cast.
 */
export function adaptPersistedUiMessagesToSdk(
  messages: readonly MiniLilacPersistedUiMessageProjection[],
): MiniLilacUIMessage[] {
  return messages.map((message): MiniLilacUIMessage => message);
}
