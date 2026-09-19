import { useEffect, useRef, useState } from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import { Download, FileText, Film, Music, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { loadResourcePreview } from "../resource-preview";
import { Button } from "./ui/button";
import {
  Attachment,
  AttachmentAction,
  AttachmentTitle,
  AttachmentDescription,
} from "./ui/attachment";
import { IconButton, Modal } from "./ui";
import "./message-presentation.css";

type ResourceData = Extract<DisplayPart, { type: "data-resource" }>["data"];
export type AttachmentKind = "image" | "video" | "audio" | "text";
export function attachmentKind(mediaType: string): AttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "text";
}
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReadyAttachment({ data, href }: { data: ResourceData; href: string }) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const kind = attachmentKind(data.mediaType);
  let icon = <FileText />;
  if (kind === "video") icon = <Film />;
  if (kind === "audio") icon = <Music />;
  return (
    <Attachment className="attachment-card" state={failed ? "error" : "done"}>
      {kind === "image" && !failed ? (
        <button
          type="button"
          className="attachment-thumbnail"
          aria-label={`Preview ${data.name}`}
          onClick={() => setPreview(true)}
        >
          <img
            src={href}
            alt={data.name}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </button>
      ) : null}
      {kind === "video" ? (
        <button
          type="button"
          className="attachment-thumbnail"
          aria-label={`Preview ${data.name}`}
          onClick={() => setPreview(true)}
        >
          <video src={href} preload="metadata" muted playsInline aria-label={data.name} />
          <Film className="attachment-video-icon" />
        </button>
      ) : null}
      {kind === "audio" ? (
        <audio
          className="attachment-audio"
          src={href}
          preload="none"
          controls
          aria-label={data.name}
        />
      ) : null}
      <div className="attachment-file-row">
        <Button
          variant="ghost"
          className="attachment-open"
          onClick={() => setPreview(true)}
          aria-label={`Preview ${data.name}`}
        >
          {icon}
          <span>
            <AttachmentTitle className="attachment-name">{data.name}</AttachmentTitle>
            <AttachmentDescription className="attachment-size">
              {formatFileSize(data.size)}
            </AttachmentDescription>
          </span>
        </Button>
        <AttachmentAction
          className="attachment-download"
          size="icon"
          nativeButton={false}
          render={<a href={href} download={data.name} target="_blank" rel="noreferrer" />}
          aria-label={`Download ${data.name}`}
          title={`Download ${data.name}`}
        >
          <Download />
        </AttachmentAction>
      </div>
      {failed ? <span className="error-text">This file is unavailable.</span> : null}
      {preview ? (
        <ResourcePreview
          name={data.name}
          href={href}
          kind={kind}
          onClose={() => setPreview(false)}
        />
      ) : null}
    </Attachment>
  );
}

export type TextPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; truncated: boolean };

export function AttachmentPreviewBody({
  name,
  href,
  kind,
  text,
}: {
  name: string;
  href: string;
  kind: AttachmentKind;
  text?: TextPreviewState;
}) {
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => Math.min(4, Math.max(0.25, current + (event.deltaY < 0 ? 0.1 : -0.1))));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [kind, failed]);
  const changeZoom = (amount: number) =>
    setZoom((current) => Math.min(4, Math.max(0.25, current + amount)));
  if (kind === "text") {
    if (text?.status === "error")
      return (
        <p className="error-text" role="status">
          {text.message}
        </p>
      );
    if (text?.status !== "ready") return <p role="status">Loading preview…</p>;
    return (
      <>
        <pre
          className="attachment-text-preview"
          tabIndex={0}
          role="region"
          aria-label={`${name} contents`}
        >
          {text.text}
        </pre>
        {text.truncated ? (
          <p className="attachment-preview-note">
            Preview limited to 64 KB.{" "}
            <a href={href} download={name}>
              Download full file
            </a>
          </p>
        ) : null}
      </>
    );
  }
  if (failed)
    return (
      <p className="error-text" role="status">
        This file is unavailable.
      </p>
    );
  if (kind === "audio")
    return (
      <audio
        src={href}
        controls
        autoPlay={false}
        preload="metadata"
        aria-label={name}
        onError={() => setFailed(true)}
      />
    );
  return (
    <>
      <div className="media-preview-toolbar">
        <IconButton label="Zoom out" disabled={zoom <= 0.25} onClick={() => changeZoom(-0.25)}>
          <ZoomOut />
        </IconButton>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(0.25)}>
          <ZoomIn />
        </IconButton>
        <IconButton label="Reset zoom" onClick={() => setZoom(1)}>
          <RotateCcw />
        </IconButton>
      </div>
      <div
        ref={viewport}
        className="media-preview-viewport"
        tabIndex={0}
        role="region"
        aria-label={`${name} preview`}
      >
        <div className="media-preview-content" style={{ width: `${zoom * 100}%` }}>
          {kind === "image" ? (
            <img src={href} alt={name} onError={() => setFailed(true)} />
          ) : (
            <video
              src={href}
              controls
              preload="metadata"
              aria-label={name}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </div>
    </>
  );
}

export function ResourcePreview({
  name,
  href,
  kind,
  onClose,
}: {
  name: string;
  href: string;
  kind: AttachmentKind;
  onClose: () => void;
}) {
  const [text, setText] = useState<TextPreviewState>({ status: "loading" });
  useEffect(() => {
    if (kind !== "text") return;
    const controller = new AbortController();
    async function load() {
      const result = await loadResourcePreview(href, controller.signal);
      if (controller.signal.aborted) return;
      result.match({
        ok: (value) => setText({ status: "ready", text: value.text, truncated: value.truncated }),
        err: (error) => setText({ status: "error", message: error.message }),
      });
    }
    void load();
    return () => controller.abort();
  }, [href, kind]);
  return (
    <Modal title={name} onClose={onClose} wide>
      <AttachmentPreviewBody key={href} name={name} href={href} kind={kind} text={text} />
    </Modal>
  );
}
