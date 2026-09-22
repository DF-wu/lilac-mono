import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
export type ExternalPage = NativeRpcOutputs["external"]["read"];
export function mergeExternalPage(
  previous: ExternalPage | undefined,
  page: ExternalPage,
  append: boolean,
): ExternalPage {
  if (!append || previous?.thread.id !== page.thread.id)
    return { ...page, messages: page.messages };
  const messages = [...page.messages, ...previous.messages];
  return {
    ...page,
    messages: [...new Map(messages.map((message) => [message.id, message])).values()],
  };
}
