import { lazy, Suspense, useState, useLayoutEffect, type ReactNode } from "react";
import { Eye, Code, WrapText } from "lucide-react";
import { IconButton } from "./ui";
import { Markdown } from "./Markdown";
import { fileLanguage, type FileTarget } from "../file-target";
import type { TextPreviewState } from "./ResourcePreview";
import "./file-viewer.css";

const FileCode = lazy(() => import("./FileCode"));

export function FileSource({
  name,
  text,
  line,
  endLine,
  navigation,
  heading,
}: {
  name: string;
  text: TextPreviewState;
  line?: number;
  endLine?: number;
  navigation?: FileTarget;
  heading?: ReactNode;
}) {
  const [wrap, setWrap] = useState(true);
  const [preview, setPreview] = useState(false);
  useLayoutEffect(() => {
    if (line) setPreview(false);
  }, [line, endLine, navigation]);
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  return (
    <div className="file-source">
      <div className="file-source-toolbar">
        {heading ? <div className="file-source-heading">{heading}</div> : null}
        {markdown ? (
          <IconButton
            label={preview ? "Show source" : "Preview Markdown"}
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? <Code /> : <Eye />}
          </IconButton>
        ) : null}
        {!preview ? (
          <IconButton label="Word wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText />
          </IconButton>
        ) : null}
      </div>
      {text.status === "loading" ? (
        <div className="file-status" role="status">
          Loading file…
        </div>
      ) : null}
      {text.status === "error" ? (
        <div className="file-status error-text" role="status">
          {text.message}
        </div>
      ) : null}
      {text.status === "ready" ? (
        <>
          {preview && markdown ? (
            <div className="file-markdown">
              <Markdown text={text.text} wrap />
            </div>
          ) : (
            <Suspense
              fallback={
                <pre className="file-code file-code-fallback" data-wrap={wrap}>
                  {text.text}
                </pre>
              }
            >
              <FileCode
                source={text.text}
                language={fileLanguage(name)}
                wrap={wrap}
                line={line}
                endLine={endLine}
                navigation={navigation}
              />
            </Suspense>
          )}
          {text.truncated ? <p className="file-notice">Showing the first 64 KB.</p> : null}
        </>
      ) : null}
    </div>
  );
}
