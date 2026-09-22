import { expect, test } from "bun:test";
import { referenceHref, parseReferenceHref, referencedConversations } from "./references";

test("reference URLs preserve exact session and message coordinates", () => {
  for (const target of [
    { surface: "native" as const, sessionId: "uuid-with-hyphens" },
    {
      surface: "discord" as const,
      sessionId: "123456789012345678",
      messageId: "987654321098765432",
    },
    { surface: "github" as const, sessionId: "owner/repo#45", messageId: "99" },
  ]) {
    const href = referenceHref(target);
    expect(parseReferenceHref(href)).toEqual(target);
    expect(parseReferenceHref(`https://chat.example${href}`, "https://chat.example")).toEqual(
      target,
    );
    expect(
      parseReferenceHref(`https://other.example${href}`, "https://chat.example"),
    ).toBeUndefined();
  }
  expect(parseReferenceHref("/?ref=unknown:123")).toBeUndefined();
  expect(parseReferenceHref("/?ref=native:")).toBeUndefined();
  expect(parseReferenceHref("/?ref=discord:123&message=../foo")).toBeUndefined();
});

test("agent references exclude code and deduplicate repeated targets", () => {
  const target = { surface: "native" as const, sessionId: "thread" };
  const link = `[thread](${referenceHref(target)})`;
  expect(
    referencedConversations(
      `${link} ${link}\n\`[code](/?ref=native%3Aother)\`\n\`\`\`md\n[code](/?ref=native%3Ahidden)\n\`\`\``,
    ),
  ).toEqual([target]);
});

test("unfinished fences, indented code and escaped link examples do not expand", () => {
  for (const text of [
    "```md\n[example](/?ref=native%3Ahidden)",
    "    [example](/?ref=native%3Ahidden)",
    "\\[example](/?ref=native%3Ahidden)",
  ])
    expect(referencedConversations(text)).toEqual([]);
});
