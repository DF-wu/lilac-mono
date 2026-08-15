import { Result, TaggedError, type Result as ResultType } from "better-result";

const BYTE_MULTIPLIERS = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
} as const;

const DURATION_MULTIPLIERS_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
} as const;

export class FriendlyUnitInvalid extends TaggedError("FriendlyUnitInvalid")<{
  readonly expected: string;
  readonly message: string;
}> {}

function parseFriendlyUnitResult(
  value: unknown,
  multipliers: Readonly<Record<string, number>>,
  expected: string,
): ResultType<number, FriendlyUnitInvalid> {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return Result.ok(value);
    return Result.err(
      new FriendlyUnitInvalid({
        expected,
        message: `${expected} must be a non-negative safe integer`,
      }),
    );
  }

  if (typeof value !== "string") {
    return Result.err(
      new FriendlyUnitInvalid({
        expected,
        message: `${expected} must be a number or friendly unit string`,
      }),
    );
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d+))?([A-Za-z]+)$/u.exec(value);
  if (!match) {
    return Result.err(
      new FriendlyUnitInvalid({ expected, message: `Invalid ${expected}: ${value}` }),
    );
  }

  const multiplier = multipliers[match[3] ?? ""];
  if (multiplier === undefined) {
    return Result.err(
      new FriendlyUnitInvalid({
        expected,
        message: `Unsupported ${expected} unit: ${match[3]}`,
      }),
    );
  }

  const amount = Number(match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`);
  const normalized = amount * multiplier;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    return Result.err(
      new FriendlyUnitInvalid({
        expected,
        message: `${expected} must normalize to a non-negative safe integer`,
      }),
    );
  }
  return Result.ok(normalized);
}

export function parseFriendlyByteSizeResult(
  value: unknown,
): ResultType<number, FriendlyUnitInvalid> {
  return parseFriendlyUnitResult(value, BYTE_MULTIPLIERS, "byte size");
}

export function parseFriendlyDurationMsResult(
  value: unknown,
): ResultType<number, FriendlyUnitInvalid> {
  return parseFriendlyUnitResult(value, DURATION_MULTIPLIERS_MS, "duration");
}

export function parseFriendlyByteSize(value: unknown): number {
  const result = parseFriendlyByteSizeResult(value);
  const resolved = result.match<
    { readonly value: number } | { readonly error: FriendlyUnitInvalid }
  >({
    ok: (parsed) => ({ value: parsed }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export function parseFriendlyDurationMs(value: unknown): number {
  const result = parseFriendlyDurationMsResult(value);
  const resolved = result.match<
    { readonly value: number } | { readonly error: FriendlyUnitInvalid }
  >({
    ok: (parsed) => ({ value: parsed }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}
