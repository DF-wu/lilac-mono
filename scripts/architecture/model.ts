export const ARCHITECTURE_RULES = [
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
  "architecture/no-unknown-member-read",
  "architecture/no-unregistered-custom-decoder",
  "architecture/closed-union-exhaustiveness",
  "architecture/closed-union-map-exhaustiveness",
  "architecture/open-protocol-normalization",
  "architecture/raw-event-message-boundary",
  "architecture/complete-event-codec-registry",
  "architecture/complete-tool-codec-registry",
  "architecture/result-decoder-contract",
  "architecture/unknown-free-module",
  "architecture/persisted-codec-contract",
  "architecture/persisted-codec-fixture-catalog",
  "architecture/event-handler-result",
  "architecture/event-delivery-policy-exhaustiveness",
  "architecture/no-production-unwrap",
  "architecture/no-unmapped-result-capture",
  "architecture/no-unhandled-exception-contract",
  "architecture/registered-panic-site",
  "architecture/no-result-wire-leak",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
  "architecture/sqlite-transaction-adapter-contract",
  "architecture/sqlite-transaction-consumer",
  "architecture/no-result-err-in-sqlite-callback",
] as const;

export type ArchitectureRule = (typeof ARCHITECTURE_RULES)[number];

export type RuleGroup = "boundary-validation" | "failure-flow";

export const RULE_GROUPS = {
  "architecture/no-unregistered-decoder": "boundary-validation",
  "architecture/no-domain-unknown": "boundary-validation",
  "architecture/no-unknown-assertion": "boundary-validation",
  "architecture/no-rich-unknown-predicate": "boundary-validation",
  "architecture/no-unknown-member-read": "boundary-validation",
  "architecture/no-unregistered-custom-decoder": "boundary-validation",
  "architecture/closed-union-exhaustiveness": "boundary-validation",
  "architecture/closed-union-map-exhaustiveness": "boundary-validation",
  "architecture/open-protocol-normalization": "boundary-validation",
  "architecture/raw-event-message-boundary": "boundary-validation",
  "architecture/complete-event-codec-registry": "boundary-validation",
  "architecture/complete-tool-codec-registry": "boundary-validation",
  "architecture/result-decoder-contract": "boundary-validation",
  "architecture/unknown-free-module": "boundary-validation",
  "architecture/persisted-codec-contract": "boundary-validation",
  "architecture/persisted-codec-fixture-catalog": "boundary-validation",
  "architecture/event-handler-result": "failure-flow",
  "architecture/event-delivery-policy-exhaustiveness": "failure-flow",
  "architecture/no-production-unwrap": "failure-flow",
  "architecture/no-unmapped-result-capture": "failure-flow",
  "architecture/no-unhandled-exception-contract": "failure-flow",
  "architecture/registered-panic-site": "failure-flow",
  "architecture/no-result-wire-leak": "failure-flow",
  "architecture/no-unredacted-tagged-error-log": "failure-flow",
  "architecture/fallible-api-result": "failure-flow",
  "architecture/sqlite-transaction-adapter-contract": "failure-flow",
  "architecture/sqlite-transaction-consumer": "failure-flow",
  "architecture/no-result-err-in-sqlite-callback": "failure-flow",
} as const satisfies Readonly<Record<ArchitectureRule, RuleGroup>>;

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface ArchitectureDiagnostic {
  readonly rule: ArchitectureRule;
  readonly severity: "error" | "warning";
  readonly workspace: string;
  readonly message: string;
  readonly suggestion: string;
  readonly identity: string;
  readonly fingerprint: string;
  readonly location?: SourceLocation;
}

export interface BaselineEntry {
  readonly fingerprint: string;
  readonly identity: string;
  readonly location: SourceLocation;
  readonly reason: string;
}

export type ArchitectureBaseline = Readonly<
  Record<string, Partial<Readonly<Record<ArchitectureRule, readonly BaselineEntry[]>>>>
>;
