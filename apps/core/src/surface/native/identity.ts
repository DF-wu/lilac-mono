import type { AgentIdentity, NativeUser as DisplayUser } from "@stanley2058/lilac-client-protocol";
import type { NativeUser } from "./codec";

export function agentIdentity(user: NativeUser): AgentIdentity {
  return {
    id: "lilac",
    displayName: user.displayName,
    ...(user.avatar
      ? { avatarUrl: `/api/identity/avatar?revision=${user.avatar.blob.sha256}` }
      : {}),
  };
}

export function nativeUserDisplay(user: NativeUser): DisplayUser {
  return { id: user.id, displayName: user.displayName, role: user.role, toolMode: user.toolMode };
}
