import { useInfiniteQuery } from "@tanstack/react-query";
import { ExternalLink, Link2, RefreshCw } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { externalReadOptions, useNativeOnline } from "../queries";
import { mergeExternalPage, type ExternalPage } from "../external-pages";
import { copyReferenceLink } from "./ConversationReference";
import { DropdownMenuItem } from "./ui/dropdown-menu";

export function useExternalView(
  threadId: string | undefined,
  { refetchOnMount = true }: { refetchOnMount?: boolean } = {},
) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const read = useInfiniteQuery({
    ...externalReadOptions(client, threadId),
    enabled: online && !!threadId,
    refetchOnMount,
  });
  const view = read.data?.pages.reduce<ExternalPage | undefined>(
    (previous, page) => mergeExternalPage(previous, page, true),
    undefined,
  );
  const reference = view?.messages.find((message) => message.metadata?.reference)?.metadata
    ?.reference;
  return { read, view, reference };
}

export function ExternalMenuItems({ threadId }: { threadId: string }) {
  // The open conversation already owns this query; opening the menu must not refetch every page.
  const { read, view, reference } = useExternalView(threadId, { refetchOnMount: false });
  return (
    <>
      {view?.thread.sourceUrl ? (
        <DropdownMenuItem
          className="text-inherit hover:no-underline"
          render={<a href={view.thread.sourceUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLink />
          Open in {view.thread.surface === "discord" ? "Discord" : "GitHub"}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        disabled={!reference}
        onClick={() => {
          if (reference)
            copyReferenceLink({ surface: reference.surface, sessionId: reference.sessionId });
        }}
      >
        <Link2 />
        Copy conversation link
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={read.isFetching}
        onClick={() => {
          void read.refetch();
        }}
      >
        <RefreshCw />
        Refresh
      </DropdownMenuItem>
    </>
  );
}
