import { Result, type Result as ResultType } from "better-result";
import { RichRenderFailed } from "./rich-render-error";
import { memo, useEffect, useId, useState } from "react";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { diagramSourceAllowed } from "./markdown-policy";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: 32 * 1024,
  suppressErrorRendering: true,
});

export function sanitizeDiagram(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "a", "style", "animate", "set"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      if (
        value.includes("\\") ||
        (/url\s*\(/iu.test(value) && !/^url\(#[a-z\d_-]+\)$/iu.test(value))
      )
        element.removeAttribute(name);
    }
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}

export function renderDiagram(
  id: string,
  source: string,
): Promise<ResultType<string, RichRenderFailed>> {
  return Result.tryPromise({
    try: async () => sanitizeDiagram((await mermaid.render(id, source)).svg),
    catch: () => new RichRenderFailed({ message: "Diagram rendering is unavailable" }),
  });
}

export default memo(function Diagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-z\d]/giu, "");
  const [rendered, setRendered] = useState<{ source: string; svg: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!diagramSourceAllowed(source)) return;
    let active = true;
    async function render() {
      const result = await renderDiagram(`diagram-${id}`, source);
      if (!active) return;
      result.match({ ok: (svg) => setRendered({ source, svg }), err: () => setFailed(source) });
    }
    void render();
    return () => {
      active = false;
    };
  }, [id, source]);
  if (rendered?.source === source)
    return (
      <div
        className="markdown-diagram"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: rendered.svg }}
      />
    );
  return (
    <pre
      className="markdown-code"
      data-render-failed={failed === source || !diagramSourceAllowed(source) || undefined}
    >
      <code>{source}</code>
    </pre>
  );
});
