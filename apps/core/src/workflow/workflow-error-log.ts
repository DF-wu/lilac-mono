import {
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  redactErrorTextForLog,
  type TaggedErrorLogProjection,
} from "@stanley2058/lilac-utils";
import { TaggedError } from "better-result";

export function formatWorkflowErrorForLog(
  error: Error,
): TaggedErrorLogProjection | { readonly errorMessage: string } {
  try {
    if (TaggedError.is(error)) return formatTaggedErrorForLog(error);
  } catch {
    // Logging must never replace the workflow failure being reported.
  }
  return {
    errorMessage: redactErrorTextForLog(opaqueErrorMessage(error, "Unknown workflow failure")),
  };
}
