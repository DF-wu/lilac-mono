import {
  EventPublishContractInvalid,
  EventPublishTransportFailed,
  lilacEventTypes,
  type LilacBus,
  type LilacTopicForType,
} from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import type { RequestDeliveryCoordinator } from "./coordinator";
import {
  collectCoreRequestInputHandles,
  corePreparedRequestEnvelopeSchema,
  type CoreAcceptedRequestWork,
  type CorePreparedRequestEnvelope,
  type CoreRequestOutputMetadata,
} from "./core-integration";
import type { RequestDeliveryPublisher } from "./types";

type CoreRequestDeliveryCoordinator = RequestDeliveryCoordinator<
  CorePreparedRequestEnvelope,
  CoreAcceptedRequestWork,
  CoreRequestOutputMetadata
>;

/**
 * Routes every Core-owned cmd.request publication through the durable prepared
 * record. The transport bus remains private to the coordinator publisher so a
 * recovered publication cannot recursively prepare itself.
 */
export function createDurableCoreRequestBus(input: {
  readonly transportBus: LilacBus;
  readonly coordinator: CoreRequestDeliveryCoordinator;
  readonly publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope>;
}): LilacBus {
  const bus: LilacBus = {
    publish: async (type, data, options) => {
      if (type !== lilacEventTypes.CmdRequestMessage) {
        return input.transportBus.publish(type, data, options);
      }

      const envelope = corePreparedRequestEnvelopeSchema.safeParse({
        headers: options?.headers,
        data,
      });
      if (!envelope.success) {
        return Result.err(
          new EventPublishContractInvalid({
            eventType: type,
            message: "cmd.request failed its durable prepared-envelope contract",
          }),
        );
      }
      const requestId = envelope.data.headers.request_id;
      if (!requestId) {
        return Result.err(
          new EventPublishContractInvalid({
            eventType: type,
            message: "cmd.request durable envelope is missing headers.request_id",
          }),
        );
      }

      const prepared = await input.coordinator.prepareAndPublish(
        {
          requestDeliveryId: envelope.data.data.requestDeliveryId,
          requestId,
          envelope: envelope.data,
          inputHandles: collectCoreRequestInputHandles(envelope.data),
        },
        input.publisher,
      );
      return prepared.match({
        err: (cause) =>
          Result.err(
            new EventPublishTransportFailed({
              cause,
              eventType: type,
              topic: "cmd.request",
              message: "Durable cmd.request preparation or publication failed",
            }),
          ),
        ok: (outcome) => {
          const publication = outcome.record.publication;
          if (
            (outcome.status !== "published" && outcome.status !== "already-published") ||
            publication === undefined
          ) {
            return Result.err(
              new EventPublishTransportFailed({
                cause: outcome.publicationError,
                eventType: type,
                topic: "cmd.request",
                message:
                  outcome.status === "ambiguous"
                    ? "Durable cmd.request publication outcome is ambiguous"
                    : "Durable cmd.request publication terminalized",
              }),
            );
          }
          return Result.ok({
            id: publication.streamId,
            cursor: publication.streamId,
            topic: "cmd.request" as LilacTopicForType<typeof type>,
            ...(outcome.status === "already-published" ? { duplicate: true } : {}),
          });
        },
      });
    },
    acquireRequestPublicationClaim: (requestDeliveryId) =>
      input.transportBus.acquireRequestPublicationClaim(requestDeliveryId),
    publishClaimedRequest: (data, claim, options) =>
      input.transportBus.publishClaimedRequest(data, claim, options),
    confirmRequestPublication: (claim, expectedStreamId) =>
      input.transportBus.confirmRequestPublication(claim, expectedStreamId),
    abandonRequestPublicationClaim: (claim) =>
      input.transportBus.abandonRequestPublicationClaim(claim),
    getOutputStreamExpiry: (requestId) => input.transportBus.getOutputStreamExpiry(requestId),
    subscribeTopic: (topic, opts, handler, deliveryPolicy) =>
      input.transportBus.subscribeTopic(topic, opts, handler, deliveryPolicy),
    fetchTopic: (topic, opts) => input.transportBus.fetchTopic(topic, opts),
    getTopicWatermark: (topic) => input.transportBus.getTopicWatermark(topic),
    trimTopicBeforeCheckpoint: (topic, checkpoint, safetyMargin) =>
      input.transportBus.trimTopicBeforeCheckpoint(topic, checkpoint, safetyMargin),
    retireTopicConsumerGroup: (topic, group, confirmSingleVersionRollout) =>
      input.transportBus.retireTopicConsumerGroup(topic, group, confirmSingleVersionRollout),
    close: () => input.transportBus.close(),
  };
  return bus;
}
