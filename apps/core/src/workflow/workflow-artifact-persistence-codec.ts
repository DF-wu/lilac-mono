import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { DecodedPersistedValue } from "@stanley2058/lilac-utils";

import { canonicalJson, sha256 } from "./workflow-definition";
import { jsonValueSchema, type JsonValue } from "./workflow-domain";

export const WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION = 1;

const WORKFLOW_VALUE_ARTIFACT_FORMAT = "lilac-workflow-value";
const WORKFLOW_VALUE_ARTIFACT_ENCODING = "canonical-json";

const artifactEnvelopeHeaderSchema = z
  .object({ format: z.literal(WORKFLOW_VALUE_ARTIFACT_FORMAT) })
  .passthrough();
const artifactEnvelopeVersionSchema = z
  .object({
    format: z.literal(WORKFLOW_VALUE_ARTIFACT_FORMAT),
    version: z.number().int(),
  })
  .passthrough();
const currentArtifactEnvelopeSchema = z.strictObject({
  format: z.literal(WORKFLOW_VALUE_ARTIFACT_FORMAT),
  version: z.literal(WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION),
  encoding: z.literal(WORKFLOW_VALUE_ARTIFACT_ENCODING).optional(),
  value: jsonValueSchema,
});

export type WorkflowValueArtifactCodecInput = {
  readonly encoded: string;
  readonly expectedHash: string;
  readonly maxValueBytes: number;
  readonly artifactId: string;
};

type WorkflowArtifactCorruptionIssue =
  | "invalid-json-value"
  | "invalid-version"
  | "invalid-wrapper-fields"
  | "non-canonical-json"
  | "value-too-large";

export class WorkflowArtifactUnsupportedVersion extends TaggedError(
  "WorkflowArtifactUnsupportedVersion",
)<{
  readonly artifactId: string;
  readonly version: number;
  readonly message: string;
}> {}

export class WorkflowArtifactMalformedJson extends TaggedError("WorkflowArtifactMalformedJson")<{
  readonly artifactId: string;
  readonly message: string;
}> {}

export class WorkflowArtifactCorruptFields extends TaggedError("WorkflowArtifactCorruptFields")<{
  readonly artifactId: string;
  readonly issue: WorkflowArtifactCorruptionIssue;
  readonly message: string;
}> {}

export class WorkflowArtifactHashMismatch extends TaggedError("WorkflowArtifactHashMismatch")<{
  readonly artifactId: string;
  readonly message: string;
}> {}

export type WorkflowArtifactCodecError =
  | WorkflowArtifactUnsupportedVersion
  | WorkflowArtifactMalformedJson
  | WorkflowArtifactCorruptFields
  | WorkflowArtifactHashMismatch;

function corrupt(
  artifactId: string,
  issue: WorkflowArtifactCorruptionIssue,
): WorkflowArtifactCorruptFields {
  return new WorkflowArtifactCorruptFields({
    artifactId,
    issue,
    message: `Workflow value artifact has ${issue.replaceAll("-", " ")}`,
  });
}

export function encodeWorkflowValueArtifact(value: JsonValue): {
  readonly encoded: string;
  readonly payloadHash: string;
  readonly payloadBytes: number;
} {
  const payload = canonicalJson(value);
  return {
    encoded: canonicalJson({
      encoding: WORKFLOW_VALUE_ARTIFACT_ENCODING,
      format: WORKFLOW_VALUE_ARTIFACT_FORMAT,
      value,
      version: WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION,
    }),
    payloadHash: sha256(payload),
    payloadBytes: Buffer.byteLength(payload, "utf8"),
  };
}

export function workflowValueArtifactFileByteLimit(maxValueBytes: number): number {
  const empty = encodeWorkflowValueArtifact(null);
  return maxValueBytes + Buffer.byteLength(empty.encoded, "utf8") - empty.payloadBytes;
}

