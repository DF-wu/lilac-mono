import { createContext } from "react";
import type { ActorIdentity } from "./ActorAvatar";

export const MessageIdentityContext = createContext<{
  viewerId?: string;
  agent: ActorIdentity;
  promptingAgent?: ActorIdentity;
  users: ReadonlyMap<string, ActorIdentity>;
  onUnknownAuthor?: (authorId: string) => void;
}>({ agent: { displayName: "Lilac" }, users: new Map() });
