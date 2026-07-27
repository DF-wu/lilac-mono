import { describe, expect, it } from "bun:test";

import { formatBlockedMessage, redactSecrets } from "../../src/tools/bash-safety/format";

describe("bash output redaction", () => {
  it("redacts dynamically injected tool environment values wherever they appear", () => {
    expect(redactSecrets("before arbitrary-token after", ["arbitrary-token"])).toBe(
      "before <redacted> after",
    );
  });

  it("ignores empty values and redacts overlapping values longest-first", () => {
    expect(redactSecrets("token-long token", ["", "token", "token-long"])).toBe(
      "<redacted> <redacted>",
    );
  });

  it("redacts sensitive query parameters in quoted and unquoted callback URLs", () => {
    const input = [
      "curl http://localhost/callback?code=plain-code&state=plain-state&other=visible",
      `curl 'https://example.test/callback?token=quoted-token&key=quoted-key'`,
      `curl "https://example.test/callback?secret=quoted-secret#done"`,
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).toContain(
      "http://localhost/callback?code=<redacted>&state=<redacted>&other=visible",
    );
    expect(redacted).toContain("'https://example.test/callback?token=<redacted>&key=<redacted>'");
    expect(redacted).toContain('"https://example.test/callback?secret=<redacted>#done"');
    expect(redacted).not.toContain("plain-code");
    expect(redacted).not.toContain("plain-state");
    expect(redacted).not.toContain("quoted-token");
    expect(redacted).not.toContain("quoted-key");
    expect(redacted).not.toContain("quoted-secret");
  });

  it("redacts callback query secrets from blocked command and segment text", () => {
    const message = formatBlockedMessage({
      reason: "test block",
      command: "curl 'http://localhost/callback?code=command-code&state=command-state'",
      segment: "http://localhost/callback?token=segment-token",
      redact: redactSecrets,
    });

    expect(message).toContain("code=<redacted>&state=<redacted>");
    expect(message).toContain("token=<redacted>");
    expect(message).not.toContain("command-code");
    expect(message).not.toContain("command-state");
    expect(message).not.toContain("segment-token");
  });
});
