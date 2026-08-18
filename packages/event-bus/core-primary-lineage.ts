import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { modelMessageSchema, type ModelMessage } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { panic as signalEventBusPanic } from "./redis-managed-delivery";

export const CORE_PRIMARY_LINEAGE_DOMAIN_V1 = "lilac:core-primary-lineage:v1";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN, "Expected a lowercase SHA-256 digest");
const nonemptyStringSchema = z.string().min(1);

const surfaceLineageAtomV1Schema = z.strictObject({
  kind: z.literal("surface"),
  requestClient: nonemptyStringSchema,
  surfaceId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});

const coreRequestAliasV1Schema = surfaceLineageAtomV1Schema.omit({ kind: true });

export type CoreRequestAliasV1 = z.infer<typeof coreRequestAliasV1Schema>;

const requestLineageAtomV1Schema = z.strictObject({
  kind: z.literal("request"),
  requestId: nonemptyStringSchema,
  transcriptDigest: sha256HexSchema,
  providerFamily: z.enum(["claude-code", "ai-sdk"]),
  containsCrossFamilyTurns: z.boolean(),
});

const syntheticLineageAtomV1Schema = z.strictObject({
  kind: z.literal("synthetic"),
  source: nonemptyStringSchema,
  messageDigest: sha256HexSchema,
});

const checkpointLineageAtomV1Schema = z.strictObject({
  kind: z.literal("checkpoint"),
  requestId: nonemptyStringSchema,
  transcriptDigest: sha256HexSchema,
});

export const coreLineageAtomV1Schema = z.discriminatedUnion("kind", [
  surfaceLineageAtomV1Schema,
  requestLineageAtomV1Schema,
  syntheticLineageAtomV1Schema,
  checkpointLineageAtomV1Schema,
]);

export type CoreLineageAtomV1 = z.infer<typeof coreLineageAtomV1Schema>;

const modelMessagesSchema = z.array(modelMessageSchema);

export const coreLineageSegmentV1Schema = z
  .strictObject({
    atoms: z.array(coreLineageAtomV1Schema).min(1),
    canonicalMessages: modelMessagesSchema.min(1),
    requestSource: z
      .strictObject({
        aliases: z.array(coreRequestAliasV1Schema).min(1),
      })
      .optional(),
    /** Inclusive index in the request's canonical messages. */
    canonicalStart: z.number().int().nonnegative(),
    /** Exclusive index in the request's canonical messages. */
    canonicalEnd: z.number().int().positive(),
    cumulativeAtomCount: z.number().int().positive(),
    cumulativePrefixDigest: sha256HexSchema,
  })
  .superRefine((segment, context) => {
    const kinds = new Set(segment.atoms.map((atom) => atom.kind));
    const isSurface = kinds.size === 1 && kinds.has("surface");
    const isRequest = segment.atoms.length === 1 && segment.atoms[0]?.kind === "request";
    const isCheckpoint = segment.atoms.length === 1 && segment.atoms[0]?.kind === "checkpoint";
    const isSynthetic = segment.atoms.length === 1 && segment.atoms[0]?.kind === "synthetic";

    if (!isSurface && !isRequest && !isCheckpoint && !isSynthetic) {
      addManifestIssue(
        context,
        ["atoms"],
        "A lineage segment must contain only surface atoms or exactly one request, checkpoint, or synthetic atom",
      );
    }
    if (isRequest && !segment.requestSource) {
      addManifestIssue(
        context,
        ["requestSource"],
        "A request segment must identify at least one request output alias",
      );
    }
    if (!isRequest && segment.requestSource) {
      addManifestIssue(
        context,
        ["requestSource"],
        "Only a request segment may identify request output aliases",
      );
    }
  });

export type CoreLineageSegmentV1 = z.infer<typeof coreLineageSegmentV1Schema>;

export type CoreLineageSegmentInputV1 = {
  readonly atoms: readonly CoreLineageAtomV1[];
  readonly canonicalMessages: readonly ModelMessage[];
  readonly requestSource?: {
    readonly aliases: readonly CoreRequestAliasV1[];
  };
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export const CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1 = sha256(CORE_PRIMARY_LINEAGE_DOMAIN_V1);

type CanonicalJsonPrimitive = null | boolean | number | string;
interface CanonicalJsonArray extends Array<CanonicalJson> {}
interface CanonicalJsonObject extends Record<string, CanonicalJson> {}
type CanonicalJson = CanonicalJsonPrimitive | CanonicalJsonArray | CanonicalJsonObject;

function canonicalizeJson(value: CanonicalJson): CanonicalJson {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key]!)]),
  );
}

