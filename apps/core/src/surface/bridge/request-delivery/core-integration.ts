import {
  blobHandleV1Schema,
  blobRefV1Schema,
  type BlobHandleV1,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import {
  adapterPlatformSchema,
  cmdRequestMessageDataSchema,
  corePrimaryLineageV2Schema,
  decodeCorePrimaryLineageV2,
  EventPostCommitObservationFailed,
  lilacEventTypes,
  outReqTopic,
  requestOriginSchema,
  requestQueueModeSchema,
  requestRunPolicySchema,
  storedMessagesV1Schema,
  type CmdRequestMessageData,
  type CorePrimaryLineageV2,
  type LilacBus,
  type DecodedLilacMessage,
  type EventDeliveryContext,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import { verifyStoredBlobReferencesV1 } from "../../../transcript/stored-message-materialization";
import type { RequestDeliveryCodecs } from "./sqlite-store";
import { SqliteRequestDeliveryStore } from "./sqlite-store";
import { RequestDeliveryCoordinator } from "./coordinator";
import {
  RequestDeliveryAdmissionRejected,
  type RequestDeliveryAdmission,
  type RequestDeliveryPublisher,
  type RequestDeliveryValueCodec,
  type RequestOutputReplayRecovery,
  type RequestOutputReplayRecoveryOutcome,
} from "./types";

const coreRequestHeadersSchema = z
  .record(z.string(), z.string())
  .refine((headers) => typeof headers.request_id === "string" && headers.request_id.length > 0, {
    message: "request_id is required",
  })
  .refine((headers) => typeof headers.session_id === "string" && headers.session_id.length > 0, {
    message: "session_id is required",
  })
  .refine((headers) => adapterPlatformSchema.safeParse(headers.request_client).success, {
    message: "request_client is required",
  });

export const corePreparedRequestEnvelopeSchema = z.strictObject({
  headers: coreRequestHeadersSchema,
  data: cmdRequestMessageDataSchema,
});

export type CorePreparedRequestEnvelope = z.output<typeof corePreparedRequestEnvelopeSchema>;

const coreAcceptedRequestDataSchema = z.strictObject({
  requestDeliveryId: z.uuid(),
  queue: requestQueueModeSchema,
  messages: storedMessagesV1Schema,
  corePrimaryLineage: corePrimaryLineageV2Schema.optional(),
  runPolicy: requestRunPolicySchema.optional(),
  origin: requestOriginSchema.optional(),
  modelOverride: z.string().optional(),
  raw: z.unknown().optional(),
});

export const coreAcceptedRequestWorkSchema = z.strictObject({
  requestDeliveryId: z.uuid(),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  requestClient: adapterPlatformSchema,
  headers: coreRequestHeadersSchema,
  data: coreAcceptedRequestDataSchema,
});

export type CoreAcceptedRequestWork = z.output<typeof coreAcceptedRequestWorkSchema>;

export const coreRequestOutputMetadataSchema = z.strictObject({
  mimeType: z.string().min(1),
  filename: z.string().optional(),
});

export type CoreRequestOutputMetadata = z.output<typeof coreRequestOutputMetadataSchema>;

function zodCodec<T>(schema: z.ZodType<T>): RequestDeliveryValueCodec<T> {
  return {
    decode(value) {
      const decoded = schema.safeParse(value);
      return decoded.success ? Result.ok(decoded.data) : Result.err(decoded.error);
    },
    serialize(value) {
      const decoded = schema.safeParse(value);
      if (!decoded.success) return Result.err(decoded.error);
      return Result.try({
        try: () => SuperJSON.stringify(decoded.data),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Request delivery SuperJSON serialization failed", {
                cause,
              }),
      });
    },
    deserialize(value) {
      return Result.try({
        try: () => SuperJSON.parse(value) as unknown,
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Request delivery SuperJSON decoding failed", {
                cause,
              }),
      }).andThen((decoded) => {
        const validated = schema.safeParse(decoded);
        return validated.success ? Result.ok(validated.data) : Result.err(validated.error);
      });
    },
  };
}

export const coreRequestDeliveryCodecs: RequestDeliveryCodecs<
  CorePreparedRequestEnvelope,
  CoreAcceptedRequestWork,
  CoreRequestOutputMetadata
