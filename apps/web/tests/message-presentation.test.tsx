import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreviewBody } from "../src/components/ResourcePreview";
import { MarkdownWrapContext } from "../src/components/markdown-layout";
import { CodeBlock } from "../src/components/CodeBlock";
import { faviconUrl } from "../src/components/LinkWithFavicon";
import { initials } from "../src/components/ActorAvatar";
import { Message } from "../src/components/Timeline";
import { MessageIdentityContext } from "../src/components/message-identity";
import { MessageResourcesContext, type MessageResource } from "../src/components/message-resources";
import MarkdownContent from "../src/components/MarkdownContent";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";

describe("message presentation", () => {
  test("bubbles use participant and agent names with avatar fallback", () => {
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{
          agent: { displayName: "Lilac" },
          users: new Map([["owner-id", { displayName: "Stanley Wang" }]]),
        }}
      >
        <Message
          message={{
            id: "m1",
            role: "user",
            metadata: { authorId: "owner-id" },
            parts: [{ type: "text", text: "Hello" }],
          }}
          resourceUrl={(id) => `/api/resources/${id}`}
          canEdit
          onAction={() => {}}
          onReaction={() => {}}
        />
      </MessageIdentityContext>,
    );
    expect(html).toContain('data-slot="bubble"');
    expect(html).toContain('aria-label="Stanley Wang"');
    expect(html).not.toContain("owner-id");
    expect(initials("Stanley Wang")).toBe("SW");
    expect(initials("  ")).toBe("?");
    expect(initials("🦊 Fox")).toBe("🦊F");
  });
  test("only the viewer is right aligned and text uses the matching message card", () => {
    for (const [role, authorId, self] of [
      ["user", "viewer", true],
      ["user", "other", false],
      ["assistant", "lilac", false],
    ] as const) {
      const message: DisplayMessage = {
        id: "message",
        role,
        metadata: { authorId, createdAt: 1_700_000_000_000 },
        parts: [{ type: "text", text: "Visible content" }],
      };
      const html = renderToStaticMarkup(
        <MessageIdentityContext
          value={{ viewerId: "viewer", agent: { displayName: "Lilac" }, users: new Map() }}
        >
          <Message
            message={message}
            resourceUrl={(id) => `/api/resources/${id}`}
            canEdit
            onAction={() => {}}
            onReaction={() => {}}
          />
        </MessageIdentityContext>,
      );
      expect(html).toContain(`data-slot="message" data-align="${self ? "end" : "start"}"`);
      expect(html).toContain('data-slot="bubble"');
      expect(html).toContain('aria-label="Copy message"');
      const controls = html.slice(html.indexOf('class="message-controls"'));
      const timeIndex = controls.indexOf("<time");
      const copyIndex = controls.indexOf('aria-label="Copy message"');
      expect(self ? timeIndex < copyIndex : copyIndex < timeIndex).toBe(true);
      expect(html.indexOf('data-slot="message-avatar"')).toBeLessThan(
        html.indexOf('data-slot="message-content"'),
      );
    }
  });
  test("user images precede text and files follow it in one bubble", () => {
    const html = renderToStaticMarkup(
      <Message
        message={{
          id: "m2",
          role: "user",
          parts: [
            {
              type: "data-resource",
              id: "r1",
              data: {
                resourceId: "file",
                name: "note.txt",
                mediaType: "text/plain",
                size: 10,
                state: "ready",
              },
            },
            { type: "text", text: "See the attached notes." },
            {
              type: "data-resource",
              id: "r2",
              data: {
                resourceId: "image",
                name: "photo.png",
                mediaType: "image/png",
                size: 100,
                state: "ready",
              },
            },
            {
              type: "data-resource",
              id: "r3",
              data: {
                resourceId: "image2",
                name: "other.png",
                mediaType: "image/png",
                size: 100,
                state: "ready",
              },
            },
          ],
        }}
        resourceUrl={(id) => `/api/resources/${id}`}
        canEdit
        onAction={() => {}}
        onReaction={() => {}}
      />,
    );
    expect(html.match(/data-slot="bubble"/gu)).toHaveLength(1);
    expect(html.indexOf('class="message-attachments message-image-attachments"')).toBeLessThan(
      html.indexOf("See the attached notes."),
    );
    expect(html.indexOf('aria-label="Preview other.png"')).toBeLessThan(
      html.indexOf("See the attached notes."),
    );
    expect(html.indexOf("See the attached notes.")).toBeLessThan(
      html.indexOf('class="message-attachments"'),
    );
    expect(html.indexOf('data-slot="bubble-content"')).toBeLessThan(
      html.indexOf('class="message-attachments"'),
    );
  });
  test("assistant attachment cards preserve activity and compaction boundaries", () => {
    const resource = (id: string, image: boolean): DisplayPart => ({
      type: "data-resource",
      id,
      data: {
        resourceId: id,
        name: `${id}.${image ? "png" : "txt"}`,
        mediaType: image ? "image/png" : "text/plain",
        size: 10,
        state: "ready",
      },
    });
    const html = renderToStaticMarkup(
      <Message
        message={{
          id: "assistant-mixed",
          role: "assistant",
          parts: [
            resource("file-a", false),
            { type: "text", text: "First segment" },
            resource("image-a", true),
            {
              type: "data-activity",
              id: "tool",
              data: { kind: "tool", label: "Boundary tool", state: "complete" },
            },
            resource("file-b", false),
            resource("image-b", true),
            { type: "text", text: "Second segment" },
            { type: "data-compaction", id: "compaction", data: { state: "complete" } },
            { type: "text", text: "Third segment" },
            resource("file-c", false),
            resource("image-c", true),
          ],
        }}
        resourceUrl={(id) => `/api/resources/${id}`}
        canEdit
        onAction={() => {}}
        onReaction={() => {}}
      />,
    );
    expect(html.match(/data-slot="bubble"/gu)).toHaveLength(3);
    const order = [
      'aria-label="Preview image-a.png"',
      "First segment",
      'aria-label="Preview file-a.txt"',
      "Boundary tool",
      'aria-label="Preview image-b.png"',
      "Second segment",
      'aria-label="Preview file-b.txt"',
      "Context compaction",
      'aria-label="Preview image-c.png"',
      "Third segment",
      'aria-label="Preview file-c.txt"',
    ];
    for (let index = 1; index < order.length; index++) {
      expect(html.indexOf(order[index - 1]!)).toBeGreaterThan(-1);
      expect(html.indexOf(order[index - 1]!)).toBeLessThan(html.indexOf(order[index]!));
    }
  });
  test("only message-associated attachment references become preview chips", () => {
    const resource: MessageResource = {
      resourceId: "known",
      name: "note.txt",
      mediaType: "text/plain",
      size: 10,
      state: "ready",
    };
    const html = renderToStaticMarkup(
      <MessageResourcesContext
        value={new Map([["/api/resources/known", { resource, href: "/api/resources/known" }]])}
      >
        <MarkdownContent text="Review [note.txt](/api/resources/known) and [other.txt](/api/resources/unknown)." />
      </MessageResourcesContext>,
    );
    expect(html).toContain('aria-label="Preview note.txt"');
    expect(html).not.toContain('aria-label="Preview other.txt"');
    expect(html).toContain('href="/api/resources/unknown"');
    expect(html).not.toContain('href="/api/resources/known"');
  });
  test("code retains plain source and accessible copy/wrap controls before highlighting", () => {
    const html = renderToStaticMarkup(<CodeBlock source={'echo "<script>"'} language="bash" />);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('aria-label="Wrap code"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  test("favicon URLs use only HTTP origins and drop paths, query and credentials", () => {
    expect(faviconUrl("https://user:password@example.com/a?private=1#x")).toBe(
      "https://example.com/favicon.ico",
    );
    for (const href of [
      "mailto:a@example.com",
      "javascript:alert(1)",
      "file:///x",
      "/relative",
      undefined,
    ])
      expect(faviconUrl(href)).toBeUndefined();
  });
  test("file preview renders bounded text literally and exposes binary errors", () => {
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="source.ts"
        href="/api/resources/id"
        kind="text"
        text={{ status: "ready", text: "<script>untrusted</script>", truncated: true }}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Download full file");
    expect(html).not.toContain("<script>");
    const error = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="file.bin"
        href="/api/resources/id"
        kind="text"
        text={{ status: "error", message: "Text preview is unavailable for this binary file." }}
      />,
    );
    expect(error).toContain('role="status"');
    expect(error).toContain("binary file");
  });
});

test("file preview code stays wrapped while chat code retains its wrap control", () => {
  const wrapped = renderToStaticMarkup(
    <MarkdownWrapContext value={true}>
      <CodeBlock source="const longLine = 'content';" language="typescript" />
    </MarkdownWrapContext>,
  );
  expect(wrapped).toContain('data-wrap="true"');
  expect(wrapped).not.toContain('aria-label="Wrap code"');
  expect(wrapped).toContain('aria-label="Copy code"');
  const chat = renderToStaticMarkup(<CodeBlock source="code" language="text" />);
  expect(chat).toContain('aria-label="Wrap code"');
});
