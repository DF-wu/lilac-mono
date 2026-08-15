import type { Result as ResultType } from "better-result";

type Envelope =
  | { readonly status: "ok"; readonly value: number }
  | { readonly status: "error"; readonly error: string };

export function reconstructResult(result: ResultType<number, string>): Envelope {
  return result.match<Envelope>({
    ok: (value) => ({ status: "ok", value }),
    err: (error) => ({ status: "error", error }),
  });
}