> = {
  envelope: zodCodec(corePreparedRequestEnvelopeSchema),
  acceptedWork: zodCodec(coreAcceptedRequestWorkSchema),
  outputMetadata: zodCodec(coreRequestOutputMetadataSchema),
};

function replaceHandles(value: unknown, references: ReadonlyMap<string, BlobRefV1>): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceHandles(entry, references));
  if (typeof value !== "object" || value === null) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "blob") {
    const handle = blobHandleV1Schema.safeParse(candidate.blob);
    if (handle.success) {
      const reference = references.get(handle.data.objectId);
      return reference ? { ...candidate, blob: reference } : value;
    }
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([key, child]) => [key, replaceHandles(child, references)]),
  );
}

function collectHandles(value: unknown, handles: Map<string, BlobHandleV1>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectHandles(entry, handles);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "blob") {
    const decoded = blobHandleV1Schema.safeParse(candidate.blob);
    if (decoded.success) handles.set(decoded.data.objectId, decoded.data);
  }
  for (const child of Object.values(candidate)) collectHandles(child, handles);
}

/** All distinct pending handles in messages and lineage, in first-use order. */
export function collectCoreRequestInputHandles(
  envelope: CorePreparedRequestEnvelope,
): readonly BlobHandleV1[] {
  const handles = new Map<string, BlobHandleV1>();
  collectHandles(envelope.data.messages, handles);
  collectHandles(envelope.data.corePrimaryLineage, handles);
  return [...handles.values()];
}

function decodeStoredMessages(
  value: unknown,
): ResultType<readonly StoredMessageV1[], RequestDeliveryAdmissionRejected> {
  const decoded = storedMessagesV1Schema.safeParse(value);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new RequestDeliveryAdmissionRejected({
          requestDeliveryId: "unknown",
          disposition: "terminal",
          code: "resolved-message-invalid",
          message: "Resolved request messages failed the durable message codec",
        }),
      );
}

export function createCoreRequestDeliveryAdmission(
  blobStore: Pick<BlobStore, "open">,
): RequestDeliveryAdmission<CorePreparedRequestEnvelope, CoreAcceptedRequestWork> {
  return {
    async validateAndBuildWork(
      input,
    ): Promise<ResultType<CoreAcceptedRequestWork, RequestDeliveryAdmissionRejected>> {
      const expectedHandles = collectCoreRequestInputHandles(input.envelope);
      if (expectedHandles.length !== input.inputReferences.length) {
        return Result.err(
          new RequestDeliveryAdmissionRejected({
            requestDeliveryId: input.requestDeliveryId,
            disposition: "terminal",
            code: "resolved-handle-count-mismatch",
            message: "Resolved request input references do not match the prepared handle set",
          }),
        );
      }
      const references = new Map<string, BlobRefV1>();
      for (const [index, handle] of expectedHandles.entries()) {
        const reference = input.inputReferences[index];
        if (!reference || reference.objectId !== handle.objectId) {
          return Result.err(
            new RequestDeliveryAdmissionRejected({
              requestDeliveryId: input.requestDeliveryId,
              disposition: "terminal",
              code: "resolved-handle-identity-mismatch",
              message: "Resolved request input changed a blob object identity",
            }),
          );
        }
        const strictReference = blobRefV1Schema.safeParse(reference);
        if (!strictReference.success) {
          return Result.err(
            new RequestDeliveryAdmissionRejected({
              requestDeliveryId: input.requestDeliveryId,
              disposition: "terminal",
              code: "resolved-reference-invalid",
              message: "Resolved request input reference failed its strict codec",
            }),
          );
        }
        references.set(handle.objectId, strictReference.data);
      }

      const resolvedMessagesValue = replaceHandles(input.envelope.data.messages, references);
      const resolvedLineageValue = replaceHandles(
        input.envelope.data.corePrimaryLineage,
        references,
      );
      const decodedMessages = decodeStoredMessages(resolvedMessagesValue).mapError(
        (error) =>
          new RequestDeliveryAdmissionRejected({
            requestDeliveryId: input.requestDeliveryId,
            disposition: error.disposition,
            code: error.code,
            message: error.message,
          }),
      );
      return Result.gen(async function* validateResolvedRequestContent() {
        const messages = yield* decodedMessages;
        yield* Result.await(
          verifyStoredBlobReferencesV1({
            references: [...references.values()],
            blobStore,
          }).then((verified) =>
            verified.mapError(
              (error) =>
                new RequestDeliveryAdmissionRejected({
                  requestDeliveryId: input.requestDeliveryId,
                  disposition: "terminal",
                  code: "resolved-reference-unreadable",
                  message: `Resolved request blob failed verified read at ${error.stage}`,
                }),
            ),
          ),
        );
        const lineage: ResultType<
          CorePrimaryLineageV2 | undefined,
          RequestDeliveryAdmissionRejected
        > = input.envelope.data.corePrimaryLineage
          ? decodeCorePrimaryLineageV2(resolvedLineageValue, messages).mapError(
              () =>
                new RequestDeliveryAdmissionRejected({
                  requestDeliveryId: input.requestDeliveryId,
                  disposition: "terminal",
                  code: "resolved-lineage-invalid",
                  message: "Content-dependent request lineage validation failed",
                }),
            )
          : Result.ok(undefined);
        const corePrimaryLineage = yield* lineage;
        const data: CoreAcceptedRequestWork["data"] = {
          ...input.envelope.data,
          messages: [...messages],
          ...(corePrimaryLineage ? { corePrimaryLineage } : {}),
        };
        const work = coreAcceptedRequestWorkSchema.safeParse({
          requestDeliveryId: input.requestDeliveryId,
          requestId: input.requestId,
          sessionId: input.envelope.headers.session_id,
          requestClient: input.envelope.headers.request_client,
          headers: input.envelope.headers,
          data,
        });
        const acceptedWork = work.success
          ? Result.ok(work.data)
          : Result.err(
              new RequestDeliveryAdmissionRejected({
                requestDeliveryId: input.requestDeliveryId,
                disposition: "terminal",
                code: "accepted-work-invalid",
                message: "Resolved request failed its durable accepted-work codec",
              }),
            );
        return Result.ok(yield* acceptedWork);
      });
    },
  };
}

