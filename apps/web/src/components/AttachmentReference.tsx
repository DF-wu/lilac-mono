import { FileIcon } from "./FileIcon";
import { FileActions } from "./FileActions";
import { useState, type ReactNode } from "react";
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
    <FileActions
      disabled={!ready}
      target={{
        type: "resource",
        href,
        name: resource.name,
        mediaType: resource.mediaType,
        resourceId: resource.resourceId,
      }}
      onPreview={() => setOpen(true)}
    >
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
            <FileIcon name={resource.name} mediaType={resource.mediaType} />
          )}
          <span>{children}</span>
        </Button>
        {open ? (
          <ResourcePreview
            name={resource.name}
            href={href}
            kind={attachmentKind(resource.mediaType, resource.name)}
            target={{
              type: "resource",
              href,
              name: resource.name,
              mediaType: resource.mediaType,
              resourceId: resource.resourceId,
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    </FileActions>
  );
}
