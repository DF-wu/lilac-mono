import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";

export function isNativeServiceMessage(message: DisplayMessage, serviceUserId: string): boolean {
  if (message.metadata?.authorId !== undefined) return message.metadata.authorId === serviceUserId;
  return (
    serviceUserId === "lilac" &&
    message.role === "assistant" &&
    /^np_[a-f0-9]{24}_[a-f0-9]{24}_\d{16}_[a-f0-9]{24}$/.test(message.id)
  );
}