export function createLilacBusRequestDeliveryPublisher(
  bus: Pick<
    LilacBus,
    | "abandonRequestPublicationClaim"
    | "acquireRequestPublicationClaim"
    | "confirmRequestPublication"
    | "publishClaimedRequest"
  >,
): RequestDeliveryPublisher<CorePreparedRequestEnvelope> {
  return {
    acquire(input) {
      return bus
        .acquireRequestPublicationClaim(input.requestDeliveryId)
        .then((result) =>
          result
            .map((outcome) =>
              outcome.status === "acquired"
                ? { status: "acquired" as const, claim: outcome.claim }
                : { status: "contended" as const },
            )
            .mapError((error) => error),
        );
    },
    publish(input) {
      if (
        input.requestDeliveryId !== input.envelope.data.requestDeliveryId ||
        input.claim.requestDeliveryId !== input.requestDeliveryId
      ) {
        return Promise.resolve(
          Result.err(new Error("Prepared request delivery ID does not match its wire envelope")),
        );
      }
      return bus
        .publishClaimedRequest(input.envelope.data, input.claim, {
          headers: input.envelope.headers,
        })
        .then((result) => result.map(({ id }) => ({ streamId: id })).mapError((error) => error));
    },
    classifyFailure(error) {
      return {
        certainty: error.name === "EventPublishContractInvalid" ? "known" : "ambiguous",
        code: error.name,
      };
    },
    confirm(input) {
      return bus
        .confirmRequestPublication(input.claim, input.streamId)
        .then((result) => result.map((outcome) => outcome).mapError((error) => error));
    },
    abandon(input) {
      return bus
        .abandonRequestPublicationClaim(input.claim)
        .then((result) => result.map((outcome) => outcome).mapError((error) => error));
    },
  };
}

