import { describe, expect, it } from "bun:test";
import { Panic, type Result as ResultType } from "better-result";

import {
  CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1,
  buildCoreLineageManifestV1,
  canonicalizeCoreLineageAtomV1,
  computeCoreLineagePrefixDigestV1,
  coreLineageManifestV1Schema,
  createCorePrimaryLineageFreshOnlyV1,
  decodeCorePrimaryLineageV1,
  extendCoreLineagePrefixDigestV1,
  parseCmdRequestMessageData,
  type CoreLineageAtomV1,
  type CoreLineageManifestV1,
} from "../index";

function requireOk<TValue, TError>(result: ResultType<TValue, TError>): TValue {
  if (result.status === "error") throw result.error;
  return result.value;
}

const ATOMS = [
  {
    kind: "surface",
    requestClient: "discord",
    surfaceId: "discord",
    sessionId: "channel-1",
    messageId: "message-1",
  },
  {
    kind: "request",
    requestId: "request-1",
    transcriptDigest: "11".repeat(32),
    providerFamily: "claude-code",
    containsCrossFamilyTurns: false,
  },
  {
    kind: "synthetic",
    source: "system-policy",
    messageDigest: "22".repeat(32),
  },
  {
    kind: "checkpoint",
    requestId: "request-2",
    transcriptDigest: "33".repeat(32),
  },
] as const satisfies readonly CoreLineageAtomV1[];

const MESSAGES = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "system", content: "policy" },
  { role: "user", content: "checkpoint summary" },
] as const;

const PREFIX_DIGESTS = [
  "f539523f73602b1c24c7a27665d87778ff5a71c133780de2fd9d6ddc4bf3d28a",
  "80ec83c7179813804bf1eddc3d5316a9e815e5fb9f7aae65c35ace25c542d5ec",
  "664e1f9e57024688e2aafde001a30346b1e6ac0527809347cff43a2af15d7235",
  "4d150080d79d04144a19b6a02d166e7f9fa11d3ea7d44776cbfe7b2038326752",
] as const;

function manifestFixture(): CoreLineageManifestV1 {
  return coreLineageManifestV1Schema.parse({
    state: "complete",
    lineageVersion: 1,
    currentCanonicalStart: 3,
    segments: ATOMS.map((atom, index) => ({
      atoms: [atom],
      canonicalMessages: [MESSAGES[index]],
      ...(atom.kind === "request"
        ? {
            requestSource: {
              aliases: [
                {
                  requestClient: "discord",
                  surfaceId: "discord",
                  sessionId: "channel-1",
                  messageId: "request-output-1",
                },
              ],
            },
          }
        : {}),
      canonicalStart: index,
      canonicalEnd: index + 1,
      cumulativeAtomCount: index + 1,
      cumulativePrefixDigest: PREFIX_DIGESTS[index],
    })),
  });
}

