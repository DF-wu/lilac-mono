import type {
  EvtAdapterMessageCreatedData,
  EvtAdapterMessageDeletedData,
  EvtAdapterMessageUpdatedData,
  EvtAdapterReactionAddedData,
  EvtAdapterReactionRemovedData,
} from "@stanley2058/lilac-event-bus";
import { Panic } from "better-result";

import type { AdapterEvent } from "../events";
import type { MsgRef, SessionRef, SurfacePlatform } from "../types";

type AdapterMessageCreatedEvent = Extract<AdapterEvent, { type: "adapter.message.created" }>;
type AdapterMessageUpdatedEvent = Extract<AdapterEvent, { type: "adapter.message.updated" }>;
type AdapterMessageDeletedEvent = Extract<AdapterEvent, { type: "adapter.message.deleted" }>;
type AdapterReactionAddedEvent = Extract<AdapterEvent, { type: "adapter.reaction.added" }>;
type AdapterReactionRemovedEvent = Extract<AdapterEvent, { type: "adapter.reaction.removed" }>;

export function signalAdapterEventPlatformMismatch(input: {
  eventType: AdapterEvent["type"];
  eventPlatform: SurfacePlatform;
  sessionPlatform: SessionRef["platform"];
  messageRefPlatform: MsgRef["platform"];
}): never {
  throw new Panic({
    message: `${input.eventType} platform mismatch: event=${input.eventPlatform}, session=${input.sessionPlatform}, messageRef=${input.messageRefPlatform}`,
  });
}

function requireConsistentPlatform(input: {
  eventType: AdapterEvent["type"];
  eventPlatform: SurfacePlatform;
  sessionPlatform: SessionRef["platform"];
  messageRefPlatform: MsgRef["platform"];
}): MsgRef["platform"] {
  if (
    input.eventPlatform !== input.sessionPlatform ||
    input.eventPlatform !== input.messageRefPlatform
  ) {
    signalAdapterEventPlatformMismatch(input);
  }
  return input.messageRefPlatform;
}

export function toBusEvtAdapterMessageCreated(
  evt: AdapterMessageCreatedEvent,
): EvtAdapterMessageCreatedData {
  const platform = requireConsistentPlatform({
    eventType: evt.type,
    eventPlatform: evt.platform,
    sessionPlatform: evt.message.session.platform,
    messageRefPlatform: evt.message.ref.platform,
  });
  return {
    platform,
    channelId: evt.message.session.channelId,
    channelName: evt.channelName,
    messageId: evt.message.ref.messageId,
    userId: evt.message.userId,
    userName: evt.message.userName,
    text: evt.message.text,
    ts: evt.message.ts,
    raw: evt.message.raw,
  };
}

export function toBusEvtAdapterMessageUpdated(
  evt: AdapterMessageUpdatedEvent,
): EvtAdapterMessageUpdatedData {
  const platform = requireConsistentPlatform({
    eventType: evt.type,
    eventPlatform: evt.platform,
    sessionPlatform: evt.message.session.platform,
    messageRefPlatform: evt.message.ref.platform,
  });
  return {
    platform,
    channelId: evt.message.session.channelId,
    channelName: evt.channelName,
    messageId: evt.message.ref.messageId,
    userId: evt.message.userId,
    userName: evt.message.userName,
    text: evt.message.text,
    ts: evt.message.ts,
    raw: evt.message.raw,
  };
}

export function toBusEvtAdapterMessageDeleted(
  evt: AdapterMessageDeletedEvent,
): EvtAdapterMessageDeletedData {
  const platform = requireConsistentPlatform({
    eventType: evt.type,
    eventPlatform: evt.platform,
    sessionPlatform: evt.session.platform,
    messageRefPlatform: evt.messageRef.platform,
  });
  return {
    platform,
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    ts: evt.ts,
    raw: evt.raw,
  };
}

export function toBusEvtAdapterReactionAdded(
  evt: AdapterReactionAddedEvent,
): EvtAdapterReactionAddedData {
  const platform = requireConsistentPlatform({
    eventType: evt.type,
    eventPlatform: evt.platform,
    sessionPlatform: evt.session.platform,
    messageRefPlatform: evt.messageRef.platform,
  });
  return {
    platform,
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    reaction: evt.reaction,
    userId: evt.userId,
    userName: evt.userName,
    ts: evt.ts,
    raw: evt.raw,
  };
}

export function toBusEvtAdapterReactionRemoved(
  evt: AdapterReactionRemovedEvent,
): EvtAdapterReactionRemovedData {
  const platform = requireConsistentPlatform({
    eventType: evt.type,
    eventPlatform: evt.platform,
    sessionPlatform: evt.session.platform,
    messageRefPlatform: evt.messageRef.platform,
  });
  return {
    platform,
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    reaction: evt.reaction,
    userId: evt.userId,
    userName: evt.userName,
    ts: evt.ts,
    raw: evt.raw,
  };
}
