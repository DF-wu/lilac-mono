import type { ProtocolEvent } from "open-protocol-sdk";
import type { ExternalState } from "third-party-closed";

import * as unionMaps from "./union-types";

import {
  importedExhaustiveStateMap,
  importedIntermediateStateMap,
  importedPartialStateMap,
  type ExhaustiveMap,
  type ImportedEvent,
  type ImportedState,
} from "./union-types";

type LocalState = "queued" | "active" | "complete";
type AliasedImportedState = ImportedState;
type LaunderedExternalState = ExternalState;
type ExternalEnvelope = { readonly state: ExternalState };
type ProtocolEventAlias = ProtocolEvent;

declare const unrelatedNever: never;

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function incompleteLocalSwitch(state: LocalState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "active":
      return "active";
  }
  return "not complete";
}

export function incompleteInlineSwitch(state: "cold" | "warm" | "hot"): string {
  switch (state) {
    case "cold":
      return "cold";
    case "warm":
      return "warm";
  }
  return "not hot";
}

export function silentDefault(state: LocalState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "active":
      return "active";
    case "complete":
      return "complete";
    default:
      return "silently ignored";
  }
}

export function exhaustiveWithNeverSink(state: LocalState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "active":
      return "active";
    case "complete":
      return "complete";
    default:
      return assertNever(state);
  }
}

export function exhaustivePropertyWithNeverSink(input: { readonly state: LocalState }): string {
  switch (input.state) {
    case "queued":
      return "queued";
    case "active":
      return "active";
    case "complete":
      return "complete";
    default: {
      const exhaustive: never = input.state;
      return exhaustive;
    }
  }
}

export function unrelatedNeverSink(state: LocalState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "active":
      return "active";
    case "complete":
      return "complete";
    default:
      return assertNever(unrelatedNever);
  }
}

export function incompleteInferredSwitch(active: boolean): string {
  const state = active ? ("active" as const) : ("complete" as const);
  switch (state) {
    case "active":
      return "active";
  }
  return "not complete";
}

function inferredState(active: boolean) {
  return active ? ("active" as const) : ("complete" as const);
}

export function incompleteInferredFunctionSwitch(active: boolean): string {
  switch (inferredState(active)) {
    case "active":
      return "active";
  }
  return "not complete";
}

export function incompleteInferredObjectSwitch(created: boolean): string {
  const event = created
    ? ({ kind: "created", id: "created" } as const)
    : ({ kind: "deleted", id: "deleted" } as const);
  switch (event.kind) {
    case "created":
      return event.id;
  }
  return "not deleted";
}

export function incompleteShorthandObjectSwitch(created: boolean): string {
  const kind = created ? ("created" as const) : ("deleted" as const);
  const event = { kind } as const;
  switch (event.kind) {
    case "created":
      return "created";
  }
  return "not deleted";
}

export function incompleteImportedAlias(state: AliasedImportedState): string {
  switch (state) {
    case "idle":
      return "idle";
    case "running":
      return "running";
  }
  return "not done";
}

export function incompleteDiscriminatedSwitch(event: ImportedEvent): string {
  switch (event.kind) {
    case "created":
      return event.id;
    case "updated":
      return event.id;
  }
  return "not deleted";
}

export function incompleteGenericSwitch<State extends ImportedState>(state: State): string {
  switch (state) {
    case "idle":
      return "idle";
    case "running":
      return "running";
  }
  return "not done";
}

export function thirdPartySwitch(state: ExternalState): string {
  switch (state) {
    case "external-idle":
      return "idle";
  }
  return "third-party fallback";
}

export function launderedThirdPartySwitch(state: LaunderedExternalState): string {
  switch (state) {
    case "external-idle":
      return "idle";
  }
  return "still third-party";
}

export function wrappedThirdPartySwitch(envelope: ExternalEnvelope): string {
  switch (envelope.state) {
    case "external-idle":
      return "idle";
  }
  return "still externally owned";
}

const exhaustiveStateMap = {
  idle: "idle",
  running: "running",
  done: "done",
} satisfies Record<ImportedState, string>;

const genericExhaustiveStateMap: ExhaustiveMap<ImportedState, string> = {
  idle: "idle",
  running: "running",
  done: "done",
};

const partialStateMap: Partial<Record<ImportedState, string>> = {
  idle: "idle",
  running: "running",
};

const assertedStateMap = {
  idle: "idle",
  running: "running",
} as Record<ImportedState, string>;

const broadStateMap: Record<string, string> = {
  idle: "idle",
  running: "running",
};

const thirdPartyMap: Partial<Record<ExternalState, string>> = {
  "external-idle": "idle",
};

const _unusedPartialStateMap: Partial<Record<ImportedState, string>> = {
  idle: "idle",
};

const propertyMaps = {
  state: {
    idle: "idle",
  } as Record<ImportedState, string>,
};

export function readStateMaps(state: ImportedState, external: ExternalState): readonly string[] {
  return [
    exhaustiveStateMap[state],
    genericExhaustiveStateMap[state],
    partialStateMap[state] ?? "partial fallback",
    assertedStateMap[state],
    broadStateMap[state] ?? "broad fallback",
    importedExhaustiveStateMap[state],
    importedIntermediateStateMap[state],
    importedPartialStateMap[state] ?? "imported partial fallback",
    thirdPartyMap[external] ?? "external fallback",
    propertyMaps.state[state],
    unionMaps.namespacePartialStateMap[state],
  ];
}

export type NormalizedEvent =
  | { readonly kind: "created"; readonly payload?: string }
  | { readonly kind: "updated"; readonly payload?: string }
  | { readonly kind: "unsupported"; readonly externalKind: string };

export function normalizeProtocolEvent(event: ProtocolEvent): NormalizedEvent {
  switch (event.kind) {
    case "created":
      return { kind: "created", payload: event.payload };
    case "updated":
      return { kind: "updated", payload: event.payload };
    default:
      return { kind: "unsupported", externalKind: event.kind };
  }
}

export function normalizeWithoutExplicitFallback(event: ProtocolEvent): NormalizedEvent {
  if (event.kind === "created") return { kind: "created", payload: event.payload };
  return { kind: "updated", payload: event.payload };
}

export function normalizeLocalValue(event: { readonly kind: string }): NormalizedEvent {
  return { kind: "unsupported", externalKind: event.kind };
}

export function normalizeAliasedProtocolEvent(event: ProtocolEventAlias): NormalizedEvent {
  if (event.kind === "created") return { kind: "created", payload: event.payload };
  return { kind: "unsupported", externalKind: event.kind };
}

export function normalizeWrappedProtocolEvent(input: {
  readonly event: ProtocolEvent;
}): NormalizedEvent {
  return { kind: "unsupported", externalKind: input.event.kind };
}

export function normalizeUnionProtocolEvent(
  event: ProtocolEvent | { readonly kind: "local" },
): NormalizedEvent {
  return { kind: "unsupported", externalKind: event.kind };
}

export function consumeNormalizedEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "created":
    case "updated":
      return event.payload ?? "";
    case "unsupported":
      return event.externalKind;
  }
}
