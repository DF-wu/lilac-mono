import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";

type RemarkPlugin = Extract<
  NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

function currencyMarkers(tree: MarkdownNode, source: string): number[] {
  const offsets: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type !== "inlineMath") {
      node.children?.forEach(visit);
      return;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = source.slice(start, end);
    if (raw.startsWith("$$")) return;
    const closesBeforeAmount = /\d/u.test(source[end] ?? "");
    if (!/^\$\s|\s\$$/u.test(raw) && !closesBeforeAmount) return;
    offsets.push(start);
    if (closesBeforeAmount) offsets.push(end - 1);
  };
  visit(tree);
  return offsets;
}

export const remarkChatMath: RemarkPlugin = function () {
  return (tree: MarkdownNode, file: { toString(): string }) => {
    let source = file.toString();
    let parsed = tree;
    while (true) {
      const offsets = currencyMarkers(parsed, source);
      if (!offsets.length) break;
      for (const offset of offsets.toSorted((left, right) => right - left)) {
        source = `${source.slice(0, offset)}\\${source.slice(offset)}`;
      }
      // Reparse the document so emphasis and links spanning currency markers stay intact.
      parsed = this.parse(source);
    }
    tree.children = parsed.children;
  };
};
