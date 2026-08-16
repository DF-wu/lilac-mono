export const orphanPersistedCodecCases = {
  current: { input: "current", outcome: "ok", provenance: "current" },
  legacy: { input: "legacy", outcome: "ok", provenance: "migrated" },
  "missing-defaulted": { input: null, outcome: "ok", provenance: "missing-defaulted" },
  "unsupported-version": { input: "unsupported", outcome: "error" },
  "malformed-serialization": { input: "malformed", outcome: "error" },
  "corrupt-fields": { input: "corrupt", outcome: "error" },
} as const;