export function createRequestDeliveryPostCommitObserver(input: {
  readonly observeTransportCommit: (
    requestDeliveryId: string,
    streamId: string,
  ) => ResultType<void, Error>;
}) {
  return {
    async observe(
      message: DecodedLilacMessage,
      context: Extract<EventDeliveryContext, { mode: "work" | "fanout" }>,
    ): Promise<ResultType<void, EventPostCommitObservationFailed>> {
      if (message.type !== lilacEventTypes.CmdRequestMessage) return Result.ok(undefined);
      const request = cmdRequestMessageDataSchema.safeParse(message.data);
      if (!request.success) return Result.ok(undefined);
      return input.observeTransportCommit(request.data.requestDeliveryId, context.cursor).mapError(
        (cause) =>
          new EventPostCommitObservationFailed({
            cause,
            topic: message.topic,
            cursor: context.cursor,
            message: "Could not durably observe the committed Core request delivery",
          }),
      );
    },
  };
}

/**
 * Finds durable evidence that output production reached its terminal response,
 * then reads the transport-owned replay deadline. Missing or incomplete output
 * remains resumable. Once terminal output is proven, an uncertain expiry is
 * returned as a successful retain decision so recovery cannot repeat request
 * side effects while Core retains every output lifecycle record.
 */
export function createCoreRequestOutputReplayRecovery(
  bus: Pick<LilacBus, "fetchTopic" | "getOutputStreamExpiry">,
): RequestOutputReplayRecovery {
  return {
    async inspect(input) {
      const { requestId, requestDeliveryId } = input;
      const topic = outReqTopic(requestId);
      let cursor: string | undefined;
      let terminalOutputObserved = false;
      for (;;) {
        const fetched = await bus.fetchTopic(topic, {
          offset: cursor ? { type: "cursor", cursor } : { type: "begin" },
          limit: 1_000,
        });
        const batch = fetched.match<
          | {
              readonly kind: "ok";
              readonly messages: readonly {
                readonly msg: {
                  readonly type: string;
                  readonly headers?: Readonly<Record<string, string>>;
                };
              }[];
              readonly next?: string;
            }
          | { readonly kind: "error"; readonly error: Error }
        >({
          ok: ({ messages, next }) => ({
            kind: "ok",
            messages,
            ...(next === undefined ? {} : { next }),
          }),
          err: (error) => ({ kind: "error", error }),
        });
        if (batch.kind === "error") return Result.err(batch.error);
        terminalOutputObserved = batch.messages.some(
          ({ msg }) =>
            msg.type === lilacEventTypes.EvtAgentOutputResponseText &&
            msg.headers?.request_delivery_id === requestDeliveryId,
        );
        if (terminalOutputObserved) break;
        const previous = cursor;
        cursor = batch.next;
        if (batch.messages.length < 1_000 || cursor === undefined || cursor === previous) break;
      }

      if (!terminalOutputObserved) {
        return Result.ok({
          disposition: "resume",
          reason: "no-terminal-output",
        });
      }
      return (await bus.getOutputStreamExpiry(requestId)).match<
        ResultType<RequestOutputReplayRecoveryOutcome, Error>
      >({
        err: (uncertainty) => Result.ok({ disposition: "retain-terminal", uncertainty } as const),
        ok: (expiry) =>
          Result.ok(
            expiry.kind === "absent"
              ? ({ disposition: "terminalize", replayDeadline: 0 } as const)
              : ({
                  disposition: "terminalize",
                  replayDeadline: expiry.expiresAt,
                } as const),
          ),
      });
    },
  };
}

export function corePreparedEnvelopeFromCommand(input: {
  readonly headers: Record<string, string>;
  readonly data: CmdRequestMessageData;
}): ResultType<CorePreparedRequestEnvelope, Error> {
  const decoded = corePreparedRequestEnvelopeSchema.safeParse(input);
  return decoded.success ? Result.ok(decoded.data) : Result.err(decoded.error);
}

export function createCoreRequestDelivery(input: {
  readonly dbPath: string;
  readonly blobStore: Pick<BlobStore, "resolve" | "open" | "delete">;
  readonly now?: () => number;
}) {
  const store = new SqliteRequestDeliveryStore({
    dbPath: input.dbPath,
    codecs: coreRequestDeliveryCodecs,
  });
  const coordinator = new RequestDeliveryCoordinator({
    store,
    blobStore: input.blobStore,
    admission: createCoreRequestDeliveryAdmission(input.blobStore),
    ...(input.now ? { now: input.now } : {}),
  });
  return { store, coordinator } as const;
}
