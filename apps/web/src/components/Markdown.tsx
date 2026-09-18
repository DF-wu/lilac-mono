import { Component, lazy, memo, Suspense, type ReactNode } from "react";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export class RichRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const fallback = <div className="markdown-source">{text}</div>;
  return (
    <div className="markdown">
      <RichRenderBoundary key={text} fallback={fallback}>
        <Suspense fallback={fallback}>
          <MarkdownContent text={text} />
        </Suspense>
      </RichRenderBoundary>
    </div>
  );
});
