import type { Level1ToolName } from "@stanley2058/lilac-coding-tools/schemas";

import {
  markAggregateOutputBudgetExempt,
  markBoundedBuiltinOutput,
  type CoreLevel1ToolSpec,
} from "../types";

export type BuiltinOutputBudgetPolicy = "generic" | "bounded" | "bounded-and-aggregate-exempt";

export function defineLevel1Tool<const Name extends Level1ToolName>(
  outputBudgetPolicy: BuiltinOutputBudgetPolicy,
  spec: CoreLevel1ToolSpec & { readonly name: Name },
): CoreLevel1ToolSpec & { readonly name: Name } {
  switch (outputBudgetPolicy) {
    case "generic":
      return spec;
    case "bounded":
      return markBoundedBuiltinOutput(spec);
    case "bounded-and-aggregate-exempt":
      return markAggregateOutputBudgetExempt(markBoundedBuiltinOutput(spec));
  }
}
