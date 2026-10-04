import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2, RefreshCw } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { externalReadOptions, useNativeOnline } from "../queries";
import { mergeExternalPage, type ExternalPage } from "../external-pages";
import { copyReferenceLink } from "./ConversationReference";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { attempt } from "./ui";
import { toast } from "./ui/toast";

function findReference(pages: ExternalPage[]) {
  for (const page of pages) {
    const reference = page.messages.find((message) => message.metadata?.reference)?.metadata
      ?.reference;
    if (reference) return { surface: reference.surface, sessionId: reference.sessionId };
  }
  return undefined;
}

export function useExternalView(
  threadId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const read = useInfiniteQuery({
    ...externalReadOptions(client, threadId),
    enabled: enabled && online && !!threadId,
  });
  const view = read.data?.pages.reduce<ExternalPage | undefined>(
    (previous, page) => mergeExternalPage(previous, page, true),
    undefined,
  );
  const reference = read.data ? findReference(read.data.pages) : undefined;
  return { read, view, reference };
}

export function ExternalMenuItems({
  threadId,
  thread: listed,
  Item = DropdownMenuItem,
}: {
  threadId: string;
  thread?: { sourceUrl?: string; surface: "discord" | "github" };
  Item?: typeof DropdownMenuItem;
}) {
  // Menus only read the cache: the open conversation owns this query, and a sidebar menu must not
  // download a conversation just because it opened.
  const { read, view, reference } = useExternalView(threadId, { enabled: false });
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const thread = view?.thread ?? listed;
  return (
    <>
      {thread?.sourceUrl ? (
        <Item
          className="text-inherit hover:no-underline"
          render={<a href={thread.sourceUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLink />
          Open in {thread.surface === "discord" ? "Discord" : "GitHub"}
        </Item>
      ) : null}
      <Item
        disabled={!!view && !reference}
        onClick={() => {
          if (reference) {
            copyReferenceLink(reference);
            return;
          }
          void attempt(
            async () => {
              const data = await queries.infiniteQuery(externalReadOptions(client, threadId));
              const target = findReference(data.pages);
              if (target) copyReferenceLink(target);
              else toast.add({ title: "Conversation unavailable", type: "error" });
            },
            () => toast.add({ title: "Conversation unavailable", type: "error" }),
          );
        }}
      >
        <Link2 />
        Copy conversation link
      </Item>
      <Item
        disabled={read.isFetching}
        onClick={() => {
          void queries.invalidateQueries({
            queryKey: externalReadOptions(client, threadId).queryKey,
            exact: true,
          });
        }}
      >
        <RefreshCw />
        Refresh
      </Item>
    </>
  );
}
