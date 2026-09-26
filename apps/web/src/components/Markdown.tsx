import { Component, lazy, memo, Suspense, type ReactNode } from "react";

import { MarkdownWrapContext } from "./markdown-layout";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export class RichRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey?: string },
  { failed: boolean; resetKey?: string }
> {
  override state = { failed: false };
  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }
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
  preserveLineBreaks = false,
}: {
  text: string;
  wrap?: boolean;
  preserveLineBreaks?: boolean;
}) {
  const fallback = <div className="markdown-source">{text}</div>;
  return (
    <div className="markdown" data-wrap={wrap}>
      <MarkdownWrapContext value={wrap}>
        <RichRenderBoundary resetKey={text} fallback={fallback}>
          <Suspense fallback={fallback}>
            <MarkdownContent text={text} preserveLineBreaks={preserveLineBreaks} />
          </Suspense>
        </RichRenderBoundary>
      </MarkdownWrapContext>
    </div>
  );
});
