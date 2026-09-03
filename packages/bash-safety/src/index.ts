import type { AnalyzeOptions, AnalyzeResult, BashSafetyCode, BashSafetyViolation } from "./types";

import { analyzeCommandInternal } from "./analyze/analyze-command";

export type { AnalyzeOptions, AnalyzeResult, BashSafetyCode, BashSafetyViolation };

export function analyzeBashCommand(
  command: string,
  options: AnalyzeOptions = {},
): AnalyzeResult | null {
  return analyzeCommandInternal(command, 0, options);
}
