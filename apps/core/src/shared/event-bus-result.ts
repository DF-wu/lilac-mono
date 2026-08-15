import {
  type EventPublishContractInvalid,
  type EventPublishTransportFailed,
} from "@stanley2058/lilac-event-bus";
import type { Result as ResultType } from "better-result";

type EventPublishError = EventPublishContractInvalid | EventPublishTransportFailed;

export function adaptEventPublishResultToHost<T>(result: ResultType<T, EventPublishError>): T {
  const outcome = result.match<
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "error"; readonly error: EventPublishError }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
  if (outcome.kind === "ok") return outcome.value;
  switch (outcome.error._tag) {
    case "EventPublishContractInvalid":
    case "EventPublishTransportFailed":
      throw outcome.error;
  }
}
