import type { NativeThreadRecord, NativeUser } from "./codec";

export type NativeThreadGrant = "read" | "edit";
export type NativeThreadCapabilities = { read: boolean; edit: boolean; share: boolean };

export function nativeThreadCapabilities(
  user: NativeUser,
  thread: NativeThreadRecord,
  grant?: NativeThreadGrant,
): NativeThreadCapabilities {
  if (thread.deleted || user.role === "service") return { read: false, edit: false, share: false };
  if (user.role === "owner") return { read: true, edit: true, share: true };
  if (thread.starterId === user.id) return { read: true, edit: true, share: false };
  return {
    read: grant !== undefined,
    edit: grant === "edit" && user.toolMode === "full",
    share: false,
  };
}
