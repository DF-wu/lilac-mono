import type { AnyTaggedError } from "better-result";

const MAX_ERROR_TAG_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/giu;
const SENSITIVE_QUOTED_ASSIGNMENT_RE =
  /((?:["'])?(?:authorization|api[_-]?key|token|secret|password|cookie|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key))(?:["'])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/giu;
const SENSITIVE_ASSIGNMENT_RE =
  /((?:authorization|api[_-]?key|token|secret|password|cookie|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key))\s*[:=]\s*)([^\r\n,;}]+)/giu;
const AUTHORIZATION_TOKEN_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/_=-]+/giu;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const CREDENTIAL_TOKEN_RE =
  /\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{8,}\b/gu;

export type TaggedErrorLogProjection = {
  readonly errorTag: string;
  readonly errorMessage: string;
};

function redactUrl(raw: string): string {
  if (!URL.canParse(raw)) return "<redacted-url>";

  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactAndBound(value: string, limit: number): string {
  const redacted = value
    .replace(URL_RE, redactUrl)
    .replace(SENSITIVE_QUOTED_ASSIGNMENT_RE, "$1<redacted>")
    .replace(AUTHORIZATION_TOKEN_RE, "$1 <redacted>")
    .replace(SENSITIVE_ASSIGNMENT_RE, "$1<redacted>")
    .replace(AWS_ACCESS_KEY_RE, "<redacted>")
    .replace(CREDENTIAL_TOKEN_RE, "<redacted>");

  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 3)}...`;
}

export function formatTaggedErrorForLog(error: AnyTaggedError): TaggedErrorLogProjection {
  return {
    errorTag: redactAndBound(error._tag, MAX_ERROR_TAG_LENGTH),
    errorMessage: redactAndBound(error.message, MAX_ERROR_MESSAGE_LENGTH),
  };
}
