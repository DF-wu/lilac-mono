import { Result } from "better-result";

const ResultAlias = Result;
const ResultAliasAgain = ResultAlias;

Object.assign(ResultAliasAgain, {
  try(options: { readonly try: () => string; readonly catch: (cause: unknown) => unknown }) {
    return options;
  },
});

export function mutatedImportedResultCapture() {
  return Result.try({ try: () => "value", catch: (cause: unknown) => cause });
}