export function decodeWorkflowValueArtifact(
  input: WorkflowValueArtifactCodecInput,
): ResultType<DecodedPersistedValue<JsonValue>, WorkflowArtifactCodecError> {
  const parsedResult = Result.try({
    try: (): unknown => JSON.parse(input.encoded),
    catch: () =>
      new WorkflowArtifactMalformedJson({
        artifactId: input.artifactId,
        message: "Workflow value artifact contains malformed JSON",
      }),
  });
  const parsedOutcome = parsedResult.match<
    | { readonly kind: "success"; readonly parsed: unknown }
    | { readonly kind: "failure"; readonly error: WorkflowArtifactMalformedJson }
  >({
    ok: (parsed) => ({ kind: "success", parsed }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (parsedOutcome.kind === "failure") return Result.err(parsedOutcome.error);
  const { parsed } = parsedOutcome;

  const json = jsonValueSchema.safeParse(parsed);
  if (!json.success) return Result.err(corrupt(input.artifactId, "invalid-json-value"));
  if (canonicalJson(json.data) !== input.encoded) {
    return Result.err(corrupt(input.artifactId, "non-canonical-json"));
  }

  if (sha256(input.encoded) === input.expectedHash) {
    if (Buffer.byteLength(input.encoded, "utf8") > input.maxValueBytes) {
      return Result.err(corrupt(input.artifactId, "value-too-large"));
    }
    return Result.ok({ value: json.data, provenance: "migrated" });
  }

  const header = artifactEnvelopeHeaderSchema.safeParse(parsed);
  if (!header.success) {
    return Result.err(
      new WorkflowArtifactHashMismatch({
        artifactId: input.artifactId,
        message: "Workflow value artifact payload hash does not match its ID",
      }),
    );
  }
  const version = artifactEnvelopeVersionSchema.safeParse(parsed);
  if (!version.success) return Result.err(corrupt(input.artifactId, "invalid-version"));
  if (version.data.version !== WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION) {
    return Result.err(
      new WorkflowArtifactUnsupportedVersion({
        artifactId: input.artifactId,
        version: version.data.version,
        message: `Workflow value artifact version ${version.data.version} is unsupported`,
      }),
    );
  }
  const current = currentArtifactEnvelopeSchema.safeParse(parsed);
  if (!current.success) return Result.err(corrupt(input.artifactId, "invalid-wrapper-fields"));

  const payload = canonicalJson(current.data.value);
  if (Buffer.byteLength(payload, "utf8") > input.maxValueBytes) {
    return Result.err(corrupt(input.artifactId, "value-too-large"));
  }
  if (sha256(payload) !== input.expectedHash) {
    return Result.err(
      new WorkflowArtifactHashMismatch({
        artifactId: input.artifactId,
        message: "Workflow value artifact payload hash does not match its ID",
      }),
    );
  }
  return Result.ok({
    value: current.data.value,
    provenance: current.data.encoding === undefined ? "missing-defaulted" : "current",
  });
}

const fixtureValue: JsonValue = { nested: ["fixture", 1, true] };
const fixturePayload = canonicalJson(fixtureValue);
const fixtureHash = sha256(fixturePayload);
const fixtureArtifactId = `workflow-value:${fixtureHash}`;
const fixtureCurrent = encodeWorkflowValueArtifact(fixtureValue).encoded;
const fixtureMissingEncoding = canonicalJson({
  format: WORKFLOW_VALUE_ARTIFACT_FORMAT,
  value: fixtureValue,
  version: WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION,
});

export const workflowValueArtifactCodecCases = {
  current: {
    input: {
      encoded: fixtureCurrent,
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      encoded: fixturePayload,
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: {
      encoded: fixtureMissingEncoding,
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      encoded: canonicalJson({
        encoding: WORKFLOW_VALUE_ARTIFACT_ENCODING,
        format: WORKFLOW_VALUE_ARTIFACT_FORMAT,
        value: fixtureValue,
        version: 2,
      }),
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: {
      encoded: "{",
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      encoded: canonicalJson({
        encoding: "unknown",
        format: WORKFLOW_VALUE_ARTIFACT_FORMAT,
        value: fixtureValue,
        version: WORKFLOW_VALUE_ARTIFACT_FORMAT_VERSION,
      }),
      expectedHash: fixtureHash,
      maxValueBytes: 1024,
      artifactId: fixtureArtifactId,
    },
    outcome: "error",
  },
} as const;
