import { Result } from "better-result";
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
