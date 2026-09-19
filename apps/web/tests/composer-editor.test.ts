import { expect, it } from "bun:test";
import { KEYS, NodeApi } from "platejs";
import {
  createComposerEditor,
  composerMarkdown,
  composerPrefix,
  composerPlainText,
  insertComposerCompletion,
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
