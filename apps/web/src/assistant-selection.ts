import {
  CITATION_CONTEXT_LENGTH,
  type AssistantCitation,
} from "@stanley2058/lilac-client-protocol";

export type TextSelector = Pick<AssistantCitation, "text" | "start" | "end" | "prefix" | "suffix">;
export type CitationAnchor = { source: HTMLElement; range: Range; backwards: boolean };
const excluded =
  "button,input,textarea,select,[role=button],[contenteditable],[hidden],[aria-hidden=true],svg,script,style,.select-none,.sr-only";
const blocks = "p,div,section,article,li,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6,table,tr,td,th";
const normalize = (text: string) => text.replace(/\s+/g, " ");

function contextSlice(text: string, start: number, end: number): string {
  let value = text.slice(start, end);
  if (/^[\uDC00-\uDFFF]/u.test(value)) value = value.slice(1);
  if (/[\uD800-\uDBFF]$/u.test(value)) value = value.slice(0, -1);
  return value;
}

export function createTextSelector(
  text: string,
  rawStart: number,
  rawEnd: number,
): TextSelector | undefined {
  const quote = text.slice(rawStart, rawEnd);
  if (!quote.trim()) return;
  const normalized = normalize(text);
  let start = normalize(text.slice(0, rawStart)).length;
  if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) start--;
  const end = normalize(text.slice(0, rawEnd)).length;
  return {
    text: quote,
    start,
    end,
    prefix: contextSlice(normalized, Math.max(0, start - CITATION_CONTEXT_LENGTH), start),
    suffix: contextSlice(normalized, end, end + CITATION_CONTEXT_LENGTH),
  };
}

export function findCitationText(
  text: string,
  selector: TextSelector,
): { start: number; end: number } | undefined {
  const normalized = normalize(text);
  const quote = normalize(selector.text);
  if (!quote.trim()) return;
  const prefix = normalize(selector.prefix);
  const suffix = normalize(selector.suffix);
  let count = 0;
  let only: { start: number; end: number } | undefined;
  let match: { start: number; end: number } | undefined;
  for (
    let start = normalized.indexOf(quote);
    start !== -1;
    start = normalized.indexOf(quote, start + 1)
  ) {
    const end = start + quote.length;
    count++;
    only = { start, end };
    if (
      normalized.slice(Math.max(0, start - prefix.length), start) !== prefix ||
      normalized.slice(end, end + suffix.length) !== suffix
    )
      continue;
    if (match) return;
    match = { start, end };
  }
  return match ?? (count === 1 ? only : undefined);
}

function readText(root: HTMLElement) {
  const chunks: { node: Text; start: number; end: number }[] = [];
  let text = "";
  let separator = false;
  const visit = (node: Node) => {
    if (node instanceof Text) {
      if (!node.length) return;
      if (separator && text.length) text += "\n";
      separator = false;
      chunks.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
      return;
    }
    if (!(node instanceof Element) || node.matches(excluded)) return;
    const block = node.matches(blocks);
    if (block || node.tagName === "BR") separator = true;
    for (const child of node.childNodes) visit(child);
    if (block) separator = true;
  };
  // Only assistant prose contributes positions; tool chrome and message controls are outside it.
  for (const region of root.querySelectorAll("[data-citation-text]")) visit(region);
  return { text, chunks };
}

function textBoundary(range: Range, node: Node, last: boolean): Text | undefined {
  if (!range.intersectsNode(node)) return;
  if (node instanceof Text) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    return start < end ? node : undefined;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const boundary = textBoundary(range, child, last);
    if (boundary) return boundary;
  }
}

export function captureAssistantSelection(viewport: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0).cloneRange();
  const backwards =
    selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
  const first = textBoundary(range, range.commonAncestorContainer, false);
  const last = textBoundary(range, range.commonAncestorContainer, true);
  if (!first || !last) return;
  const source = first.parentElement?.closest<HTMLElement>("[data-citation-source]");
  if (!source || !viewport.contains(source)) return;
  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  const stream = readText(source);
  const selected = stream.chunks.filter((chunk) => range.intersectsNode(chunk.node));
  let rawStart: number | undefined;
  let rawEnd = 0;
  for (const chunk of selected) {
    const start = chunk.node === range.startContainer ? range.startOffset : 0;
    const end = chunk.node === range.endContainer ? range.endOffset : chunk.node.length;
    if (end <= start) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === undefined) return;
  // A selection across messages cannot be represented by one source identity.
  if (!source.contains(range.endContainer)) return;
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  if (startElement?.closest(excluded) || endElement?.closest(excluded)) return;
  const selector = createTextSelector(stream.text, rawStart, rawEnd);
  if (!selector) return;
  return {
    selector,
    anchor: {
      source,
      range,
      backwards,
    } satisfies CitationAnchor,
  };
}

function rawOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const whitespace = /\s/.test(match[0][0]!);
    const length = whitespace ? 1 : match[0].length;
    if (normalizedOffset <= offset + length)
      return (
        match.index +
        (whitespace && normalizedOffset > offset ? match[0].length : normalizedOffset - offset)
      );
    offset += length;
  }
  return text.length;
}

export function resolveCitationRange(
  source: HTMLElement,
  selector: TextSelector,
): Range | undefined {
  const stream = readText(source);
  const match = findCitationText(stream.text, selector);
  if (!match) return;
  const start = rawOffset(stream.text, match.start);
  const end = rawOffset(stream.text, match.end);
  const first = stream.chunks.find((chunk) => chunk.end > start);
  const last = stream.chunks.findLast((chunk) => chunk.start < end);
  if (!first || !last) return;
  const range = source.ownerDocument.createRange();
  // Normalized whitespace can include a synthetic block separator with no DOM text node.
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, end - last.start));
  return range;
}

export function selectionEndRect(anchor: CitationAnchor): DOMRect {
  const rects = anchor.range.getClientRects();
  return (
    rects.item(anchor.backwards ? 0 : rects.length - 1) ?? anchor.range.getBoundingClientRect()
  );
}

export function highlightCitation(range: Range, name: string): () => void {
  if (typeof Highlight === "undefined" || !CSS.highlights) return () => {};
  const highlight = new Highlight(range);
  CSS.highlights.set(name, highlight);
  return () => {
    if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
  };
}
