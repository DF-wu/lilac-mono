import { Component, lazy, memo, Suspense, type ReactNode } from "react";

import { MarkdownWrapContext } from "./markdown-layout";

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

export const Markdown = memo(function Markdown({
  text,
  wrap = false,
}: {
  text: string;
  wrap?: boolean;
}) {
  const fallback = <div className="markdown-source">{text}</div>;
  return (
    <div className="markdown" data-wrap={wrap}>
      <MarkdownWrapContext value={wrap}>
        <RichRenderBoundary key={text} fallback={fallback}>
          <Suspense fallback={fallback}>
            <MarkdownContent text={text} />
          </Suspense>
        </RichRenderBoundary>
      </MarkdownWrapContext>
    </div>
  );
});
