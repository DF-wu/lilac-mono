import { Component, memo, useCallback, useMemo, type ReactNode } from "react";
import { createMarkdownSource, registerMarkdownSource } from "../markdown-source";

import { MarkdownWrapContext } from "./markdown-layout";
import MarkdownContent from "./MarkdownContent";

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
  sourcePositions = false,
}: {
  text: string;
  wrap?: boolean;
  preserveLineBreaks?: boolean;
  sourcePositions?: boolean;
}) {
  const source = useMemo(
    () => (sourcePositions ? createMarkdownSource(text) : undefined),
    [sourcePositions, text],
  );
  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && source) registerMarkdownSource(element, source);
    },
    [source],
  );
  const fallback = <div className="markdown-source">{text}</div>;
  return (
    <div
      ref={register}
      className="markdown"
      data-wrap={wrap}
      data-markdown-source={source ? "" : undefined}
    >
      <MarkdownWrapContext value={wrap}>
        <RichRenderBoundary resetKey={text} fallback={fallback}>
          <MarkdownContent text={text} preserveLineBreaks={preserveLineBreaks} source={source} />
        </RichRenderBoundary>
      </MarkdownWrapContext>
    </div>
  );
});
