import {
  Result,
  Result as R,
  Panic,
  TaggedErrorBase,
  panic as failInvariant,
  type Result as ResultType,
} from "better-result";
import { send } from "wire-api";
import { unresolvedMapper } from "unresolved-result-helper";

import { captureFixtureError, importedThrowingMapper } from "./result-helper";

declare function declaredUnresolvedMapper(cause: unknown): Error;

class WireFailure extends TaggedErrorBase {
  override readonly _tag = "WireFailure";
}

const unsafeCodec = Result.codec();

interface RecursiveEnvelope {
  readonly next?: RecursiveEnvelope;
  readonly payload: ResultType<string, never>;
}

function localJsonResponse(value: unknown): void {
  void value;
}

export function unsafeExtraction(result: ResultType<number, WireFailure>): number {
  const extract = Result.unwrap;
  unsafeCodec.serializeUnsafe(result);
  unsafeCodec.deserializeUnsafe({ status: "ok", value: 1 });
  return result.unwrap() + extract(result);
}

export function genericCapture() {
  const capture = Result.try;
  return capture(() => JSON.parse("{}"));
}

export function mappedCapture() {
  return Result.try({
    try: () => JSON.parse("{}"),
    catch: () => new WireFailure(),
  });
}

export function importAliasedCapture() {
  return R.try({ try: () => "value", catch: (cause) => cause });
}

export async function genericAsyncCapture() {
  return await Result.tryPromise(async () => "value");
}

function mapThroughHelper(_cause: unknown): WireFailure {
  return new WireFailure();
}

function throwThroughHelper(): never {
  throw new WireFailure();
}

function rejectThroughHelper(): Promise<never> {
  return Promise.reject(new WireFailure());
}

let reassignedTransitiveMapper = (_cause: unknown): WireFailure => new WireFailure();
reassignedTransitiveMapper = (_cause: unknown): WireFailure => new WireFailure();

const unrelatedRejector = {
  reject(_cause: unknown): WireFailure {
    return new WireFailure();
  },
};

export function mappedCaptureThroughArbitraryHelper() {
  return Result.try({ try: () => "value", catch: mapThroughHelper });
}

export function nestedObjectCaptureInCatchMapper() {
  return Result.try({
    try: () => "value",
    catch: (cause) => {
      const inspected = Result.try({
        try: () => (cause instanceof Error ? cause.message : "opaque"),
        catch: () => "opaque",
      });
      return inspected.match({ ok: (value) => value, err: (value) => value });
    },
  });
}

export function nestedThrowingCaptureInCatchMapper() {
  return Result.try({
    try: () => "value",
    catch: (cause) => {
      const inspected = Result.try({
        try: () => (cause instanceof Error ? cause.message : "opaque"),
        catch: () => {
          throw new WireFailure();
        },
      });
      return inspected.match({ ok: (value) => value, err: () => "opaque" });
    },
  });
}

export function mappedUnknownCapture() {
  return Result.try({ try: () => "value", catch: (cause) => cause });
}

export function mappedPanicCapture() {
  return Result.try({ try: () => "value", catch: () => new Panic() });
}

export function throwingCatchMapper() {
  return Result.try({
    try: () => "value",
    catch: () => {
      throw new WireFailure();
    },
  });
}

export function rejectingCatchMapper() {
  return Result.tryPromise({
    try: async () => "value",
    catch: () => Promise.reject(new WireFailure()),
  });
}

export function signalResultCaptureFailure(): never {
  throw new WireFailure();
}

export function signalingCatchMapper() {
  return Result.try({ try: () => "value", catch: signalResultCaptureFailure });
}

export function transitivelyThrowingCatchMapper() {
  return Result.try({ try: () => "value", catch: throwThroughHelper });
}

export function transitivelyRejectingCatchMapper() {
  return Result.tryPromise({ try: async () => "value", catch: rejectThroughHelper });
}

export function unrelatedRejectMethodCatchMapper() {
  return Result.try({ try: () => "value", catch: (cause) => unrelatedRejector.reject(cause) });
}

export function importedThrowingCatchMapper() {
  const options = { try: () => "value", catch: importedThrowingMapper };
  return Result.try(options);
}

export function declaredUnresolvedCatchMapper() {
  return Result.try({ try: () => "value", catch: (cause) => declaredUnresolvedMapper(cause) });
}

export function importedUnresolvedCatchMapper() {
  return Result.try({ try: () => "value", catch: (cause) => unresolvedMapper(cause) });
}

