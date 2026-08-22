export type ExceptionFlowKind =
  | "try-statement"
  | "promise-catch"
  | "promise-reject"
  | "rejection-callback"
  | "stream-error-signal"
  | "throw";

export interface SyntacticPolicy {
  readonly canonicalRecordGuards: readonly {
    readonly workspace: string;
    readonly module: string;
    readonly symbol: string;
  }[];
  readonly productionExclusions: readonly {
    readonly pattern: string;
    readonly reason: string;
  }[];
}

export const ACTIVE_SYNTAX_RULES = [
  "lilac/blob-storage-seam",
  "lilac/no-exception-flow",
  "lilac/no-inline-async-result-callback",
  "lilac/no-presentation-decoder-import",
  "lilac/no-store-inline-decoding",
  "lilac/no-direct-sqlite-transaction",
] as const;

export type ActiveSyntaxRule = (typeof ACTIVE_SYNTAX_RULES)[number];

export const FINAL_PACKAGE_WIDE_SYNTAX_RULES = [
  "no-nested-ternary",
  "lilac/no-local-is-record",
  ...ACTIVE_SYNTAX_RULES,
] as const;

export const SYNTACTIC_POLICY: SyntacticPolicy = {
  canonicalRecordGuards: [
    {
      workspace: "packages/utils",
      module: "runtime-utils",
      symbol: "isRecord",
    },
  ],
  productionExclusions: [
    {
      pattern: "(?:^|/)(?:tests?|__tests__)(?:/|$)",
      reason: "Production syntax policy does not apply to test support trees",
    },
    {
      pattern: "\\.(?:spec|test)\\.[cm]?[jt]sx?$",
      reason: "Production syntax policy does not apply to test modules",
    },
    {
      pattern: "(?:^|/)(?:dist|generated)(?:/|$)",
      reason: "Generated output is enforced at its source module",
    },
    {
      pattern: "(?:^|/)vendor(?:/|$)",
      reason: "Vendored third-party source is enforced by its upstream project",
    },
    {
      pattern: "^apps/core/src/ssh/remote-js/remote-runner\\.cjs$",
      reason: "Generated remote runner bundle is enforced at its TypeScript source",
    },
  ],
};
