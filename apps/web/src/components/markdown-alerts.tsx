import type { ComponentProps } from "react";
import type { AllowElement, ExtraProps } from "react-markdown";
import { Info, Lightbulb, MessageSquareWarning, TriangleAlert, OctagonAlert } from "lucide-react";

type MarkdownParent = NonNullable<Parameters<AllowElement>[2]>;

export function githubAlerts() {
  return (tree: MarkdownParent) => {
    for (const node of tree.children) {
      if (node.type !== "element" || node.tagName !== "blockquote") continue;
      const paragraph = node.children.find((child) => child.type === "element");
      if (paragraph?.type !== "element" || paragraph.tagName !== "p") continue;
      const first = paragraph.children[0];
      if (first?.type !== "text") continue;
      const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i.exec(
        first.value,
      );
      if (!marker) continue;
      const next = paragraph.children[1];
      const hardBreak =
        !marker[0].endsWith("\n") && next?.type === "element" && next.tagName === "br";
      if (!marker[0].endsWith("\n") && next && !hardBreak) continue;
      node.properties["data-github-alert"] = marker[1]!.toLowerCase();
      first.value = first.value.slice(marker[0].length);
      if (!first.value) paragraph.children.shift();
      if (hardBreak) paragraph.children.shift();
      if (!paragraph.children.length) node.children.splice(node.children.indexOf(paragraph), 1);
    }
  };
}

function alertPresentation(kind: string) {
  switch (kind) {
    case "note":
      return { title: "Note", Icon: Info };
    case "tip":
      return { title: "Tip", Icon: Lightbulb };
    case "important":
      return { title: "Important", Icon: MessageSquareWarning };
    case "warning":
      return { title: "Warning", Icon: TriangleAlert };
    case "caution":
      return { title: "Caution", Icon: OctagonAlert };
    default:
      return undefined;
  }
}

export function MarkdownBlockquote({ node, children }: ComponentProps<"blockquote"> & ExtraProps) {
  const kind = node?.properties["data-github-alert"];
  const alert = typeof kind === "string" ? alertPresentation(kind) : undefined;
  if (!alert) return <blockquote>{children}</blockquote>;
  return (
    <div className="markdown-alert" data-alert={kind}>
      <p className="markdown-alert-title">
        <alert.Icon aria-hidden="true" />
        {alert.title}
      </p>
      {children}
    </div>
  );
}
