import { HTML_PREVIEW_BOOTSTRAP_MARKUP } from "@stanley2058/lilac-client-protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { loadHtmlFile } from "../resource-preview";
import { HtmlPreviewFrame, HtmlPreviewSkeleton } from "./HtmlPreview";

function htmlFilePreviewSrc(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.head.insertAdjacentHTML("afterbegin", HTML_PREVIEW_BOOTSTRAP_MARKUP);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>${document.documentElement.outerHTML}`)}`;
}

export function HtmlFilePreview({ href, name }: { href: string; name: string }) {
  const query = useQuery({
    queryKey: ["html-file-preview", href],
    queryFn: ({ signal }) => loadHtmlFile(href, signal),
    staleTime: 0,
    gcTime: 60_000,
  });
  const preview = useMemo(() => query.data?.map(htmlFilePreviewSrc), [query.data]);
  if (!preview) return <HtmlPreviewSkeleton />;
  return preview.match({
    ok: (src) => <HtmlPreviewFrame key={src} src={src} title={name} fill />,
    err: (error) => (
      <div className="grid place-content-center flex-1 p-4 text-danger text-sm" role="status">
        {error.message}
      </div>
    ),
  });
}
