import {
  getMarkdownSource,
  selectedMarkdown,
  sourceTextSelection,
  type SourceSelection,
} from "./markdown-source";

const skipped =
  "button,input,textarea,script,style,svg,[aria-hidden=true],.select-none,.sr-only,.code-toolbar";
const wrappers = new Set([
  "STRONG",
  "B",
  "EM",
  "I",
  "DEL",
  "S",
  "A",
  "CODE",
  "P",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

function selectionMarkdown(range: Range, root: HTMLElement): string | undefined {
  const source = getMarkdownSource(root);
  if (!source) return;
  const selection: SourceSelection = new Map();
  const decoder = root.ownerDocument.createElement("textarea");
  const decodeEntity = (entity: string) => {
    decoder.innerHTML = entity;
    return decoder.value;
  };
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) {
      node = walker.nextNode();
      continue;
    }
    const element = node.parentElement;
    const mapped = element?.closest<HTMLElement>("[data-source]");
    if (!mapped || element?.closest(skipped)) {
      node = walker.nextNode();
      continue;
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) {
      node = walker.nextNode();
      continue;
    }
    const id = Number(mapped.dataset.source?.split(":")[2]);
    const content =
      source.nodes[id]?.type === "code" ? (mapped.querySelector("pre code") ?? mapped) : mapped;
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(content);
    prefix.setEnd(node, 0);
    const offset = prefix.toString().length;
    const slice = sourceTextSelection(
      source,
      id,
      content.textContent ?? "",
      offset + start,
      offset + end,
      decodeEntity,
    );
    if (!slice) return;
    const previous = selection.get(id);
    selection.set(
      id,
      previous
        ? {
            ...slice,
            start: Math.min(previous.start, slice.start),
            end: Math.max(previous.end, slice.end),
          }
        : slice,
    );
    node = walker.nextNode();
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-source]")) {
    const id = Number(element.dataset.source?.split(":")[2]);
    const node = source.nodes[id];
    if (!node || node.children.length || !range.intersectsNode(element)) continue;
    if (node.type === "text" || node.type === "inlineCode") continue;
    if (node.type === "code" && element.querySelector("pre")) continue;
    selection.set(id, { start: node.start, end: node.end });
  }
  return selectedMarkdown(source, selection) || undefined;
}

export function markdownClipboard(
  selection: Selection,
): { text: string; html: string } | undefined {
  if (selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!ancestor?.closest("[data-citation-source] [data-citation-text]")) return;
  const roots = ancestor.closest<HTMLElement>("[data-markdown-source]");
  if (!roots) return;
  const container = roots.ownerDocument.createElement("div");
  let fragment: Node = range.cloneContents();
  // cloneContents omits the common ancestor, including formatting around a partial word.
  for (
    let element: Element | null = ancestor;
    element && element !== roots;
    element = element.parentElement
  ) {
    if (!wrappers.has(element.tagName)) continue;
    const wrapper = element.cloneNode(false);
    wrapper.appendChild(fragment);
    fragment = wrapper;
  }
  container.appendChild(fragment);
  const soleCode = container.querySelector("pre");
  const codeOnly =
    ancestor.closest("pre") ||
    (soleCode && container.textContent?.trim() === soleCode.textContent?.trim());
  const text = codeOnly ? range.toString() : selectionMarkdown(range, roots);
  if (!text) return;
  for (const node of container.querySelectorAll(skipped)) node.remove();
  for (const node of container.querySelectorAll("*")) {
    for (const attribute of Array.from(node.attributes)) {
      if (
        attribute.name.startsWith("on") ||
        attribute.name === "id" ||
        attribute.name === "data-source"
      )
        node.removeAttribute(attribute.name);
    }
  }
  return { text, html: container.innerHTML };
}

export function copyAssistantSelection(event: ClipboardEvent, viewport: HTMLElement): void {
  const selection = viewport.ownerDocument.getSelection();
  if (!selection || !event.clipboardData || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!viewport.contains(range.startContainer) || !viewport.contains(range.endContainer)) return;
  const payload = markdownClipboard(selection);
  if (!payload) return;
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData("text/html", payload.html);
  event.preventDefault();
}
