import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KEYS, NodeApi } from "platejs";
import ComposerEditor, {
  createComposerEditor,
  composerMarkdown,
  composerPrefix,
  composerPlainText,
  insertComposerCompletion,
  insertComposerAttachment,
  composerSubmissionMarkdown,
  remapComposerAttachments,
  resolveComposerAttachments,
  attachmentSize,
} from "../src/components/composer-editor";

it("round trips basic rich Markdown through draft text", () => {
  const markdown =
    "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```";
  const editor = createComposerEditor(markdown);
  const serialized = composerMarkdown(editor);
  expect(serialized).toBe(markdown);
  expect(composerMarkdown(createComposerEditor(serialized))).toBe(serialized);
  expect(editor.children[0]?.type).toBe(KEYS.h1);
  expect(editor.children[1]?.children[0]).toMatchObject({ text: "bold", bold: true });
  expect(editor.children[2]).toMatchObject({ listStyleType: "disc" });
  expect(editor.children.at(-1)).toMatchObject({ type: KEYS.codeBlock, lang: "ts" });
});

it("inserts a completion at the selected rich-text range without flattening marks or suffixes", () => {
  const editor = createComposerEditor("**Keep** $Rev later");
  editor.tf.select({ path: [0, 1], offset: 5 });
  expect(composerPrefix(editor)).toBe("Keep $Rev");
  insertComposerCompletion(editor, "$Review", 4);
  expect(composerMarkdown(editor)).toBe("**Keep** $Review  later");
  expect(editor.children[0]?.children[0]).toMatchObject({ bold: true, text: "Keep" });
});

it("preserves command separators and trailing spaces through completion and draft restore", () => {
  const editor = createComposerEditor("/fi");
  editor.tf.select(editor.api.end([])!);
  insertComposerCompletion(editor, "/fixture-status", 3);
  expect(composerMarkdown(editor)).toBe("/fixture-status ");
  const restored = createComposerEditor(composerMarkdown(editor));
  expect(NodeApi.string(restored)).toBe("/fixture-status ");
  expect(composerMarkdown(restored)).toBe("/fixture-status ");
});

it("does not offer completion for a range or code-block content", () => {
  const editor = createComposerEditor("```\n$review\n```");
  editor.tf.select(editor.api.end([])!);
  expect(composerPrefix(editor)).toBe("");
  const prose = createComposerEditor("$review");
  prose.tf.select({ anchor: prose.api.start([])!, focus: prose.api.end([])! });
  expect(composerPrefix(prose)).toBe("");
});

it("keeps completion identities and custom arguments independent of Markdown escaping", () => {
  const skill = createComposerEditor("$my_skill");
  expect(composerMarkdown(skill)).toBe("$my\\_skill");
  expect(composerPlainText(skill)).toBe("$my_skill");
  const slashSkill = createComposerEditor("/skill:my_skill next");
  expect(composerPlainText(slashSkill)).toBe("/skill:my_skill next");
  const command = createComposerEditor("/my_command argument_with_underscores");
  expect(composerPlainText(command)).toBe("/my_command argument_with_underscores");
  expect(composerPlainText(createComposerEditor(composerMarkdown(command)))).toBe(
    "/my_command argument_with_underscores",
  );
});

it("keeps an empty or cleared editor empty on the wire", () => {
  const editor = createComposerEditor();
  expect(composerMarkdown(editor)).toBe("");
  expect(composerPlainText(editor)).toBe("");
  editor.tf.insertText("test");
  editor.tf.select({ anchor: editor.api.start([])!, focus: editor.api.end([])! });
  editor.tf.delete();
  expect(composerMarkdown(editor)).toBe("");
});

it("keeps multiline editor semantics while announcing completion options", () => {
  const noop = () => {};
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      createElement(ComposerEditor, {
        text: "$review",
        disabled: false,
        placeholder: "Message",
        onText: noop,
        onPlainText: noop,
        onPrefix: noop,
        onKeyDown: noop,
        onPaste: noop,
        expanded,
        activeDescendant: expanded ? "completion-0" : undefined,
      }),
    );
  const expanded = render(true);
  expect(expanded).toContain('role="textbox" aria-multiline="true"');
  expect(expanded).toContain('aria-autocomplete="list"');
  expect(expanded).toContain('aria-controls="composer-completions"');
  expect(expanded).toContain('aria-activedescendant="completion-0"');
  expect(expanded).not.toContain('aria-expanded="true"');
  const closed = render(false);
  expect(closed).not.toContain('aria-controls="composer-completions"');
  expect(closed).not.toContain('aria-activedescendant="completion-0"');
});

