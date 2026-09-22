import { markdownToAstProcessor, type MdRootContent, type unistLib } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";
import { KEYS, NodeApi, TextApi, type Descendant, type TText } from "platejs";
import remarkGfm from "remark-gfm";

type ComposerMarkdownNode = unistLib.Node & {
  children?: ComposerMarkdownNode[];
  url?: string;
  value?: string;
};

export function editableComposerLinks(resourceUrls?: ReadonlySet<string>) {
  return (tree: ComposerMarkdownNode, file: { toString(): string }) => {
    const source = file.toString();
    function visit(nodes: ComposerMarkdownNode[]) {
      for (const [index, node] of nodes.entries()) {
        if (node.type === "link") {
          if (node.url?.startsWith("attachment:") || (node.url && resourceUrls?.has(node.url)))
            continue;
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined)
            nodes[index] = { type: "text", value: source.slice(start, end) };
          continue;
        }
        if (node.children) visit(node.children);
      }
    }
    visit(tree.children ?? []);
  };
}

export function protectComposerLinks(editor: PlateEditor, value: Descendant[]) {
  const source = value.map((node) => NodeApi.string(node)).join("\n");
  let marker = "\uE000";
  while (source.includes(marker)) marker += "\uE000";
  const links: string[] = [];

  function protect(text: string) {
    if (!/[[<:@]|www\./.test(text)) return text;
    const tree = markdownToAstProcessor(editor, text, { remarkPlugins: [remarkGfm] });
    let end = 0;
    let result = "";
    function visit(nodes: MdRootContent[]) {
      for (const node of nodes) {
        if (node.type === "link") {
          const start = node.position?.start.offset;
          const next = node.position?.end.offset;
          if (start === undefined || next === undefined) continue;
          result += text.slice(end, start) + marker + links.length + marker;
          links.push(text.slice(start, next));
          end = next;
          continue;
        }
        if ("children" in node) visit(node.children);
      }
    }
    visit(tree.children);
    return result + text.slice(end);
  }

  function visit(nodes: Descendant[]) {
    for (const node of nodes) {
      if (TextApi.isText(node)) {
        const text: TText & { code?: boolean } = node;
        if (text.code) continue;
        text.text = protect(text.text);
        continue;
      }
      if (node.type === KEYS.a || node.type === KEYS.codeBlock) continue;
      visit(node.children);
    }
  }
  // Plate splits newlines before serializing text. Keep complete link syntax together until afterward.
  visit(value);
  const pattern = new RegExp(`${marker}(\\d+)${marker}`, "g");
  return (markdown: string) =>
    markdown.replace(pattern, (match, index: string) => links[Number(index)] ?? match);
}
