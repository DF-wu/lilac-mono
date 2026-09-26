import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { queryNativeRPC, useNativeOnline } from "../queries";
import { useOptionalWorkspace } from "../workspace-context";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

type LinkPreview = NativeRpcOutputs["links"]["preview"];

export function previewUrl(href: string | undefined): string | undefined {
  if (!href || !URL.canParse(href)) return undefined;
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.href.length > 8192) return undefined;
  url.hash = "";
  return url.href;
}

export function faviconUrl(href: string | undefined): string | undefined {
  if (!href || !URL.canParse(href)) return undefined;
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return `${url.origin}/favicon.ico`;
}

function localPreview(url: string): LinkPreview | undefined {
  if (typeof document === "undefined" || new URL(url).origin !== location.origin) return undefined;
  return {
    title: "Lilac",
    icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href,
  };
}

function LinkIcon({ icon, fallback }: { icon?: string; fallback?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const src = [icon, fallback].find((candidate) => candidate && !failed.includes(candidate));
  return (
    <span className="link-favicon" aria-hidden="true">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((previous) => [...previous, src])}
        />
      ) : (
        <Globe />
      )}
    </span>
  );
}

export function LinkPreviewBody({
  hostname,
  preview,
  loading,
}: {
  hostname: string;
  preview?: LinkPreview;
  loading?: boolean;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  return (
    <div
      className="flex flex-col gap-2.5"
      data-slot="link-preview"
      aria-busy={loading || undefined}
    >
      {preview?.title ? (
        <div className="line-clamp-2 font-medium wrap-anywhere">{preview.title}</div>
      ) : null}
      {loading ? (
        <div className="text-xs text-muted-foreground" role="status">
          Loading preview…
        </div>
      ) : null}
      {preview?.description ? (
        <p className="line-clamp-3 text-sm text-muted-foreground wrap-anywhere">
          {preview.description}
        </p>
      ) : null}
      {preview?.image && failedImage !== preview.image ? (
        <img
          src={preview.image}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          className="aspect-video w-full rounded-md bg-muted object-contain"
          onError={() => setFailedImage(preview.image)}
        />
      ) : null}
      <div className="truncate text-xs text-muted-foreground">{hostname}</div>
    </div>
  );
}

export function LinkPreviewAnchor({
  href,
  children,
  preview,
  loading,
  anchorRef,
  onOpen,
}: {
  href: string;
  children: ReactNode;
  preview?: LinkPreview;
  loading?: boolean;
  anchorRef?: React.RefObject<HTMLAnchorElement | null>;
  onOpen?: () => void;
}) {
  return (
    <HoverCard
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <HoverCardTrigger
        ref={anchorRef}
        className="markdown-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        delay={450}
      >
        <LinkIcon icon={preview?.icon} fallback={faviconUrl(href)} />
        {children}
      </HoverCardTrigger>
      <HoverCardContent>
        <LinkPreviewBody hostname={new URL(href).hostname} preview={preview} loading={loading} />
      </HoverCardContent>
    </HoverCard>
  );
}

function ResolvedLink({
  href,
  url,
  children,
  client,
}: {
  href: string;
  url: string;
  children: ReactNode;
  client: NativeClient;
}) {
  const online = useNativeOnline(client);
  const anchor = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const local = localPreview(url);
  useEffect(() => {
    if (!anchor.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [url]);
  const preview = useQuery({
    queryKey: ["link-preview", url],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.links.preview({ url }, { signal })),
    enabled: visible && !local && online,
    staleTime: 30 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <LinkPreviewAnchor
      href={href}
      preview={local ?? preview.data}
      loading={!local && preview.isFetching}
      anchorRef={anchor}
      onOpen={() => setVisible(true)}
    >
      {children}
    </LinkPreviewAnchor>
  );
}

export function LinkWithFavicon({ href, children }: { href?: string; children: ReactNode }) {
  const workspace = useOptionalWorkspace();
  const url = previewUrl(href);
  if (workspace && href && url)
    return (
      <ResolvedLink key={url} href={href} url={url} client={workspace.client}>
        {children}
      </ResolvedLink>
    );
  return (
    <a className="markdown-link" href={href} target="_blank" rel="noopener noreferrer">
      {faviconUrl(href) ? <LinkIcon fallback={faviconUrl(href)} /> : null}
      {children}
    </a>
  );
}