it("inserts a file reference at the caret and restores its position without flattening Markdown", () => {
  const editor = createComposerEditor("**Compare**  with the earlier image");
  editor.tf.select({ path: [0, 1], offset: 1 });
  insertComposerAttachment(editor, {
    key: "image-one",
    file: new File(["image"], "screen.png", { type: "image/png" }),
  });
  expect(composerMarkdown(editor)).toBe(
    "**Compare** [screen.png](attachment:image-one)  with the earlier image",
  );
  const restored = createComposerEditor(composerMarkdown(editor));
  expect(composerMarkdown(restored)).toBe(composerMarkdown(editor));
  expect(composerPlainText(restored)).toBe("Compare screen.png  with the earlier image");
  expect(composerSubmissionMarkdown(restored)).toBe(
    "**Compare** screen.png  with the earlier image",
  );
});

it("remaps only file references when a local draft moves to a server thread", () => {
  const markdown =
    "See [notes.txt](attachment:old-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```";
  const remapped = remapComposerAttachments(markdown, new Map([["old-key", "new-key"]]));
  expect(remapped).toBe(
    "See [notes.txt](attachment:new-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
  expect(composerSubmissionMarkdown(createComposerEditor(remapped))).toBe(
    "See notes.txt and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
});

it("keeps attachment-only drafts sendable and handles Markdown characters in filenames", () => {
  const editor = createComposerEditor();
  insertComposerAttachment(editor, { key: "special-file", file: new File([""], "my_[draft].txt") });
  const markdown = composerMarkdown(editor);
  const restored = createComposerEditor(markdown);
  expect(composerPlainText(restored)).toBe("my_[draft].txt ");
  expect(composerSubmissionMarkdown(restored)).not.toContain("attachment:");
  expect(markdown).not.toContain("\u200b");
  expect(composerSubmissionMarkdown(restored)).not.toContain("\u200b");
  expect(composerMarkdown(restored)).toBe(markdown);
});

it("renders inline thumbnails, file size and accessible remove and retry controls", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(ComposerEditor, {
      text: "Review [image.png](attachment:image)",
      attachments: [
        {
          key: "image",
          file: new File([new Uint8Array(1536)], "image.png", { type: "image/png" }),
          preview: "blob:preview",
          reservation: Promise.resolve(undefined),
          progress: 0,
          state: "failed",
          error: "Upload failed",
        },
      ],
      disabled: false,
      placeholder: "Message",
      onText: noop,
      onPlainText: noop,
      onPrefix: noop,
      onKeyDown: noop,
      onPaste: noop,
      expanded: false,
    }),
  );
  expect(html).toContain('class="composer-attachment-chip"');
  expect(html).toContain('src="blob:preview"');
  expect(html).toContain("2 KB");
  expect(html).toContain('aria-label="Remove image.png"');
  expect(html).toContain('aria-label="Retry image.png"');
  expect(html).not.toContain('title="Upload failed"');
  expect(html).toContain('data-slot="tooltip-trigger"');
  expect(attachmentSize(512)).toBe("512 B");
  expect(attachmentSize(1572864)).toBe("1.5 MB");
});

it("separates an inserted file name from adjacent prose", () => {
  const editor = createComposerEditor("Review");
  editor.tf.select(editor.api.end([])!);
  insertComposerAttachment(editor, { key: "file", file: new File(["text"], "notes.txt") });
  expect(composerSubmissionMarkdown(editor)).toBe("Review notes.txt ");
});

it("resolves duplicate file names by their attachment identities and leaves code literal", () => {
  const source =
    "First [same.png](attachment:first), then [same.png](attachment:second). `literal [same.png](attachment:first)`";
  const sent = resolveComposerAttachments(
    source,
    new Map([
      ["first", "upload-one"],
      ["second", "upload-two"],
    ]),
  );
  expect(sent).toBe(
    "First [same.png](/api/resources/upload-one), then [same.png](/api/resources/upload-two). `literal [same.png](attachment:first)`",
  );
  expect(resolveComposerAttachments("[missing.txt](attachment:missing)", new Map())).toBe(
    "missing.txt",
  );
  expect(
    resolveComposerAttachments(
      "[safe.txt](attachment:known)",
      new Map([["known", "id/with space"]]),
    ),
  ).toBe("[safe.txt](/api/resources/id%2Fwith%20space)");
});

it("preserves file references through local draft remapping before resource reservation", () => {
  const local = "Compare [image.png](attachment:local-key)";
  const moved = remapComposerAttachments(local, new Map([["local-key", "upload-key"]]));
  expect(resolveComposerAttachments(moved, new Map([["upload-key", "reserved-id"]]))).toBe(
    "Compare [image.png](/api/resources/reserved-id)",
  );
});
