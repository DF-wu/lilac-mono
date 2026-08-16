import { Result, type Result as ResultType, type SerializedResult } from "better-result";
import { z } from "zod";

interface DomainState {
  readonly status: "ok" | "error";
  readonly value: number;
}

const DomainState = {
  isOk: (state: DomainState): boolean => state.status === "ok",
  isError: (state: DomainState): boolean => state.status === "error",
};
const domainStatusKey = "status" as const;
const typedDomainGuard: typeof Result.isOk = <A, E>(_result: ResultType<A, E>): _result is never =>
  false;
const resultCodec = Result.codec({
  serialize: { ok: z.number(), err: z.string() },
  deserialize: { ok: z.number(), err: z.string() },
});

export function readDomainStatus(state: DomainState): string {
  const { status } = state;
  let assigned = "";
  ({ status: assigned } = state);
  return state.status === status ? state[domainStatusKey] : assigned;
}

export function useDomainGuards(state: DomainState): boolean {
  const boundGuard = DomainState.isOk.bind(DomainState);
  const defaultGuard = (guard = DomainState.isError): boolean => guard(state);
  return (
    DomainState.isOk.call(DomainState, state) ||
    DomainState.isError.apply(DomainState, [state]) ||
    boundGuard(state) ||
    defaultGuard()
  );
}

export function useTypedDomainGuard(result: ResultType<number, string>): boolean {
  return typedDomainGuard(result);
}

export function readSerializedStatus(result: SerializedResult<number, string>): string {
  return result.status;
}

export function composeResult(result: ResultType<number, string>): number {
  return result.match({ ok: (value) => value, err: (error) => error.length });
}

type DomainProjection =
  | { readonly status: "available"; readonly value: number }
  | { readonly status: "unavailable"; readonly reason: string };

export function projectDomain(result: ResultType<number, string>): DomainProjection {
  return result.match<DomainProjection>({
    ok: (value) => ({ status: "available" as const, value }),
    err: (error) => ({ status: "unavailable" as const, reason: error }),
  });
}

type OneBranchProjection =
  | { readonly status: "ok"; readonly value: number }
  | { readonly status: "rejected"; readonly reason: string };

export function projectOnlyOneResultBranch(
  result: ResultType<number, string>,
): OneBranchProjection {
  return result.match<OneBranchProjection>({
    ok: (value) => ({ status: "ok" as const, value }),
    err: (error) => ({ status: "rejected" as const, reason: error }),
  });
}

export function serializeWithResultCodec(result: ResultType<number, string>) {
  return resultCodec.serializeUnsafe(result);
}

type LocalEnvelope =
  | { readonly status: "ok"; readonly value: number }
  | { readonly status: "error"; readonly error: string };
const localMatch = ((..._args: unknown[]): unknown => undefined) as unknown as typeof Result.match;
const localHandlers = {
  ok: (value: number): LocalEnvelope => ({ status: "ok", value }),
  err: (error: string): LocalEnvelope => ({ status: "error", error }),
};

export function useLocalMatchWithLibraryType(result: ResultType<number, string>): LocalEnvelope {
  return localMatch(result, localHandlers);
}
