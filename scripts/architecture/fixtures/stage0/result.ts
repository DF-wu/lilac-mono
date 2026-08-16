import {
  Result,
  TaggedErrorBase,
  panic as failInvariant,
  type Result as ResultType,
} from "better-result";
import { send } from "wire-api";

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

export async function genericAsyncCapture() {
  return await Result.tryPromise(async () => "value");
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
