import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Link2, ExternalLink, Check } from "lucide-react";
import { referenceHref, type ConversationReference } from "@stanley2058/lilac-client-protocol";
import { useOptionalWorkspace } from "../workspace-context";
import { useFileViewer } from "./file-viewer-context";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Button } from "./ui/button";
import { attempt, IconButton } from "./ui";
import { toast } from "./ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export const ConversationContext = createContext<ConversationReference | undefined>(undefined);
export const useConversation = () => useContext(ConversationContext);

export function ConversationIcon({ surface }: { surface: ConversationReference["surface"] }) {
  if (surface === "discord")
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-label="Discord" className="size-4 shrink-0">
        <path d="M19.7 5.1a18 18 0 0 0-4.5-1.4l-.6 1.2a17 17 0 0 0-5.2 0l-.6-1.2a18 18 0 0 0-4.5 1.4C1.4 9.5.6 13.8 1 18a18 18 0 0 0 5.5 2.8l1.1-1.8-1.8-.9.4-.3a13 13 0 0 0 11.6 0l.4.3-1.8.9 1.1 1.8A18 18 0 0 0 23 18c.5-4.9-.9-9.2-3.3-12.9ZM8.3 15.4c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Zm7.4 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Z" />
      </svg>
    );
  if (surface === "github")
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-label="GitHub" className="size-4 shrink-0">
        <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.3-.5-1.5.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
      </svg>
    );
  return <MessageSquare aria-label="Native" className="size-4 shrink-0" />;
}

export function CopyReferenceButton({
  target,
  disabled = false,
  label = "Copy link",
  resolveTarget,
  children,
}: {
  target?: ConversationReference;
  disabled?: boolean;
  label?: string;
  resolveTarget?: () => Promise<ConversationReference | undefined>;
  children?: ReactNode;
}) {
  const [copiedAt, setCopiedAt] = useState(0);
  const copied = copiedAt > 0;
  useEffect(() => {
    if (!copiedAt) return;
    const timer = setTimeout(() => setCopiedAt(0), 2000);
    return () => clearTimeout(timer);
  }, [copiedAt]);
  const [copying, setCopying] = useState(false);
  return (
    <IconButton
      label={label}
      tooltip={copied ? "Link copied" : label}
      disabled={disabled || copying || (!target && !resolveTarget)}
      onClick={() => {
        if (!target && !resolveTarget) return;
        setCopying(true);
        void attempt(
          async () => {
            const resolved = resolveTarget ? await resolveTarget() : target;
            if (!resolved) {
              toast.add({ title: "Conversation unavailable", type: "error" });
              return;
            }
            await navigator.clipboard.writeText(
              new URL(referenceHref(resolved), location.origin).href,
            );
            setCopiedAt(Date.now());
          },
          () => toast.add({ title: "Copy unavailable", type: "error" }),
        ).finally(() => setCopying(false));
      }}
    >
      {copied ? <Check /> : (children ?? <Link2 />)}
    </IconButton>
  );
}

export function copyReferenceLink(target: ConversationReference) {
  void attempt(
    async () => {
      await navigator.clipboard.writeText(new URL(referenceHref(target), location.origin).href);
      toast.add({ title: "Link copied" });
    },
    () => toast.add({ title: "Copy unavailable", type: "error" }),
  );
}

export function CopyReferenceItem({
  target,
  label,
}: {
  target: ConversationReference;
  label?: string;
}) {
  return (
    <ContextMenuItem onClick={() => copyReferenceLink(target)}>
      <Link2 />
      {label ?? (target.messageId ? "Copy link" : "Copy conversation link")}
    </ContextMenuItem>
  );
}

export function ReferenceActions({
  target,
  sourceUrl,
  children,
}: {
  target: ConversationReference;
  sourceUrl?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="inline" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <CopyReferenceItem target={target} />
        <ContextMenuItem render={<a href={referenceHref(target)} />}>
          <ExternalLink />
          Open in main view
        </ContextMenuItem>
        {sourceUrl ? (
          <ContextMenuItem render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}>
            <ExternalLink />
            Open in {target.surface === "discord" ? "Discord" : "GitHub"}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ConversationBadge({ target }: { target: ConversationReference }) {
  const workspace = useOptionalWorkspace();
  const viewer = useFileViewer();
  const query = useQuery({
    queryKey: ["reference", referenceHref(target)],
    queryFn: ({ signal }) => workspace!.client.rpc!.references.resolve(target, { signal }),
    enabled: !!workspace?.client.rpc,
    retry: false,
  });
  const title = (!query.error && query.data?.title) || target.sessionId;
  const sourceUrl =
    query.data?.sourceUrl ??
    (target.surface === "discord"
      ? `https://discord.com/channels/@me/${target.sessionId}${target.messageId ? `/${target.messageId}` : ""}`
      : undefined);
  return (
    <ReferenceActions target={target} sourceUrl={sourceUrl}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="reference"
              className="no-underline hover:no-underline inline-flex max-w-full h-auto gap-1 px-2 rounded-sm [font-weight:inherit]"
              render={<a href={referenceHref(target)} />}
              onClick={(event) => {
                if (
                  !workspace ||
                  !viewer ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                workspace.panels
                  .getState()
                  .openThread(viewer.threadId, target, title, query.data?.conversationThreadId);
              }}
            >
              <ConversationIcon surface={target.surface} />
              <span className="truncate">{title}</span>
              {target.messageId || target.range ? <Link2 className="size-3 shrink-0" /> : null}
            </Button>
          }
        />
        <TooltipContent className="max-w-sm">
          <div className="min-w-0 space-y-1 break-words">
            <div className="font-medium">{title}</div>
            <div>{{ native: "Native", discord: "Discord", github: "GitHub" }[target.surface]}</div>
            <div className="break-all">Conversation: {target.sessionId}</div>
            {target.messageId ? <div className="break-all">Message: {target.messageId}</div> : null}
            {target.range ? (
              <div className="break-all">
                Range: {target.range.startMessageId} to {target.range.endMessageId}
              </div>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </ReferenceActions>
  );
}
