import { describe, expect, it } from "bun:test";

import {
  isRecentGithubSelfAuthoredIssueComment,
  rememberGithubSelfAuthoredIssueComment,
} from "../../src/github/github-state";
import { parseIssueCommentTrigger } from "../../src/github/webhook/github-webhook-server";

const BOT_LOGINS = ["catalinna-df[bot]", "DF-wu"] as const;

describe("github issue comment trigger parsing", () => {
  it("parses a leading /lilac command and preserves following lines", () => {
    const parsed = parseIssueCommentTrigger(
      "/lilac inspect this\n\nKeep the stack trace in the reply.",
      BOT_LOGINS,
    );

    expect(parsed).toEqual({
      kind: "lilac",
      commandText: "inspect this\nKeep the stack trace in the reply.",
    });
  });

  it("parses a leading mention command and strips only the trigger mention", () => {
    const parsed = parseIssueCommentTrigger(
      "@catalinna-df[bot] please review\n\nFocus on the webhook path.",
      BOT_LOGINS,
    );

    expect(parsed).toEqual({
      kind: "mention",
      login: "catalinna-df[bot]",
      commandText: "please review\nFocus on the webhook path.",
    });
  });

  it("ignores quoted lines before evaluating the first real trigger line", () => {
    const parsed = parseIssueCommentTrigger(
      "> @catalinna-df[bot] old trigger\n> /lilac old trigger\n\n@catalinna-df[bot] new trigger",
      BOT_LOGINS,
    );

    expect(parsed).toEqual({
      kind: "mention",
      login: "catalinna-df[bot]",
      commandText: "new trigger",
    });
  });

  it("does not trigger on fenced code that contains bot mentions or /lilac", () => {
    const parsed = parseIssueCommentTrigger(
      [
        "In reply to 4152921803:",
        "",
        "```md",
        "@catalinna-df[bot] hi",
        "/lilac inspect this issue",
        "```",
      ].join("\n"),
      BOT_LOGINS,
    );

    expect(parsed).toBeNull();
  });

  it("does not trigger when a later line mentions the bot after normal prose", () => {
    const parsed = parseIssueCommentTrigger(
      "I am summarizing the previous attempt.\n\n@catalinna-df[bot] this should not retrigger.",
      BOT_LOGINS,
    );

    expect(parsed).toBeNull();
  });
});

describe("github self-authored issue comment tracking", () => {
  it("remembers recent self-authored issue comments", () => {
    const commentId = 9_000_001;
    rememberGithubSelfAuthoredIssueComment(commentId);

    expect(isRecentGithubSelfAuthoredIssueComment(commentId)).toBe(true);
  });

  it("expires remembered self-authored issue comments after ttl", () => {
    const commentId = 9_000_002;
    rememberGithubSelfAuthoredIssueComment(commentId, -1);

    expect(isRecentGithubSelfAuthoredIssueComment(commentId)).toBe(false);
  });
});
