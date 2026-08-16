import type { ProtocolEvent } from "open-protocol-sdk";

type ProtocolEventAlias = ProtocolEvent;

export function consumeProtocolDirectly(event: ProtocolEvent): string {
  switch (event.kind) {
    case "created":
      return "created";
    default:
      return "other";
  }
}

export function consumeAliasedProtocolDirectly(event: ProtocolEventAlias): string {
  const alias = event;
  switch (alias.kind) {
    case "created":
      return "created";
    default:
      return "other";
  }
}

export function consumeDestructuredProtocolDirectly(event: ProtocolEvent): string {
  const { kind } = event;
  switch (kind) {
    case "created":
      return "created";
    default:
      return "other";
  }
}

export function consumePropertyAliasedProtocolDirectly(event: ProtocolEvent): string {
  const kind = event.kind;
  switch (kind) {
    case "created":
      return "created";
    default:
      return "other";
  }
}