export function transitiveReassignedCatchMapper() {
  return Result.try({
    try: () => "value",
    catch: (cause) => reassignedTransitiveMapper(cause),
  });
}

export function dynamicOptionsCatchMapper(enabled: boolean) {
  const options = enabled
    ? { try: () => "value", catch: (cause: unknown) => cause }
    : { try: () => "fallback", catch: (cause: unknown) => cause };
  return Result.try(options);
}

export function directDeclaredUnresolvedCatchMapper() {
  return Result.try({ try: () => "value", catch: declaredUnresolvedMapper });
}

export function directImportedUnresolvedCatchMapper() {
  return Result.try({ try: () => "value", catch: unresolvedMapper });
}

const FakeResult = {
  try(options: { readonly try: () => string; readonly catch: (cause: unknown) => unknown }) {
    return options;
  },
};

const LocalResultAlias = Result;

export function localResultAliasUnknownBypass() {
  return LocalResultAlias.try({ try: () => "value", catch: (cause) => cause });
}

let ReassignedResult = Result;
ReassignedResult = FakeResult as unknown as typeof Result;

export function reassignedResultUnknownBypass() {
  return ReassignedResult.try({ try: () => "value", catch: (cause) => cause });
}

export function fakeResultUnknownBypass() {
  return FakeResult.try({ try: () => "value", catch: (cause: unknown) => cause });
}

export function unrelatedUnknownInCaptureScope(payload: unknown) {
  Result.try({ try: () => "value", catch: (cause) => cause });
  return payload;
}

export function mappedCaptureOutcomeRead() {
  const captured = Result.try<unknown, unknown>({
    try: () => JSON.parse("{}"),
    catch: (cause) => cause,
  });
  const outcome = captured.match<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >({ ok: (value) => ({ ok: true, value }), err: (error) => ({ ok: false, error }) });
  return outcome.ok ? outcome.value : outcome.error;
}

export function mappedCaptureThroughProjectionHelper() {
  return Result.try({
    try: () => "value",
    catch: (cause) => ({
      kind: "failure" as const,
      ...captureFixtureError(cause, "Fixture capture failed"),
    }),
  });
}

const unrelatedCapturedValue: unknown = "unrelated";

function captureUnrelatedValue(cause: unknown) {
  return cause instanceof Error
    ? { cause, captured: unrelatedCapturedValue }
    : { cause: new Error("Unrelated fixture failure"), captured: unrelatedCapturedValue };
}

export function mappedCaptureThroughUnrelatedProjection() {
  return Result.try({
    try: () => "value",
    catch: (cause) => ({
      kind: "failure" as const,
      ...captureUnrelatedValue(cause),
    }),
  });
}

interface CapturedCause {
  readonly kind: "cause";
  readonly cause: unknown;
}

function namedCapturedCauseMapper(cause: unknown): CapturedCause {
  return { kind: "cause", cause };
}

function locallyAliasedCapturedCauseMapper(cause: unknown): CapturedCause {
  return { kind: "cause", cause };
}

const localCapturedMapperAlias = locallyAliasedCapturedCauseMapper;

let reassignedCapturedCauseMapper = (cause: unknown): CapturedCause => ({ kind: "cause", cause });
reassignedCapturedCauseMapper = (cause: unknown): CapturedCause => ({ kind: "cause", cause });

