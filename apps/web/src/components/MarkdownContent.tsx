import { createContext, useContext, lazy, memo, Suspense, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { RichRenderBoundary } from "./Markdown";
import { LinkWithFavicon } from "./LinkWithFavicon";
import { CodeBlock } from "./CodeBlock";
import { markdownUrl } from "./markdown-policy";

const HighlightedCode = lazy(() => import("./rich-code"));
const Diagram = lazy(() => import("./rich-diagram"));
const MathExpression = lazy(() => import("./rich-math"));
const plugins = [remarkGfm, remarkMath];

function RichBlock({ source, language }: { source: string; language: string }) {
  const fallback = <CodeBlock source={source} language={language} />;
  let content = <HighlightedCode source={source} language={language} />;
  if (language === "mermaid") content = <Diagram source={source} />;
  if (language === "math") content = <MathExpression source={source} display />;
  return (
    <RichRenderBoundary key={`${language}:${source}`} fallback={fallback}>
      <Suspense fallback={fallback}>{content}</Suspense>
    </RichRenderBoundary>
  );
}

function Pre({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
  const classes = code.properties.className;
  const language = Array.isArray(classes)
    ? classes.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  const source = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/u, "");
  return (
    <RichBlock
      source={source}
      language={typeof language === "string" ? language.slice(9) : "text"}
    />
  );
}

const TaskLabel = createContext("Task");
function taskText(node: NonNullable<ExtraProps["node"]>["children"][number]): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element" || node.tagName === "input") return "";
  return node.children.map(taskText).join("");
}
function ListItem({ node, children, ...props }: ComponentProps<"li"> & ExtraProps) {
  const label = node?.children.map(taskText).join("").trim() || "Task";
  return (
    <TaskLabel.Provider value={label}>
      <li {...props}>{children}</li>
    </TaskLabel.Provider>
  );
}
function TaskCheckbox({ checked }: ComponentProps<"input">) {
  const label = useContext(TaskLabel);
  return <input type="checkbox" checked={checked} disabled aria-label={label} />;
}

const components: Components = {
  pre: Pre,
  li: ListItem,
  input: TaskCheckbox,
  code: ({ className, children }) => {
    if (!className?.includes("math-inline")) return <code className={className}>{children}</code>;
    const source = typeof children === "string" ? children : "";
    const fallback = <code>{source}</code>;
    return (
      <RichRenderBoundary key={source} fallback={fallback}>
        <Suspense fallback={fallback}>
          <MathExpression source={source} display={false} />
        </Suspense>
      </RichRenderBoundary>
    );
  },
  a: ({ children, href }) => <LinkWithFavicon href={href}>{children}</LinkWithFavicon>,
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
  ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
};

export default memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      components={components}
      urlTransform={markdownUrl}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  );
});