/** Return the recursively key-sorted JSON representation hashed by lineage v1. */
export function canonicalizeCoreLineageAtomV1(value: CoreLineageAtomV1): string {
  const atom = value as CanonicalJson;
  return JSON.stringify(canonicalizeJson(atom));
}

export class CoreLineageDigestInputInvalid extends TaggedError("CoreLineageDigestInputInvalid")<{
  readonly field: "previousDigest" | "atomIndex";
  readonly message: string;
}> {}

function extendValidatedCoreLineagePrefixDigestV1(
  previousDigest: string,
  atomIndex: number,
  atom: CoreLineageAtomV1,
): string {
  const index = Buffer.alloc(8);
  index.writeBigUInt64BE(BigInt(atomIndex));
  return createHash("sha256")
    .update(CORE_PRIMARY_LINEAGE_DOMAIN_V1, "utf8")
    .update(index)
    .update(Buffer.from(previousDigest, "hex"))
    .update(canonicalizeCoreLineageAtomV1(atom), "utf8")
    .digest("hex");
}

/**
 * Extend a v1 digest with one atom. Indices are one-based unsigned 64-bit
 * big-endian values and the previous digest contributes its raw 32 bytes.
 */
export function extendCoreLineagePrefixDigestV1(
  previousDigest: string,
  atomIndex: number,
  atom: CoreLineageAtomV1,
): ResultType<string, CoreLineageDigestInputInvalid> {
  if (!SHA256_HEX_PATTERN.test(previousDigest)) {
    return Result.err(
      new CoreLineageDigestInputInvalid({
        field: "previousDigest",
        message: "previousDigest must be a lowercase SHA-256 digest",
      }),
    );
  }
  if (!Number.isSafeInteger(atomIndex) || atomIndex < 1) {
    return Result.err(
      new CoreLineageDigestInputInvalid({
        field: "atomIndex",
        message: "atomIndex must be a positive safe integer",
      }),
    );
  }
  return Result.ok(extendValidatedCoreLineagePrefixDigestV1(previousDigest, atomIndex, atom));
}

/** Compute the cumulative v1 digest for an ordered atom prefix. */
export function computeCoreLineagePrefixDigestV1(atoms: readonly CoreLineageAtomV1[]): string {
  let digest = CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1;
  for (const [index, atom] of atoms.entries()) {
    digest = extendValidatedCoreLineagePrefixDigestV1(digest, index + 1, atom);
  }
  return digest;
}

