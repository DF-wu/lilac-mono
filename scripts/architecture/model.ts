export const ARCHITECTURE_RULES = [
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
  "architecture/no-production-unwrap",
  "architecture/no-unmapped-result-capture",
  "architecture/registered-panic-site",
  "architecture/no-result-wire-leak",
] as const;

export type ArchitectureRule = (typeof ARCHITECTURE_RULES)[number];

export type RuleGroup = "boundary-validation" | "failure-flow";

export const RULE_GROUPS = {
  "architecture/no-unregistered-decoder": "boundary-validation",
  "architecture/no-domain-unknown": "boundary-validation",
  "architecture/no-unknown-assertion": "boundary-validation",
  "architecture/no-rich-unknown-predicate": "boundary-validation",
  "architecture/no-production-unwrap": "failure-flow",
  "architecture/no-unmapped-result-capture": "failure-flow",
  "architecture/registered-panic-site": "failure-flow",
  "architecture/no-result-wire-leak": "failure-flow",
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
