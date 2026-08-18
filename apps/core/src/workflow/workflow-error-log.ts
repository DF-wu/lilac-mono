import {
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  redactErrorTextForLog,
  type TaggedErrorLogProjection,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError } from "better-result";

export function formatWorkflowErrorForLog(
  error: Error,
): TaggedErrorLogProjection | { readonly errorMessage: string } {
  const formatted = Result.try({
    try: () => (TaggedError.is(error) ? formatTaggedErrorForLog(error) : null),
    catch: () => null,
  });
  const projection = formatted.match({ ok: (value) => value, err: () => null });
  if (projection) return projection;
  return {
    errorMessage: redactErrorTextForLog(opaqueErrorMessage(error, "Unknown workflow failure")),
  };
}
