import { RightPanelTabs } from "../src/components/FileViewer";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentPreviewBody,
  ReadyAttachment,
  attachmentKind,
  isMarkdownAttachment,
  isWithinContainedImage,
} from "../src/components/ResourcePreview";

describe("attachment viewer", () => {
  test("PDFs use the native browser viewer and keep download/open fallbacks", () => {
    expect(attachmentKind("application/pdf")).toBe("pdf");
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody name="notes.pdf" href="/api/resources/pdf" kind="pdf" />,
    );
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain('data="/api/resources/pdf"');
    expect(html).toContain("Open PDF in new tab");
    expect(html).toContain("Download notes.pdf");
    expect(html).not.toContain("Loading preview");
  });
  test("PDF filenames remain previewable when upload metadata has no specific media type", () => {
    expect(attachmentKind("", "notes.pdf")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "NOTES.PDF")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "archive.bin")).toBe("text");
    expect(attachmentKind("image/png", "notes.pdf")).toBe("image");
  });
  test("Markdown and MDX have raw/rendered controls without executing MDX", () => {
    for (const name of ["notes.md", "README.MARKDOWN", "demo.mdx"])
      expect(isMarkdownAttachment(name)).toBe(true);
    expect(isMarkdownAttachment("notes.md.txt")).toBe(false);
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="demo.mdx"
        href="/api/resources/md"
        kind="text"
        text={{
          status: "ready",
          text: "# Heading\n<script>window.secret = 1</script>\n<Component />",
          truncated: true,
        }}
      />,
    );
    expect(html).toContain('aria-label="Preview Markdown"');
    expect(html).toContain('aria-label="Word wrap"');
    expect(html).toContain("Showing the first 64 KB");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<Component");
  });
  test("image preview has copy/download and a fixed viewport independent of image content", () => {
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody name="image.png" href="/api/resources/image" kind="image" />,
    );
    expect(html).toContain("Copy image");
    expect(html).toContain("Download image.png");
    expect(html).toContain('data-ui="media-preview-viewport"');
    expect(html).toContain("Reset zoom");
    expect(html).toContain('draggable="false"');
    expect(html.indexOf('data-ui="media-preview-viewport"')).toBeLessThan(
      html.indexOf('data-ui="media-preview-toolbar"'),
    );
  });
});

test("image attachments use a thumbnail without a filename footer or default action row", () => {
  const html = renderToStaticMarkup(
    <ReadyAttachment
      data={{
        resourceId: "image",
        name: "image.png",
        mediaType: "image/png",
        size: 1024,
        state: "ready",
      }}
      href="/api/resources/image"
    />,
  );
  expect(html).toContain("attachment-image-card");
  expect(html).toContain('aria-label="Preview image.png"');
  expect(html).not.toContain("attachment-file-row");
  expect(html).not.toContain("Download image.png");
  expect(html).not.toContain("1 KB");
});

test("full-window previews keep the download footer available during loading and errors", () => {
  for (const text of [
    { status: "loading" } as const,
    { status: "error", message: "Text preview unavailable for this binary file." } as const,
  ]) {
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="file.bin"
        href="/api/resources/file"
        kind="text"
        text={text}
        fill
      />,
    );
    expect(html).toContain('data-fill="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Download file.bin"');
    expect(html.indexOf('role="status"')).toBeLessThan(
      html.indexOf('data-ui="attachment-preview-footer"'),
    );
  }
});

test("image hit testing excludes object-fit letterboxing and respects zoomed bounds", () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 };
  expect(isWithinContainedImage({ x: 210, y: 30 }, bounds, { width: 800, height: 400 })).toBe(
    false,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 800, height: 400 })).toBe(
    true,
  );
  expect(isWithinContainedImage({ x: 20, y: 220 }, bounds, { width: 400, height: 800 })).toBe(
    false,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 400, height: 800 })).toBe(
    true,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 0, height: 0 })).toBe(false);
  expect(
    isWithinContainedImage(
      { x: 210, y: 220 },
      { left: -100, top: -100, width: 800, height: 800 },
      { width: 800, height: 400 },
    ),
  ).toBe(true);
});

test("preview destination actions share the download footer for text and media", () => {
  for (const kind of ["text", "image", "pdf", "audio", "video"] as const) {
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="example"
        href="/api/resources/example"
        kind={kind}
        actions={<button>Open in right panel</button>}
        text={{ status: "ready", text: "source", truncated: false }}
      />,
    );
    expect(html.indexOf("Open in right panel")).toBeGreaterThan(
      html.indexOf('data-ui="attachment-preview-footer"'),
    );
    expect(html).toContain('aria-label="Download example"');
  }
});

test("saved file tabs defer their bodies until the panel and tab become active", () => {
  const tabs = {
    items: [
      { id: "agents", type: "agents" as const },
      {
        id: "file",
        type: "file" as const,
        target: { type: "path" as const, path: "/a.md", name: "a.md" },
      },
    ],
    activeId: "agents",
  };
  for (const visible of [true, false]) {
    const html = renderToStaticMarkup(
      <RightPanelTabs
        tabs={tabs}
        visible={visible}
        onFocus={() => {}}
        onClose={() => {}}
        onAgents={() => {}}
        renderTab={(tab) => <div>{`body:${tab.id}`}</div>}
      />,
    );
    expect(html.includes("body:agents")).toBe(visible);
    expect(html).not.toContain("body:file");
  }
});
