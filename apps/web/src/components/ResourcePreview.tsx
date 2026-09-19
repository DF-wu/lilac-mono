import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  Film,
  Music,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  X,
} from "lucide-react";
import { copyPreviewImage } from "../image-clipboard";
import { Markdown } from "./Markdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { loadResourcePreview } from "../resource-preview";
import { Button } from "./ui/button";
import {
  Attachment,
  AttachmentAction,
  AttachmentTitle,
  AttachmentDescription,
} from "./ui/attachment";
import { IconButton } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./message-presentation.css";
import "./resource-preview.css";

type ResourceData = Extract<DisplayPart, { type: "data-resource" }>["data"];
export type AttachmentKind = "image" | "video" | "audio" | "text" | "pdf";
export function attachmentKind(mediaType: string, name = ""): AttachmentKind {
  const genericType = mediaType === "" || mediaType === "application/octet-stream";
  if (mediaType === "application/pdf" || (genericType && /\.pdf$/iu.test(name))) return "pdf";
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
  const kind = attachmentKind(data.mediaType, data.name);
  let icon = <FileText />;
  if (kind === "video") icon = <Film />;
  if (kind === "audio") icon = <Music />;
  return (
    <Attachment
      className={kind === "image" ? "attachment-image-card" : "attachment-card"}
      state={failed ? "error" : "done"}
    >
      {kind === "image" ? (
        <Button
          type="button"
          variant="ghost"
          className="attachment-image-thumbnail"
          aria-label={`Preview ${data.name}`}
          onClick={() => setPreview(true)}
        >
          {failed ? (
            <span className="attachment-image-unavailable" role="status">
              <ImageOff />
              <span>Image unavailable</span>
            </span>
          ) : (
            <img
              src={href}
              alt={data.name}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          )}
        </Button>
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
      {kind !== "image" ? (
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
      ) : null}
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

export function isMarkdownAttachment(name: string): boolean {
  return /\.(?:md|markdown|mdx)$/iu.test(name);
}

function PreviewDownload({ name, href }: { name: string; href: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      nativeButton={false}
      render={<a href={href} download={name} />}
      aria-label={`Download ${name}`}
      title={`Download ${name}`}
    >
      <Download />
    </Button>
  );
}

function PreviewFrame({
  children,
  toolbar,
  note,
  fill = false,
}: {
  children: ReactNode;
  toolbar: ReactNode;
  note?: ReactNode;
  fill?: boolean;
}) {
  return (
    <div className="attachment-preview-body" data-fill={fill}>
      <div className="attachment-preview-stage">{children}</div>
      <div className="attachment-preview-footer">
        {note}
        <div className="media-preview-toolbar">{toolbar}</div>
      </div>
    </div>
  );
}

function PreviewStatus({ children }: { children: ReactNode }) {
  return (
    <div className="attachment-preview-empty" role="status">
      {children}
    </div>
  );
}

function TextAttachmentPreview({
  name,
  href,
  text,
  fill = false,
}: {
  name: string;
  href: string;
  text?: TextPreviewState;
  fill?: boolean;
}) {
  const download = <PreviewDownload name={name} href={href} />;
  if (text?.status === "error")
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <PreviewStatus>
          <p className="error-text">{text.message}</p>
        </PreviewStatus>
      </PreviewFrame>
    );
  if (text?.status !== "ready")
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <PreviewStatus>Loading preview…</PreviewStatus>
      </PreviewFrame>
    );
  const raw = (
    <pre
      className="attachment-text-preview"
      tabIndex={0}
      role="region"
      aria-label={`${name} contents`}
    >
      {text.text}
    </pre>
  );
  const note = text.truncated ? (
    <p className="attachment-preview-note">
      Preview limited to 64 KB.{" "}
      <a href={href} download={name}>
        Download full file
      </a>
    </p>
  ) : null;
  if (!isMarkdownAttachment(name))
    return (
      <PreviewFrame fill={fill} toolbar={download} note={note}>
        {raw}
      </PreviewFrame>
    );
  return (
    <Tabs
      defaultValue="rendered"
      className="attachment-preview-body attachment-preview-tabs"
      data-fill={fill}
    >
      <TabsContent value="rendered" className="attachment-preview-stage">
        <div
          className="attachment-rendered-preview"
          tabIndex={0}
          role="region"
          aria-label={`${name} rendered contents`}
        >
          <Markdown text={text.text} wrap />
        </div>
      </TabsContent>
      <TabsContent value="raw" className="attachment-preview-stage">
        {raw}
      </TabsContent>
      <div className="attachment-preview-footer">
        {note}
        <div className="media-preview-toolbar">
          <TabsList>
            <TabsTrigger value="rendered">Rendered</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>
          {download}
        </div>
      </div>
    </Tabs>
  );
}

export function AttachmentPreviewBody({
  name,
  href,
  kind,
  text,
  fill = false,
}: {
  name: string;
  href: string;
  kind: AttachmentKind;
  text?: TextPreviewState;
  fill?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  const [copyError, setCopyError] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function startPan(event: PointerEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (
      pan.current ||
      kind !== "image" ||
      event.button !== 0 ||
      (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)
    )
      return;
    event.preventDefault();
    pan.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const origin = pan.current;
    if (!origin || origin.id !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = origin.left + origin.x - event.clientX;
    event.currentTarget.scrollTop = origin.top + origin.y - event.clientY;
  }
  function stopPan(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.id !== event.pointerId) return;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }
  const previewImage = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element || kind !== "image") return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => Math.min(4, Math.max(0.25, current + (event.deltaY < 0 ? 0.1 : -0.1))));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [kind, failed]);
  const changeZoom = (amount: number) =>
    setZoom((current) => Math.min(4, Math.max(0.25, current + amount)));
  async function copyImage() {
    const image = previewImage.current;
    if (!image) return;
    setCopyState("copying");
    setCopyError(undefined);
    const copied = await copyPreviewImage(image);
    copied.match({
      ok: () => setCopyState("copied"),
      err: (error) => {
        setCopyState("idle");
        setCopyError(error.message);
      },
    });
  }
  const download = <PreviewDownload name={name} href={href} />;
  if (kind === "text")
    return <TextAttachmentPreview name={name} href={href} text={text} fill={fill} />;
  if (failed)
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <PreviewStatus>
          <p className="error-text">This file is unavailable.</p>
        </PreviewStatus>
      </PreviewFrame>
    );
  if (kind === "pdf")
    return (
      <PreviewFrame
        fill={fill}
        toolbar={
          <>
            <Button
              variant="ghost"
              size="icon"
              nativeButton={false}
              render={<a href={href} target="_blank" rel="noreferrer" />}
              aria-label="Open PDF in new tab"
              title="Open PDF in new tab"
            >
              <ExternalLink />
            </Button>
            {download}
          </>
        }
      >
        <object
          className="attachment-pdf-preview"
          data={href}
          type="application/pdf"
          aria-label={`${name} PDF preview`}
        >
          <PreviewStatus>
            Your browser cannot display this PDF.{" "}
            <a href={href} download={name}>
              Download {name}
            </a>
          </PreviewStatus>
        </object>
      </PreviewFrame>
    );
  if (kind === "audio")
    return (
      <PreviewFrame fill={fill} toolbar={download}>
        <div className="attachment-audio-preview">
          <audio
            src={href}
            controls
            autoPlay={false}
            preload="metadata"
            aria-label={name}
            onError={() => setFailed(true)}
          />
        </div>
      </PreviewFrame>
    );
  return (
    <PreviewFrame
      fill={fill}
      note={
        copyError ? (
          <p className="error-text" role="status">
            {copyError}
          </p>
        ) : null
      }
      toolbar={
        <>
          {kind === "image" ? (
            <>
              <IconButton
                label="Zoom out"
                disabled={zoom <= 0.25}
                onClick={() => changeZoom(-0.25)}
              >
                <ZoomOut />
              </IconButton>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(0.25)}>
                <ZoomIn />
              </IconButton>
              <IconButton label="Reset zoom" onClick={() => setZoom(1)}>
                <RotateCcw />
              </IconButton>
              <IconButton
                label={copyState === "copied" ? "Image copied" : "Copy image"}
                disabled={!loaded || copyState === "copying"}
                onClick={() => {
                  void copyImage();
                }}
              >
                {copyState === "copied" ? <Check /> : <Copy />}
              </IconButton>
            </>
          ) : null}
          {download}
        </>
      }
    >
      <div
        ref={viewport}
        className="media-preview-viewport"
        tabIndex={0}
        role="region"
        aria-label={`${name} preview`}
        data-pan-enabled={kind === "image" && zoom > 1}
        data-dragging={dragging}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
        onLostPointerCapture={stopPan}
      >
        <div
          className="media-preview-content"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
        >
          {kind === "image" ? (
            <img
              ref={previewImage}
              src={href}
              alt={name}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
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
    </PreviewFrame>
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="resource-preview-dialog" showCloseButton={false}>
        <header className="resource-preview-header">
          <DialogTitle className="resource-preview-title" title={name}>
            {name}
          </DialogTitle>
          <IconButton label="Close preview" className="resource-preview-close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <AttachmentPreviewBody key={href} name={name} href={href} kind={kind} text={text} fill />
      </DialogContent>
    </Dialog>
  );
}
