import { useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { MessageResource } from "./message-resources";
import { ResourcePreview, attachmentKind } from "./ResourcePreview";
import { Button } from "./ui/button";

export function AttachmentReference({
  href,
  resource,
  children,
}: {
  href: string;
  resource: MessageResource;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const ready = resource.state === "ready";
  const image = ready && resource.mediaType.startsWith("image/") && !imageFailed;
  return (
    <span className="sent-attachment-reference">
      <Button
        type="button"
        variant="secondary"
        className="sent-attachment-chip"
        disabled={!ready}
        aria-label={`Preview ${resource.name}`}
        onClick={() => setOpen(true)}
      >
        {image ? (
          <img
            src={href}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <FileText />
        )}
        <span>{children}</span>
      </Button>
      {open ? (
        <ResourcePreview
          name={resource.name}
          href={href}
          kind={attachmentKind(resource.mediaType)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}
