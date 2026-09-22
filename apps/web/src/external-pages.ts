import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
export type ExternalPage = NativeRpcOutputs["external"]["read"];
export function mergeExternalPage(
  previous: ExternalPage | undefined,
  page: ExternalPage,
  append: boolean,
): ExternalPage {
  if (!append || previous?.thread.id !== page.thread.id)
    return { ...page, messages: chronological(page.messages) };
  const messages =
    page.thread.surface === "discord"
      ? [...page.messages, ...previous.messages]
      : [...previous.messages, ...page.messages];
  return {
    ...page,
    messages: chronological([
      ...new Map(messages.map((message) => [message.id, message])).values(),
    ]),
  };
}

function chronological(messages: ExternalPage["messages"]): ExternalPage["messages"] {
  return messages.toSorted(
    (left, right) => (left.metadata?.createdAt ?? 0) - (right.metadata?.createdAt ?? 0),
  );
}
