import { Result, type Result as ResultType } from "better-result";
import { RichRenderFailed } from "./rich-render-error";
import { memo, useEffect, useState } from "react";
import { createCssVariablesTheme, createHighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "shiki/langs/typescript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import html from "shiki/langs/html.mjs";
import css from "shiki/langs/css.mjs";
import bash from "shiki/langs/bash.mjs";
import python from "shiki/langs/python.mjs";
import yaml from "shiki/langs/yaml.mjs";

const highlighter = createHighlighterCore({
  themes: [
    createCssVariablesTheme({
      name: "native",
      variablePrefix: "--syntax-",
      variableDefaults: {
        foreground: "var(--foreground)",
        background: "transparent",
        "token-constant": "var(--primary)",
        "token-string": "var(--foreground)",
        "token-comment": "var(--muted-foreground)",
        "token-keyword": "var(--primary)",
        "token-parameter": "var(--foreground)",
        "token-function": "var(--primary)",
        "token-string-expression": "var(--foreground)",
        "token-punctuation": "var(--muted-foreground)",
        "token-link": "var(--primary)",
      },
    }),
  ],
  langs: [typescript, tsx, javascript, json, html, css, bash, python, yaml],
  engine: createJavaScriptRegexEngine(),
});
const cache = new Map<string, Promise<ThemedToken[][]>>();
const MAX_SOURCE = 128 * 1024;

export function highlightCode(source: string, language: string): Promise<ThemedToken[][]> {
  if (source.length > MAX_SOURCE) return renderTokens(source, "text");
  const key = `${language}\u0000${source}`;
  const previous = cache.get(key);
  if (previous) return previous;
  const task = renderTokens(source, language);
  cache.set(key, task);
  if (cache.size > 64) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return task;
}

async function renderTokens(source: string, language: string): Promise<ThemedToken[][]> {
  if (source.length > MAX_SOURCE || ["", "text", "plaintext", "txt"].includes(language))
    return source.split("\n").map((content) => [{ content, offset: 0 }]);
  const instance = await highlighter;
  let resolved = language.toLowerCase();
  if (!instance.getLoadedLanguages().includes(resolved)) {
    const { bundledLanguagesInfo } = await import("shiki/langs");
    const entry = bundledLanguagesInfo.find(
      (item) => item.id === resolved || item.aliases?.includes(resolved),
    );
    if (!entry) return source.split("\n").map((content) => [{ content, offset: 0 }]);
    await instance.loadLanguage(entry.import);
    resolved = entry.id;
  }
  return instance.codeToTokens(source, { lang: resolved, theme: "native" }).tokens;
}

export function loadCodeTokens(
  source: string,
  language: string,
): Promise<ResultType<ThemedToken[][], RichRenderFailed>> {
  return Result.tryPromise({
    try: () => highlightCode(source, language),
    catch: () => new RichRenderFailed({ message: "Code highlighting is unavailable" }),
  });
}

export default memo(function HighlightedCode({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const [rendered, setRendered] = useState<{
    source: string;
    language: string;
    tokens: ThemedToken[][];
  } | null>(null);
  useEffect(() => {
    let active = true;
    async function render() {
      const result = await loadCodeTokens(source, language);
      if (!active) return;
      result.match({
        ok: (tokens) => setRendered({ source, language, tokens }),
        err: () => setRendered(null),
      });
    }
    void render();
    return () => {
      active = false;
    };
  }, [source, language]);
  if (rendered?.source !== source || rendered.language !== language)
    return (
      <pre className="markdown-code">
        <code>{source}</code>
      </pre>
    );
  return (
    <pre className="markdown-code">
      <code>
        {rendered.tokens.map((line, lineIndex) => (
          <span key={lineIndex}>
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                style={{
                  color: token.color,
                  fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                  fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
                  textDecoration: token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
                }}
              >
                {token.content}
              </span>
            ))}
            {lineIndex < rendered.tokens.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
});
