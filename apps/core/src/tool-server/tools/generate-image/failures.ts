import { errorMessage } from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Panic } from "better-result";

import { preserveToolPanic } from "../../../tools/tool-result-adapters";
import { generateFailure } from "../generate";

type FailureKind = ServerToolFailure["kind"];

/**
 * Maps a captured cause onto a `generate_<kind>` failure. Panics are defects
 * and keep propagating through the registered host adapter. Pass a function
 * when the kind depends on state at failure time, such as an abort signal.
 */
export function generateFailureFromCause(kind: FailureKind | (() => FailureKind)) {
  return (cause: Error | Panic): ServerToolFailure => {
    if (Panic.is(cause)) return preserveToolPanic(cause);
    return generateFailure(typeof kind === "function" ? kind() : kind, errorMessage(cause));
  };
}