describe("Core primary lineage v1", () => {
  it("uses stable canonical atoms and golden rolling SHA-256 digests", () => {
    expect(CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1).toBe(
      "be2c6d557c38e467a191a1a8be0f941accdea02cda13fe833c294d803f4b3bd6",
    );
    expect(canonicalizeCoreLineageAtomV1(ATOMS[0])).toBe(
      '{"kind":"surface","messageId":"message-1","requestClient":"discord","sessionId":"channel-1","surfaceId":"discord"}',
    );

    let digest = CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1;
    for (const [index, atom] of ATOMS.entries()) {
      digest = requireOk(extendCoreLineagePrefixDigestV1(digest, index + 1, atom));
      expect(digest).toBe(PREFIX_DIGESTS[index]!);
    }
    expect(computeCoreLineagePrefixDigestV1(ATOMS)).toBe(PREFIX_DIGESTS[3]);
  });

  it("accepts complete contiguous segment boundaries aligned to request messages", () => {
    const manifest = manifestFixture();
    const decoded = decodeCorePrimaryLineageV1(manifest, MESSAGES);
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") expect(decoded.value).toEqual(manifest);
    expect(
      parseCmdRequestMessageData({
        queue: "prompt",
        messages: MESSAGES,
        corePrimaryLineage: manifest,
      }).corePrimaryLineage,
    ).toEqual(manifest);
  });

  it("rejects non-canonical ranges, cumulative counts, and rolling digests", () => {
    const rangeGap = structuredClone(manifestFixture());
    rangeGap.segments[1]!.canonicalStart = 0;
    expect(() => coreLineageManifestV1Schema.parse(rangeGap)).toThrow("canonicalStart");

    const incompleteRange = structuredClone(manifestFixture());
    incompleteRange.segments[2]!.canonicalEnd = 4;
    expect(() => coreLineageManifestV1Schema.parse(incompleteRange)).toThrow("canonicalEnd");

    const staleCount = structuredClone(manifestFixture());
    staleCount.segments[3]!.cumulativeAtomCount = 3;
    expect(() => coreLineageManifestV1Schema.parse(staleCount)).toThrow("cumulativeAtomCount");

    const staleDigest = structuredClone(manifestFixture());
    staleDigest.segments[2]!.cumulativePrefixDigest = "00".repeat(32);
    expect(() => coreLineageManifestV1Schema.parse(staleDigest)).toThrow(
      "Cumulative prefix digest",
    );
  });

  it("rejects empty contracts and exact message misalignment", () => {
    expect(() =>
      coreLineageManifestV1Schema.parse({
        state: "complete",
        lineageVersion: 1,
        currentCanonicalStart: 0,
        segments: [],
      }),
    ).toThrow();

    const emptyAtoms = structuredClone(manifestFixture());
    emptyAtoms.segments[0]!.atoms = [];
    expect(() => coreLineageManifestV1Schema.parse(emptyAtoms)).toThrow();

    expect(
      decodeCorePrimaryLineageV1(manifestFixture(), [
        { role: "user", content: "edited" },
        ...MESSAGES.slice(1),
      ]).status,
    ).toBe("error");

    const midSegmentBoundary = structuredClone(manifestFixture());
    midSegmentBoundary.currentCanonicalStart = 2.5;
    expect(() => coreLineageManifestV1Schema.parse(midSegmentBoundary)).toThrow();
  });

  it("requires exact segment variants and globally unique source claims", () => {
    const mixed = structuredClone(manifestFixture());
    mixed.segments[0]!.atoms.push(ATOMS[2]);
    expect(() => coreLineageManifestV1Schema.parse(mixed)).toThrow(
      "must contain only surface atoms",
    );

    const requestWithoutSource = structuredClone(manifestFixture());
    delete requestWithoutSource.segments[1]!.requestSource;
    expect(() => coreLineageManifestV1Schema.parse(requestWithoutSource)).toThrow(
      "request output alias",
    );

    const checkpointWithSource = structuredClone(manifestFixture());
    checkpointWithSource.segments[3]!.requestSource = {
      aliases: [
        {
          requestClient: "discord",
          surfaceId: "discord",
          sessionId: "channel-1",
          messageId: "checkpoint-output",
        },
      ],
    };
    expect(() => coreLineageManifestV1Schema.parse(checkpointWithSource)).toThrow(
      "Only a request segment",
    );

    const duplicateSurface = structuredClone(manifestFixture());
    duplicateSurface.segments[1]!.requestSource!.aliases[0] = {
      requestClient: "discord",
      surfaceId: "discord",
      sessionId: "channel-1",
      messageId: "message-1",
    };
    expect(() => coreLineageManifestV1Schema.parse(duplicateSurface)).toThrow("already claimed");
  });

  it("requires malformed lineage to be replaced explicitly with fresh-only state", () => {
    const malformed = structuredClone(manifestFixture());
    malformed.segments[0]!.cumulativePrefixDigest = "ff".repeat(32);
    expect(decodeCorePrimaryLineageV1(malformed, MESSAGES).status).toBe("error");

    const freshOnly = requireOk(createCorePrimaryLineageFreshOnlyV1("malformed-manifest"));
    const decoded = decodeCorePrimaryLineageV1(freshOnly, MESSAGES);
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(decoded.value).toEqual({
        state: "fresh-only",
        lineageVersion: 1,
        currentCanonicalStart: 0,
        reason: "malformed-manifest",
      });
    }
  });

  it("returns owned Results for invalid digest and constructor inputs", () => {
    expect(extendCoreLineagePrefixDigestV1("invalid", 1, ATOMS[0]).status).toBe("error");
    expect(
      extendCoreLineagePrefixDigestV1(CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V1, 0, ATOMS[0]).status,
    ).toBe("error");
    expect(createCorePrimaryLineageFreshOnlyV1("").status).toBe("error");
    expect(createCorePrimaryLineageFreshOnlyV1("valid", -1).status).toBe("error");
    expect(buildCoreLineageManifestV1([]).status).toBe("error");
    expect(
      buildCoreLineageManifestV1([{ atoms: [ATOMS[2]], canonicalMessages: [MESSAGES[2]] }]).status,
    ).toBe("ok");
  });

  it("projects lineage mismatch into Result and command-schema issues", () => {
    const editedMessages = [{ role: "user" as const, content: "edited" }, ...MESSAGES.slice(1)];
    const decoded = decodeCorePrimaryLineageV1(manifestFixture(), editedMessages);
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error.issues).toContainEqual({
        path: [],
        message: "Core primary lineage does not exactly align with canonical messages",
      });
    }
    expect(() =>
      parseCmdRequestMessageData({
        queue: "prompt",
        messages: editedMessages,
        corePrimaryLineage: manifestFixture(),
      }),
    ).toThrow("does not exactly align");
  });

  it("maps ordinary decoder exceptions and preserves Panic at the exact boundary", () => {
    const ordinaryFailure = Object.defineProperty({}, "state", {
      get() {
        throw new Error("ordinary getter failure");
      },
    });
    const decoded = decodeCorePrimaryLineageV1(ordinaryFailure, MESSAGES);
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error.issues).toEqual([
        { path: [], message: "Core primary lineage validation failed" },
      ]);
    }

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const revokedFailure = Object.defineProperty({}, "state", {
      get() {
        throw proxy;
      },
    });
    expect(decodeCorePrimaryLineageV1(revokedFailure, MESSAGES).status).toBe("error");

    const panic = new Panic({ message: "lineage invariant" });
    const panicFailure = Object.defineProperty({}, "state", {
      get() {
        throw panic;
      },
    });
    expect(() => decodeCorePrimaryLineageV1(panicFailure, MESSAGES)).toThrow(panic);
  });
});
