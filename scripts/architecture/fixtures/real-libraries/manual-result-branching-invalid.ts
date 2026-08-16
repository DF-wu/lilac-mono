import { Result, type Result as ResultType } from "better-result";

import { renamedResultGuard } from "./manual-result-branching-reexport.ts";

type BranchEnvelope =
  | { readonly status: "ok"; readonly value: number }
  | { readonly status: "error"; readonly error: string };

const resultIsOk = Result.isOk;
const { isError: resultIsError } = Result;
const statusKey = "status" as const;

export function readStatus(result: ResultType<number, string>): string {
  return result.status;
}

export function readComputedStatus(result: ResultType<number, string>): string {
  return result["status"];
}

export function readConstComputedStatus(result: ResultType<number, string>): string {
  return result[statusKey];
}

export function destructureStatus(result: ResultType<number, string>): string {
  const { status: branch } = result;
  return branch;
}

export function assignDestructuredStatus(result: ResultType<number, string>): string {
  let branch = "";
  ({ status: branch } = result);
  return branch;
}

export function useStaticGuards(result: ResultType<number, string>): number {
  if (Result.isOk(result)) return result.value;
  return Result.isError(result) ? result.error.length : 0;
}

export function useAliasedGuards(result: ResultType<number, string>): number {
  if (resultIsOk(result)) return result.value;
  return resultIsError(result) ? result.error.length : 0;
}

export function useInstanceGuards(result: ResultType<number, string>): number {
  if (result.isOk()) return result.value;
  return result.isErr() ? result.error.length : 0;
}

export function useTransparentGuardWrappers(result: ResultType<number, string>): boolean {
  return (Result.isOk satisfies typeof Result.isOk)(result) || Result.isError!(result);
}

export function useGuardCallApplyBind(result: ResultType<number, string>): boolean {
  const boundGuard = Result.isOk.bind(Result);
  return (
    Result.isOk.call(Result, result) || Result.isError.apply(Result, [result]) || boundGuard(result)
  );
}

export function useDefaultGuardAlias(
  result: ResultType<number, string>,
  guard = Result.isOk,
): boolean {
  return guard(result);
}

export function useRenamedCrossModuleGuard(result: ResultType<number, string>): boolean {
  return renamedResultGuard(result);
}

export function reconstructConciseEnvelope(result: ResultType<number, string>): BranchEnvelope {
  return result.match<BranchEnvelope>({
    ok: (value) => ({ status: "ok", value }),
    err: (error) => ({ status: "error", error }),
  });
}

export function reconstructBodyEnvelope(result: ResultType<number, string>): BranchEnvelope {
  return result.match<BranchEnvelope>({
    ok: (value) => {
      return { status: "ok", value };
    },
    err: (error) => {
      const envelope = { status: "error" as const, error };
      return envelope;
    },
  });
}

const okEnvelope = (value: number): BranchEnvelope => ({ status: "ok", value });
const errorEnvelope = (error: string): BranchEnvelope => ({ status: "error", error });
const envelopeHandlers = { ok: okEnvelope, err: errorEnvelope };

export function reconstructAliasedEnvelope(result: ResultType<number, string>): BranchEnvelope {
  const handlers = envelopeHandlers;
  return result.match<BranchEnvelope>(handlers);
}

export function reconstructStaticEnvelope(result: ResultType<number, string>): BranchEnvelope {
  return Result.match(result, envelopeHandlers);
}
