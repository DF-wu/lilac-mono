import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
export type ExternalPage = NativeRpcOutputs["external"]["read"];
export function mergeExternalPage(
  previous: ExternalPage | undefined,
  page: ExternalPage,
  append: boolean,
): ExternalPage {
  if (!append || previous?.thread.id !== page.thread.id) return page;
  const messages =
    page.thread.surface === "discord"
      ? [...page.messages, ...previous.messages]
      : [...previous.messages, ...page.messages];
  return {
    ...page,
    messages: [...new Map(messages.map((message) => [message.id, message])).values()],
  };
}
