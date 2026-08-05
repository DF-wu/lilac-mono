import {
  type EventPublishContractInvalid,
  type EventPublishTransportFailed,
} from "@stanley2058/lilac-event-bus";
import type { Result as ResultType } from "better-result";

type EventPublishError = EventPublishContractInvalid | EventPublishTransportFailed;

export function adaptEventPublishResultToHost<T>(result: ResultType<T, EventPublishError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "EventPublishContractInvalid":
    case "EventPublishTransportFailed":
      throw result.error;
  }
}