function addManifestIssue(
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export const coreLineageManifestV1Schema = z
  .strictObject({
    state: z.literal("complete"),
    lineageVersion: z.literal(1),
    currentCanonicalStart: z.number().int().nonnegative(),
    segments: z.array(coreLineageSegmentV1Schema).min(1),
  })
  .superRefine((manifest, context) => {
    let canonicalEnd = 0;
    let atomCount = 0;
    let digest = CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1;
    const claimedSources = new Map<string, readonly PropertyKey[]>();

    const claimSource = (key: string, path: readonly PropertyKey[]): void => {
      const previousPath = claimedSources.get(key);
      if (previousPath) {
        addManifestIssue(
          context,
          [...path],
          `Lineage source is already claimed at ${previousPath.join(".")}`,
        );
        return;
      }
      claimedSources.set(key, path);
    };

    for (const [segmentIndex, segment] of manifest.segments.entries()) {
      if (segment.canonicalStart !== canonicalEnd) {
        addManifestIssue(
          context,
          ["segments", segmentIndex, "canonicalStart"],
          `Expected contiguous canonicalStart ${canonicalEnd}`,
        );
      }
      canonicalEnd += segment.canonicalMessages.length;
      if (segment.canonicalEnd !== canonicalEnd) {
        addManifestIssue(
          context,
          ["segments", segmentIndex, "canonicalEnd"],
          `Expected canonicalEnd ${canonicalEnd}`,
        );
      }

      for (const [atomIndex, atom] of segment.atoms.entries()) {
        const path = ["segments", segmentIndex, "atoms", atomIndex] as const;
        if (atom.kind === "surface") {
          claimSource(
            `surface\u0000${atom.requestClient}\u0000${atom.surfaceId}\u0000${atom.sessionId}\u0000${atom.messageId}`,
            path,
          );
        } else if (atom.kind === "request" || atom.kind === "checkpoint") {
          claimSource(`request\u0000${atom.requestId}`, path);
        } else {
          claimSource(`synthetic\u0000${atom.source}\u0000${atom.messageDigest}`, path);
        }
        atomCount += 1;
        digest = extendValidatedCoreLineagePrefixDigestV1(digest, atomCount, atom);
      }
      for (const [aliasIndex, alias] of segment.requestSource?.aliases.entries() ?? []) {
        claimSource(
          `surface\u0000${alias.requestClient}\u0000${alias.surfaceId}\u0000${alias.sessionId}\u0000${alias.messageId}`,
          ["segments", segmentIndex, "requestSource", "aliases", aliasIndex],
        );
      }
      if (segment.cumulativeAtomCount !== atomCount) {
        addManifestIssue(
          context,
          ["segments", segmentIndex, "cumulativeAtomCount"],
          `Expected cumulativeAtomCount ${atomCount}`,
        );
      }
      if (segment.cumulativePrefixDigest !== digest) {
        addManifestIssue(
          context,
          ["segments", segmentIndex, "cumulativePrefixDigest"],
          "Cumulative prefix digest does not match the complete segment boundary",
        );
      }
    }
    if (
      !manifest.segments.some(
        (segment) => segment.canonicalStart === manifest.currentCanonicalStart,
      )
    ) {
      addManifestIssue(
        context,
        ["currentCanonicalStart"],
        "Current canonical input must begin at a complete segment start",
      );
    }
  });

export type CoreLineageManifestV1 = z.infer<typeof coreLineageManifestV1Schema>;

/** Build a validated manifest while deriving every range and rolling digest. */
export function buildCoreLineageManifestV1(
  inputs: readonly CoreLineageSegmentInputV1[],
  options?: { readonly currentSegmentIndex?: number },
): ResultType<CoreLineageManifestV1, CorePrimaryLineageInvalid> {
  let canonicalEnd = 0;
  let atomCount = 0;
  let digest = CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1;
  const segments: CoreLineageSegmentV1[] = [];

  for (const input of inputs) {
    const canonicalStart = canonicalEnd;
    canonicalEnd += input.canonicalMessages.length;
    for (const atom of input.atoms) {
      atomCount += 1;
      digest = extendValidatedCoreLineagePrefixDigestV1(digest, atomCount, atom);
    }
    segments.push({
      atoms: [...input.atoms],
      canonicalMessages: [...input.canonicalMessages],
      ...(input.requestSource
        ? { requestSource: { aliases: [...input.requestSource.aliases] } }
        : {}),
      canonicalStart,
      canonicalEnd,
      cumulativeAtomCount: atomCount,
      cumulativePrefixDigest: digest,
    });
  }

  const currentSegmentIndex = options?.currentSegmentIndex ?? Math.max(0, segments.length - 1);
  const currentSegment = segments[currentSegmentIndex];
  if (!currentSegment) {
    return invalidLineage([
      {
        path: ["currentSegmentIndex"],
        message: "Current Core lineage segment index is out of range",
      },
    ]);
  }
  const candidate = {
    state: "complete",
    lineageVersion: 1,
    currentCanonicalStart: currentSegment.canonicalStart,
    segments,
  } as const;
  const decoded = decodeCorePrimaryLineageV1(
    candidate,
    segments.flatMap((segment) => segment.canonicalMessages),
  );
  return decoded.andThen((lineage) =>
    lineage.state === "fresh-only"
      ? invalidLineage([{ path: ["state"], message: "Built lineage must be complete" }])
      : Result.ok(lineage),
  );
}

export const corePrimaryLineageFreshOnlyV1Schema = z.strictObject({
  state: z.literal("fresh-only"),
  lineageVersion: z.literal(1),
  currentCanonicalStart: z.number().int().nonnegative(),
  reason: nonemptyStringSchema,
});

export type CorePrimaryLineageFreshOnlyV1 = z.infer<typeof corePrimaryLineageFreshOnlyV1Schema>;

export const corePrimaryLineageV1Schema = z.discriminatedUnion("state", [
  coreLineageManifestV1Schema,
  corePrimaryLineageFreshOnlyV1Schema,
]);

export type CorePrimaryLineageV1 = z.infer<typeof corePrimaryLineageV1Schema>;

export class CorePrimaryLineageInvalid extends TaggedError("CorePrimaryLineageInvalid")<{
  readonly cause: unknown;
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
  readonly message: string;
}> {}

function invalidLineage(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ResultType<never, CorePrimaryLineageInvalid> {
  return Result.err(
    new CorePrimaryLineageInvalid({
      cause: undefined,
      issues,
      message: "Core primary lineage is invalid",
    }),
  );
}

type CapturedLineageFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary" };

function captureLineageFailure(cause: unknown): () => CapturedLineageFailure {
  return () => {
    const inspected = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspected.match({ ok: (value) => value, err: () => undefined });
    return panic ? { kind: "panic", panic } : { kind: "ordinary" };
  };
}

/** Decode lineage and project cross-field failures without ordinary exception flow. */
export function decodeCorePrimaryLineageV1(
  value: unknown,
  canonicalMessages: unknown,
): ResultType<CorePrimaryLineageV1, CorePrimaryLineageInvalid> {
  const captured = Result.try({
    try: () => {
      const decodedLineage = corePrimaryLineageV1Schema.safeParse(value);
      if (!decodedLineage.success) {
        return invalidLineage(
          decodedLineage.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        );
      }
      const decodedMessages = modelMessagesSchema.safeParse(canonicalMessages);
      if (!decodedMessages.success) {
        return invalidLineage(
          decodedMessages.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        );
      }

      const lineage = decodedLineage.data;
      const messages = decodedMessages.data;
      if (lineage.currentCanonicalStart > messages.length) {
        return invalidLineage([
          {
            path: ["currentCanonicalStart"],
            message: "Core primary current canonical start exceeds canonical messages",
          },
        ]);
      }
      if (lineage.state === "fresh-only") return Result.ok(lineage);

      const manifestMessages = lineage.segments.flatMap((segment) => segment.canonicalMessages);
      if (!isDeepStrictEqual(manifestMessages, messages)) {
        return invalidLineage([
          {
            path: [],
            message: "Core primary lineage does not exactly align with canonical messages",
          },
        ]);
      }
      return Result.ok(lineage);
    },
    catch: captureLineageFailure,
  });
  const outcome = captured
    .mapError((settle) => settle())
    .match<
      | {
          readonly kind: "result";
          readonly result: ResultType<CorePrimaryLineageV1, CorePrimaryLineageInvalid>;
        }
      | { readonly kind: "failed"; readonly failure: CapturedLineageFailure }
    >({
      ok: (result) => ({ kind: "result", result }),
      err: (failure) => ({ kind: "failed", failure }),
    });
  if (outcome.kind === "result") return outcome.result;
  if (outcome.failure.kind === "panic") return signalEventBusPanic(outcome.failure.panic);
  return Result.err(
    new CorePrimaryLineageInvalid({
      cause: undefined,
      issues: [{ path: [], message: "Core primary lineage validation failed" }],
      message: "Core primary lineage is invalid",
    }),
  );
}

export function createCorePrimaryLineageFreshOnlyV1(
  reason: string,
  currentCanonicalStart = 0,
): ResultType<CorePrimaryLineageFreshOnlyV1, CorePrimaryLineageInvalid> {
  if (reason.length === 0) {
    return invalidLineage([{ path: ["reason"], message: "Reason must not be empty" }]);
  }
  if (!Number.isSafeInteger(currentCanonicalStart) || currentCanonicalStart < 0) {
    return invalidLineage([
      {
        path: ["currentCanonicalStart"],
        message: "Current canonical start must be a non-negative safe integer",
      },
    ]);
  }
  return Result.ok({
    state: "fresh-only",
    lineageVersion: 1,
    currentCanonicalStart,
    reason,
  });
}
