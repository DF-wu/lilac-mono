export type ExceptionFlowKind =
  | "catch-clause"
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
  readonly recordGuardNames: readonly string[];
}

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
      pattern: "^apps/core/src/ssh/remote-js/remote-runner\\.cjs$",
      reason: "Generated remote runner bundle is enforced at its TypeScript source",
    },
  ],
  recordGuardNames: ["isPlainObject", "isRecord"],
};
