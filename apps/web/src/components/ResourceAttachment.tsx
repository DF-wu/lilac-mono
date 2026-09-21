import { FileIcon } from "./FileIcon";
import { useMessageServices } from "./message-services";
import { useRef, useState } from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import { useUploadProgress } from "../upload-context";
import { Button } from "./ui/button";
import { attempt } from "./ui";
import { ReadyAttachment } from "./ResourcePreview";
import "./message-presentation.css";

export function ResourceAttachment({
  part,
}: {
  part: Extract<DisplayPart, { type: "data-resource" }>;
}) {
  const { resourceUrl, upload, canEdit } = useMessageServices();
  const [recovery, setRecovery] = useState<{ progress: number; active: boolean; error?: string }>({
    progress: 0,
    active: false,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const { data } = part;
  const local = useUploadProgress(data.resourceId);
  if (data.state !== "ready")
    return (
      <div className="resource flex-wrap">
        <FileIcon name={data.name} mediaType={data.mediaType} />
        <span>{data.name}</span>
        <span>{recovery.error ?? local?.error ?? data.error ?? data.state}</span>
        {canEdit && local?.state === "failed" && local.retry ? (
          <Button
            type="button"
            variant="ghost"
            className="text-primary py-2 px-3 text-sm"
            onClick={local.retry}
          >
            Retry upload
          </Button>
        ) : null}
        {canEdit && upload && !local && data.state !== "canceled" ? (
          <>
            <input
              type="file"
              ref={fileInput}
              className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap"
              tabIndex={-1}
              aria-label={`Resume upload of ${data.name}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.name !== data.name || file.size !== data.size) {
                  setRecovery({
                    active: false,
                    progress: 0,
                    error: "Choose the original file with the same name and size.",
                  });
                  return;
                }
                setRecovery({ active: true, progress: 0 });
                void attempt(
                  async () => {
                    await upload(data.resourceId, file, (progress) =>
                      setRecovery({ active: true, progress }),
                    );
                    setRecovery({ active: false, progress: 1 });
                  },
                  () =>
                    setRecovery({
                      active: false,
                      progress: 0,
                      error: "Upload failed. Select the file to retry.",
                    }),
                );
              }}
            />
            <Button
              type="button"
              variant="ghost"
              className="text-primary py-2 px-3 text-sm"
              disabled={recovery.active}
              onClick={() => fileInput.current?.click()}
            >
              Resume upload
            </Button>
          </>
        ) : null}
        {data.state === "pending" || recovery.active ? (
          <progress
            value={recovery.active ? recovery.progress : (local?.progress ?? data.progress)}
            max={1}
            aria-label={`Uploading ${data.name}`}
          />
        ) : null}
      </div>
    );
  return <ReadyAttachment key={data.resourceId} data={data} href={resourceUrl(data.resourceId)} />;
}
