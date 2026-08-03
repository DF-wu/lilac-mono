import { Result, TaggedError } from "better-result";
import { z } from "zod";

const domainSchema = z.object({ id: z.string() });
const resultCodec = Result.codec({
  serialize: { ok: z.string(), err: z.string() },
  deserialize: { ok: z.string(), err: z.string() },
});

export function decodeRealZod(value: unknown) {
  return domainSchema.safeParse(value);
}

export function captureRealResult() {
  return Result.try(() => JSON.parse("{}"));
}

export function extractRealResult() {
  const result = Result.ok("value");
  result.unwrap();
  resultCodec.serializeUnsafe(result);
  return resultCodec.deserializeUnsafe({ status: "ok", value: "value" });
}

class RealDecodeFailure extends TaggedError("RealDecodeFailure")<{
  readonly message: string;
}> {}

class RealDecodeFailureWithCause extends TaggedError("RealDecodeFailureWithCause")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export function decodeRealResult(
  value: unknown,
): Result<{ readonly id: string }, RealDecodeFailure> {
  void value;
  return Result.err(new RealDecodeFailure({ message: "invalid fixture" }));
}

export function decodeRealResultWithUnknownCause(
  value: unknown,
): Result<{ readonly id: string }, RealDecodeFailureWithCause> {
  void value;
  return Result.err(
    new RealDecodeFailureWithCause({ cause: new Error("fixture"), message: "invalid fixture" }),
  );
}
