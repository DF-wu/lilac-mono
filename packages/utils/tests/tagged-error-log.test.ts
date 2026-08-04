import { describe, expect, it } from "bun:test";
import { TaggedError } from "better-result";

import { formatTaggedErrorForLog, redactErrorTextForLog } from "../index";

const ExternalFailure = TaggedError("ExternalFailure");

describe("formatTaggedErrorForLog", () => {
  it("redacts standalone canonical provider and AWS credential formats", () => {
    const credentials = [
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      `IQoJ${"A".repeat(96)}`,
    ] as const;

    for (const credential of credentials) {
      expect(redactErrorTextForLog(credential)).toBe("<redacted>");
    }
  });

  it("shows that raw TaggedError serialization exposes its cause", () => {
    const cause = new Error("database password=cause-secret");
    const error = new ExternalFailure({
      message: "external request failed",
      cause,
    });

    const rawJson = JSON.stringify(error.toJSON());

    expect(rawJson).toContain(cause.message);
    expect(rawJson).toContain('"cause"');
    expect(rawJson).toContain('"stack"');
  });

  it("returns only bounded, redacted tag and message fields", () => {
    const longTag = `ExternalFailure${"x".repeat(200)}`;
    const LongExternalFailure = TaggedError(longTag);
    const error = new LongExternalFailure({
      message: "request failed password=message-secret; details " + "x".repeat(2_000),
      cause: new Error("cause-secret-should-not-leak"),
      arbitraryField: "arbitrary-secret-should-not-leak",
    });

    const projection = formatTaggedErrorForLog(error);
    const serialized = JSON.stringify(projection);

    expect(Object.keys(projection)).toEqual(["errorTag", "errorMessage"]);
    expect(projection.errorTag.length).toBeLessThanOrEqual(128);
    expect(projection.errorMessage.length).toBeLessThanOrEqual(1_000);
    expect(projection.errorTag.endsWith("...")).toBe(true);
    expect(projection.errorMessage).toStartWith("request failed password=<redacted>; details ");
    expect(projection.errorMessage.endsWith("...")).toBe(true);
    expect(serialized).not.toContain("message-secret");
    expect(serialized).not.toContain("cause-secret-should-not-leak");
    expect(serialized).not.toContain("arbitrary-secret-should-not-leak");
    expect(serialized).not.toContain('"cause"');
    expect(serialized).not.toContain('"stack"');
    expect(serialized).not.toContain('"name"');
  });

  it("removes URL userinfo, query parameters, and fragments", () => {
    const error = new ExternalFailure({
      message:
        "request failed at https://url-user:url-password@example.com/path?token=query-secret&visible=query-value#fragment-secret",
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).toBe("request failed at https://example.com/path");
    expect(projection.errorMessage).not.toContain("url-user");
    expect(projection.errorMessage).not.toContain("url-password");
    expect(projection.errorMessage).not.toContain("query-secret");
    expect(projection.errorMessage).not.toContain("query-value");
    expect(projection.errorMessage).not.toContain("fragment-secret");
  });

  it("redacts Basic credentials", () => {
    const basicCredential = "dXNlcjpwYXNzd29yZA==";
    const error = new ExternalFailure({
      message: `upstream returned Authorization: Basic ${basicCredential}`,
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).not.toContain(basicCredential);
    expect(projection.errorMessage).toContain("<redacted>");
  });

  it("redacts AWS access-key-like values", () => {
    const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
    const sessionAccessKeyId = "ASIA1234567890ABCDEF";
    const error = new ExternalFailure({
      message: `AWS rejected ${accessKeyId} and ${sessionAccessKeyId}`,
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).not.toContain(accessKeyId);
    expect(projection.errorMessage).not.toContain(sessionAccessKeyId);
    expect(projection.errorMessage).toBe("AWS rejected <redacted> and <redacted>");
  });

  it("redacts quoted multi-word sensitive assignments", () => {
    const password = "correct horse battery staple";
    const secret = "alpha beta gamma";
    const token = "delta epsilon";
    const error = new ExternalFailure({
      message: `password="${password}"; "secret": "${secret}"; token='${token}'`,
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).not.toContain(password);
    expect(projection.errorMessage).not.toContain(secret);
    expect(projection.errorMessage).not.toContain(token);
    expect(projection.errorMessage).toBe(
      'password=<redacted>; "secret": <redacted>; token=<redacted>',
    );
  });

  it("redacts an unquoted multi-word password through a comma delimiter", () => {
    const password = "correct horse battery staple";
    const error = new ExternalFailure({
      message: `password=${password}, retry details remain visible`,
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).not.toContain(password);
    expect(projection.errorMessage).toBe("password=<redacted>, retry details remain visible");
  });

  it("redacts an unquoted multi-word secret through a semicolon delimiter", () => {
    const secret = "alpha beta gamma";
    const error = new ExternalFailure({
      message: `secret: ${secret}; status details remain visible`,
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).not.toContain(secret);
    expect(projection.errorMessage).toBe("secret: <redacted>; status details remain visible");
  });

  it("preserves text after newline and closing-brace delimiters", () => {
    const error = new ExternalFailure({
      message:
        "password=correct horse battery staple\nnewline remains visible\n" +
        "secret: alpha beta gamma} brace remains visible",
    });

    const projection = formatTaggedErrorForLog(error);

    expect(projection.errorMessage).toBe(
      "password=<redacted>\nnewline remains visible\nsecret: <redacted>} brace remains visible",
    );
  });

  it("redacts existing bearer and provider token forms", () => {
    const tokens = [
      "bearer-token-123456",
      "sk-abcdefghijk",
      "xoxb-1234567890-abcdefghij",
      "ghp_abcdefghijk",
      "github_pat_abcdefghijk",
      "AIzaabcdefghijk",
    ] as const;
    const error = new ExternalFailure({
      message: `Bearer ${tokens[0]} ${tokens.slice(1).join(" ")}`,
    });

    const projection = formatTaggedErrorForLog(error);

    for (const token of tokens) {
      expect(projection.errorMessage).not.toContain(token);
    }
    expect(projection.errorMessage).toBe(
      "Bearer <redacted> <redacted> <redacted> <redacted> <redacted> <redacted>",
    );
  });
});
