import type { FileTarget } from "../file-target";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ThemedToken } from "shiki/core";
import { loadCodeTokens } from "./rich-code";

export default memo(function FileCode({
  source,
  language,
  wrap,
  line,
  endLine,
  navigation,
}: {
  source: string;
  language: string;
  wrap: boolean;
  line?: number;
  endLine?: number;
  navigation?: FileTarget;
}) {
  const [highlighted, setHighlighted] = useState<{
    source: string;
    language: string;
    tokens: ThemedToken[][];
  }>();
  const fallback = useMemo(
    () => source.split("\n").map((content) => [{ content, offset: 0 }]),
    [source],
  );
  const lines =
    highlighted?.source === source && highlighted.language === language
      ? highlighted.tokens
      : fallback;
  const viewport = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 24,
    overscan: 12,
  });
  useEffect(() => {
    let canceled = false;
    void loadCodeTokens(source, language).then((result) =>
      result.match({
        ok: (tokens) => {
          if (!canceled) setHighlighted({ source, language, tokens });
        },
        err: () => {},
      }),
    );
    return () => {
      canceled = true;
    };
  }, [source, language]);
  useLayoutEffect(() => {
    virtual.scrollToIndex(Math.min(lines.length - 1, Math.max(0, (line ?? 1) - 1)), {
      align: line ? "center" : "start",
    });
  }, [source, line, endLine, navigation]);
  return (
    <div
      ref={viewport}
      className="file-code"
      data-wrap={wrap}
      tabIndex={0}
      role="region"
      aria-label="File contents"
    >
      <div className="file-code-lines" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtual.measureElement}
            data-index={row.index}
            data-line={row.index + 1}
            data-highlighted={
              line !== undefined && row.index + 1 >= line && row.index + 1 <= (endLine ?? line)
            }
            className="file-code-line"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <span className="file-line-number" aria-hidden="true">
              {row.index + 1}
            </span>
            <code>
              {lines[row.index]?.map((token: ThemedToken, index) => (
                <span
                  key={index}
                  style={{
                    color: token.color,
                    fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                    fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
                    textDecoration:
                      token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
              {"\n"}
            </code>
          </div>
        ))}
      </div>
      {line && line > lines.length ? (
        <p className="file-notice">Line {line} is outside this preview.</p>
      ) : null}
    </div>
  );
});