function classifyCapturedCause(cause: unknown): string {
  if (Panic.is(cause)) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

function captureNamedClosedWrapper() {
  const captured = Result.try<string, CapturedCause>({
    try: () => JSON.parse('"value"'),
    catch: namedCapturedCauseMapper,
  });
  return captured.match<{ readonly kind: "value"; readonly value: string } | CapturedCause>({
    ok: (value) => ({ kind: "value", value }),
    err: (failure) => failure,
  });
}

export function locallyAliasedCapturedMapper() {
  return Result.try({ try: () => "value", catch: localCapturedMapperAlias });
}

export function reassignedCapturedMapper() {
  return Result.try({ try: () => "value", catch: reassignedCapturedCauseMapper });
}

export function classifyNamedCapturedWrapperOutside(): string {
  const settled = captureNamedClosedWrapper();
  if (settled.kind === "value") return settled.value;
  return classifyCapturedCause(settled.cause);
}

export function classifyInlineCapturedThunk(): string {
  const captured = Result.try<string, CapturedCause>({
    try: () => JSON.parse('"value"'),
    catch: (cause) => ({ kind: "cause", cause }),
  });
  return captured.match<() => string>({
    ok: (value) => () => value,
    err: (failure) => () => {
      if (Panic.is(failure.cause)) return failure.cause.message;
      return failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
    },
  })();
}

export function classifyCapturedMapError(): string {
  const captured = Result.try<string, CapturedCause>({
    try: () => JSON.parse('"value"'),
    catch: (cause) => ({ kind: "cause", cause }),
  }).mapError(({ cause }) => cause);
  return captured.match({
    ok: (value) => value,
    err: (cause) => (Panic.is(cause) ? cause.message : String(cause)),
  });
}

function classifyMixedCapturedCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function classifyMixedCapturedComposite(value: unknown): string {
  return String(value);
}

function classifyConditionallyAssignedCause(cause: unknown): string {
  return String(cause);
}

function classifyMultiplyAssignedCause(cause: unknown): string {
  return String(cause);
}

function classifyCompoundAssignedCause(cause: unknown): string {
  return String(cause);
}

function classifyDestructuringAssignedCause(cause: unknown): string {
  return String(cause);
}

export function classifyMixedCapturedAndUnrelated(payload: unknown): string {
  const captured = Result.try<string, CapturedCause>({
    try: () => JSON.parse('"value"'),
    catch: (cause) => ({ kind: "cause", cause }),
  });
  return captured.match({
    ok: (value) => value,
    err: ({ cause }) => classifyMixedCapturedCause(typeof payload === "string" ? cause : payload),
  });
}

export function classifyCapturedAndUnrelatedComposite(payload: unknown): string {
  const captured = Result.try<string, CapturedCause>({
    try: () => JSON.parse('"value"'),
    catch: (cause) => ({ kind: "cause", cause }),
  });
  return captured.match({
    ok: (value) => value,
    err: ({ cause }) => classifyMixedCapturedComposite({ cause, payload }),
  });
}

export function classifyConditionallyAssignedCapturedCause(payload: unknown): string {
  return Result.try({ try: () => "value", catch: (cause) => cause }).match({
    ok: (value) => value,
    err: (cause) => {
      let selected = cause;
      if (typeof payload === "string") selected = payload;
      return classifyConditionallyAssignedCause(selected);
    },
  });
}

export function classifyMultiplyAssignedCapturedCause(): string {
  return Result.try({ try: () => "value", catch: (cause) => cause }).match({
    ok: (value) => value,
    err: (cause) => {
      let selected = cause;
      selected = cause;
      return classifyMultiplyAssignedCause(selected);
    },
  });
}

export function classifyCompoundAssignedCapturedCause(): string {
  return Result.try({ try: () => "value", catch: (cause) => cause }).match({
    ok: (value) => value,
    err: (cause) => {
      let selected: unknown = cause;
      selected &&= cause;
      return classifyCompoundAssignedCause(selected);
    },
  });
}

export function classifyDestructuringAssignedCapturedCause(): string {
  return Result.try({ try: () => "value", catch: (cause) => cause }).match({
    ok: (value) => value,
    err: (cause) => {
      let selected: unknown = cause;
      ({ selected } = { selected: cause });
      return classifyDestructuringAssignedCause(selected);
    },
  });
}

function unrelatedClosedWrapper(cause: unknown): CapturedCause {
  return { kind: "cause", cause };
}

export function classifyUnrelatedClosedWrapper(payload: unknown): string {
  const settled = unrelatedClosedWrapper(payload);
  return settled.cause instanceof Error ? settled.cause.message : String(settled.cause);
}

export function ancestorCaptureDoesNotOwnUnknown(payload: unknown): string {
  Result.try({ try: () => "value", catch: (cause) => ({ kind: "cause" as const, cause }) });
  const settled: CapturedCause = { kind: "cause", cause: payload };
  return settled.cause instanceof Error ? settled.cause.message : String(settled.cause);
}

export function firstInvariant(value: string): never {
  return failInvariant(`first: ${value}`);
}

export function secondInvariant(): never {
  return failInvariant("second");
}

export function leakResult(): void {
  const emit = send;
  emit(Result.ok("secret"));
  const envelope: RecursiveEnvelope = { payload: Result.ok("nested secret") };
  emit(envelope);
}

export function leakTaggedError(): void {
  send(new WireFailure());
}

export function leakLocalResult(): void {
  localJsonResponse(Result.err(new WireFailure()));
}

export function mappedWireValue(): void {
  send({ status: "error", message: "safe" });
}
