import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowUpRight, MessageSquareText, Quote } from "lucide-react";
import {
  citationHref,
  citationLabel,
  serializeCitation,
  CITATION_COMMENT_LIMIT,
  type AssistantCitation,
} from "@stanley2058/lilac-client-protocol";
import {
  highlightCitation,
  resolveCitationRange,
  type CitationAnchor,
} from "../assistant-selection";
import { revealCitation } from "../citation-store";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type CitationEditing = {
  open: boolean;
  anchor?: CitationAnchor;
  discardOnCancel?: boolean;
  onOpen: (open: boolean) => void;
  onSave: (comment: string) => boolean;
  onCancel: () => void;
  onSaveAndSend: (comment: string) => boolean;
  onRestoreFocus: () => void;
};

function sourceAnchor(citation: AssistantCitation): CitationAnchor | undefined {
  const source = [...document.querySelectorAll<HTMLElement>("[data-citation-source]")].find(
    (element) =>
      element.dataset.citationSource === citation.messageId &&
      element.dataset.citationThread === citation.threadId,
  );
  if (!source) return;
  const range = resolveCitationRange(source, citation);
  return range ? { source, range, backwards: false } : undefined;
}

const chip = (
  <Button
    variant="reference"
    className="h-auto max-w-full gap-1 rounded-sm px-2 [font-weight:inherit] aria-expanded:bg-surface-raised [&_svg:not([class*='size-'])]:size-[1em]"
  />
);

export function CitationChip({
  citation,
  editing,
}: {
  citation: AssistantCitation;
  editing?: CitationEditing;
}) {
  const [preview, setPreview] = useState(false);
  const draftComment = useRef<string | undefined>(undefined);
  const label = citationLabel(citation);
  const href = `/threads/${encodeURIComponent(citation.threadId)}#${new URLSearchParams({ citation: citationHref(citation) })}`;
  const goToSource = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const mounted = sourceAnchor(citation);
    if (
      location.pathname === `/threads/${encodeURIComponent(citation.threadId)}` ||
      mounted?.source.getBoundingClientRect().height
    ) {
      event.preventDefault();
      revealCitation(citation);
      setPreview(false);
      editing?.onOpen(false);
    }
  };
  useEffect(() => {
    if (!editing?.open) return;
    const current = editing.anchor ?? sourceAnchor(citation);
    if (!current) return;
    let release = highlightCitation(current.range, "lilac-citation-comment");
    const update = () => {
      release();
      const range = current.source.isConnected
        ? resolveCitationRange(current.source, citation)
        : undefined;
      if (!range) return;
      current.range = range;
      release = highlightCitation(range, "lilac-citation-comment");
    };
    const observer = new MutationObserver(update);
    const viewport = current.source.closest(".timeline") ?? current.source.parentElement;
    if (viewport)
      observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      release();
    };
  }, [editing?.open, editing?.anchor, citation]);
  const content = (
    <>
      <Quote aria-hidden="true" />
      <span className="max-w-56 truncate">{label}</span>
      {citation.comment ? <MessageSquareText aria-label="Has comment" /> : null}
    </>
  );
  const goToSourceButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            nativeButton={false}
            variant="ghost"
            size="icon-xs"
            className="-my-0.5 -mr-1 shrink-0 text-muted-foreground"
            aria-label="Go to source"
            render={<a href={href} onClick={goToSource} />}
          />
        }
      >
        <ArrowUpRight className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>Go to source</TooltipContent>
    </Tooltip>
  );
  if (editing)
    return (
      <Popover
        open={editing.open}
        onOpenChange={(open, details) => {
          if (!open && details.reason === "escape-key") {
            editing.onCancel();
            return;
          }
          if (
            !open &&
            draftComment.current !== undefined &&
            draftComment.current.trim() !== (citation.comment ?? "").trim()
          ) {
            if (
              draftComment.current.length > CITATION_COMMENT_LIMIT ||
              !editing.onSave(draftComment.current)
            ) {
              details.cancel();
              return;
            }
          }
          draftComment.current = undefined;
          editing.onOpen(open);
        }}
      >
        <PopoverTrigger
          data-ui="citation-chip"
          render={chip}
          aria-label={`${citation.comment ? "Edit" : "Add"} comment on quote: ${label}`}
        >
          {content}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-96 max-w-[calc(100vw-1rem)] p-2"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          initialFocus={() =>
            document.querySelector<HTMLTextAreaElement>(
              '[data-ui="citation-comment-editor"] textarea',
            )
          }
          finalFocus={() => {
            const active = document.activeElement;
            if (active === document.body || active?.closest('[data-slot="popover-content"]'))
              editing.onRestoreFocus();
            return false;
          }}
        >
          <CitationComment
            key={serializeCitation(citation)}
            citation={citation}
            editing={editing}
            goToSource={goToSourceButton}
            onDraft={(value) => {
              draftComment.current = value;
            }}
          />
        </PopoverContent>
      </Popover>
    );
  return (
    <Popover open={preview} onOpenChange={setPreview}>
      <PopoverTrigger data-ui="citation-chip" render={chip}>
        {content}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-1rem)] gap-2.5 p-3">
        <CitationQuote text={citation.text}>{goToSourceButton}</CitationQuote>
        {citation.comment ? (
          <p className="max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere">
            {citation.comment}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CitationQuote({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <blockquote className="max-h-48 min-w-0 flex-1 overflow-auto border-l-2 border-primary pl-2.5 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
        {text}
      </blockquote>
      {children}
    </div>
  );
}

function CitationComment({
  citation,
  editing,
  goToSource,
  onDraft,
}: {
  citation: AssistantCitation;
  editing: CitationEditing;
  goToSource: ReactNode;
  onDraft: (value: string) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const [error, setError] = useState(false);
  const tooLong = comment.length > CITATION_COMMENT_LIMIT;
  const save = (send = false) => {
    if (tooLong) return;
    const saved = send ? editing.onSaveAndSend(comment) : editing.onSave(comment);
    setError(!saved);
    if (saved) editing.onOpen(false);
  };
  return (
    <div
      data-ui="citation-comment-editor"
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.key === "Process") return;
        if (event.key === "Escape") {
          event.preventDefault();
          editing.onCancel();
        }
      }}
    >
      <Textarea
        aria-label="Comment on quote"
        placeholder="Add an optional comment"
        rows={3}
        className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-1.5 py-1 focus-visible:ring-0 aria-invalid:ring-0"
        value={comment}
        aria-invalid={tooLong || error || undefined}
        onChange={(event) => {
          setComment(event.target.value);
          onDraft(event.target.value);
          setError(false);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.key !== "Process"
          ) {
            event.preventDefault();
            save(event.metaKey || event.ctrlKey);
          }
        }}
      />
      <div className="flex items-center gap-2 pl-1">
        {goToSource}
        <p role="status" className="mr-auto text-xs text-destructive">
          {tooLong && "Shorten the comment."}
          {!tooLong && error && "Shorten the quote, comment, or message."}
        </p>
        <Button size="sm" variant="outline" onClick={editing.onCancel}>
          {editing.discardOnCancel ? "Remove" : "Cancel"}
        </Button>
        <Button size="sm" disabled={tooLong} onClick={() => save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
