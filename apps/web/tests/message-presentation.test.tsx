import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreviewBody } from "../src/components/ResourcePreview";
import { CodeBlock } from "../src/components/CodeBlock";
import { faviconUrl } from "../src/components/LinkWithFavicon";
import { initials } from "../src/components/ActorAvatar";
import { Message } from "../src/components/Timeline";
import { MessageIdentityContext } from "../src/components/message-identity";

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
  test("code retains plain source and accessible copy/wrap controls before highlighting", () => {
    const html = renderToStaticMarkup(<CodeBlock source={'echo "<script>"'} language="bash" />);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('aria-label="Wrap code"');
    expect(html).toContain('aria-pressed="false"');
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
