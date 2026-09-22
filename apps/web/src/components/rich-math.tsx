import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkMath from "remark-math";
import rehypeMathjax from "rehype-mathjax";

type MathTree = Parameters<ReturnType<typeof rehypeMathjax>>[0];
type MathChild = MathTree["children"][number];
const tags = new Set([
  "p",
  "pre",
  "code",
  "mjx-container",
  "svg",
  "g",
  "path",
  "defs",
  "use",
  "rect",
  "line",
  "polygon",
  "polyline",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "title",
  "desc",
  "span",
]);
const attributes = new Set([
  "className",
  "xmlns",
  "width",
  "height",
  "viewBox",
  "role",
  "focusable",
  "ariaHidden",
  "ariaLabel",
  "d",
  "fill",
  "stroke",
  "strokeWidth",
  "transform",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "points",
  "id",
  "dataMmlNode",
  "dataC",
  "fontSize",
  "fontFamily",
  "textAnchor",
  "preserveAspectRatio",
]);

function cleanMathNode(node: MathChild): boolean {
  if (node.type === "text") return true;
  if (node.type !== "element" || !tags.has(node.tagName)) return false;
  for (const key of Object.keys(node.properties)) {
    const value = node.properties[key];
    if (
      key === "style" &&
      typeof value === "string" &&
      /^vertical-align:\s*-?\d+(?:\.\d+)?(?:ex|em|px);?$/u.test(value)
    )
      continue;
    if (attributes.has(key) && !(typeof value === "string" && /url\s*\(/iu.test(value))) continue;
    delete node.properties[key];
  }
  node.children = node.children.filter(cleanMathNode);
  return true;
}

export function sanitizeMathTree() {
  return (tree: MathTree) => {
    tree.children = tree.children.filter(cleanMathNode);
  };
}

const remarkPlugins = [remarkMath];
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [
  [
    rehypeMathjax,
    {
      tex: { packages: ["base", "ams", "newcommand"], maxBuffer: 8192, maxMacros: 100 },
      svg: { fontCache: "none" },
    },
  ],
  sanitizeMathTree,
];

export default memo(function MathExpression({
  source,
  display,
}: {
  source: string;
  display: boolean;
}) {
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <>{children}</>,
      svg: ({ node: _node, ...props }) => <svg {...props} role="img" aria-label={source} />,
    }),
    [source],
  );
  if (source.length > 8192) return <code>{source}</code>;
  const text = display ? `$$\n${source}\n$$` : `$${source}$`;
  return (
    <span className={display ? "markdown-math markdown-math-display" : "markdown-math"}>
      <ReactMarkdown
        components={components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </span>
  );
});
