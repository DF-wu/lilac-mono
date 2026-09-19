import { useState, type ReactNode } from "react";
import { Globe } from "lucide-react";

export function faviconUrl(href: string | undefined): string | undefined {
  if (!href || !URL.canParse(href)) return undefined;
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return `${url.origin}/favicon.ico`;
}

export function LinkWithFavicon({ href, children }: { href?: string; children: ReactNode }) {
  const icon = faviconUrl(href);
  const [failedIcon, setFailedIcon] = useState<string>();
  return (
    <a className="markdown-link" href={href} target="_blank" rel="noopener noreferrer">
      {icon ? (
        <span className="link-favicon" aria-hidden="true">
          {failedIcon === icon ? (
            <Globe />
          ) : (
            <img
              src={icon}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailedIcon(icon)}
            />
          )}
        </span>
      ) : null}
      {children}
    </a>
  );
}
