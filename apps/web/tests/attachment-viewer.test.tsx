import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentPreviewBody,
  ReadyAttachment,
  attachmentKind,
  isMarkdownAttachment,
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
    expect(html).toContain('role="tab"');
    expect(html).toContain("Rendered");
    expect(html).toContain("Raw");
    expect(html).toContain("Preview limited to 64 KB");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<Component");
  });
  test("image preview has copy/download and a fixed viewport independent of image content", () => {
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody name="image.png" href="/api/resources/image" kind="image" />,
    );
    expect(html).toContain("Copy image");
    expect(html).toContain("Download image.png");
    expect(html).toContain('class="media-preview-viewport"');
    expect(html).toContain("Reset zoom");
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
