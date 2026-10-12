import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Pencil, Quote, ArrowUpRight } from "lucide-react";
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
  selectionEndRect,
  type CitationAnchor,
} from "../assistant-selection";
import { revealCitation } from "../citation-store";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Textarea } from "./ui/textarea";

export type CitationEditing = {
  open: boolean;
  anchor?: CitationAnchor;
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

export function CitationChip({
  citation,
  editing,
}: {
  citation: AssistantCitation;
  editing?: CitationEditing;
}) {
  const [preview, setPreview] = useState(false);
  const [anchor, setAnchor] = useState<CitationAnchor>();
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
    }
  };
  useEffect(() => {
    if (!editing?.open) {
      setAnchor(undefined);
      return;
    }
    const current = editing.anchor ?? sourceAnchor(citation);
    if (!current) return;
    setAnchor(current);
    let release = highlightCitation(current.range, "lilac-citation-comment");
    const update = () => {
      release();
      const range = current.source.isConnected
        ? resolveCitationRange(current.source, citation)
        : undefined;
      if (!range) {
        setAnchor(undefined);
        return;
      }
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
  const virtualAnchor = anchor
    ? {
        contextElement: anchor.source,
        getBoundingClientRect: () => {
          const rect = selectionEndRect(anchor);
          return new DOMRect(anchor.backwards ? rect.left : rect.right, rect.top, 0, rect.height);
        },
      }
    : undefined;
  const link = (
    <a
      href={href}
      onClick={goToSource}
      className="inline-flex min-w-0 items-center gap-1 text-inherit no-underline"
      aria-label={`View cited text: ${label}`}
    >
      <Quote className="size-3.5 shrink-0" />
      <span className="max-w-64 truncate">{label}</span>
    </a>
  );
  if (editing)
    return (
      <span
        data-ui="citation-chip"
        className="inline-flex max-w-full items-center gap-1 rounded-sm bg-selection px-1 text-sm text-selection-foreground align-baseline"
      >
        {link}
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
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={citation.comment ? "Edit citation comment" : "Add citation comment"}
              />
            }
          >
            <Pencil />
          </PopoverTrigger>
          <PopoverContent
            anchor={virtualAnchor}
            side={anchor ? "bottom" : "top"}
            align="end"
            className="w-80 max-w-[calc(100vw-1rem)] p-3"
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
              onDraft={(value) => {
                draftComment.current = value;
              }}
            />
          </PopoverContent>
        </Popover>
      </span>
    );
  return (
    <Popover open={preview} onOpenChange={setPreview}>
      <PopoverTrigger data-ui="citation-chip" render={<Button variant="reference" size="inline" />}>
        <Quote />
        <span className="max-w-64 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-1rem)] p-3">
        <blockquote className="max-h-48 overflow-auto border-l-2 border-border pl-3 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {citation.text}
        </blockquote>
        {citation.comment ? (
          <p className="whitespace-pre-wrap wrap-anywhere">{citation.comment}</p>
        ) : null}
        <Button
          nativeButton={false}
          variant="secondary"
          size="sm"
          render={<a href={href} onClick={goToSource} />}
        >
          <ArrowUpRight />
          Go to source
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function CitationComment({
  citation,
  editing,
  onDraft,
}: {
  citation: AssistantCitation;
  editing: CitationEditing;
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
        aria-label="Comment on selected text"
        placeholder="Add an optional comment…"
        rows={2}
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
      {tooLong || error ? (
        <p role="status" className="text-xs text-destructive">
          {tooLong ? "Shorten the comment." : "Shorten the quote, comment, or message."}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={editing.onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={tooLong} onClick={() => save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
