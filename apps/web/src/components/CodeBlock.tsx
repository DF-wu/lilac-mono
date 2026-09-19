import { useState, type ReactNode } from "react";
import { Check, Code, Copy, FileCode, FileJson, Terminal, WrapText } from "lucide-react";
import { IconButton, attempt } from "./ui";
import "./message-presentation.css";

export function CodeLanguageIcon({ language }: { language: string }) {
  if (/^(bash|sh|shell|zsh|powershell|console)$/iu.test(language)) return <Terminal />;
  if (/^(json|jsonc|yaml|yml)$/iu.test(language)) return <FileJson />;
  if (/^(text|plaintext|txt)$/iu.test(language)) return <Code />;
  return <FileCode />;
}

export function CodeBlock({
  source,
  language,
  children,
}: {
  source: string;
  language: string;
  children?: ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  return (
    <div className="code-block" data-wrap={wrap}>
      <div className="code-toolbar">
        <span className="code-language" title={language}>
          <CodeLanguageIcon language={language} />
          <span>{language}</span>
        </span>
        <div className="code-actions">
          <IconButton label="Wrap code" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText />
          </IconButton>
          <IconButton
            label={copied ? "Copied code" : "Copy code"}
            onClick={() => {
              setCopyError(undefined);
              void attempt(
                async () => {
                  await navigator.clipboard.writeText(source);
                  setCopied(true);
                },
                () => setCopyError("Copy unavailable"),
              );
            }}
          >
            {copied ? <Check /> : <Copy />}
          </IconButton>
        </div>
      </div>
      {copyError ? (
        <span className="error-text" role="status">
          {copyError}
        </span>
      ) : null}
      <pre className="markdown-code" tabIndex={0} role="region" aria-label={`${language} code`}>
        <code>{children ?? source}</code>
      </pre>
    </div>
  );
}
