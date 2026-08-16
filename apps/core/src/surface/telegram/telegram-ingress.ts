import { Result } from "better-result";
import { z } from "zod";

import type { AdapterEvent } from "../events";

/**
 * Shape check for an event read back out of the outbox.
 *
 * SQLite is an untrusted boundary here: the row was written by a previous
 * process, possibly an older build whose event shape differed. Parsing keeps a
 * malformed row from reaching subscribers as a half-built event.
 *
 * Only the fields the durable event types actually require are validated;
 * `passthrough` keeps the rest intact so replay delivers what was queued
 * rather than a lossy reconstruction.
 */
const surfaceRefSchema = z
  .object({ platform: z.literal("telegram"), channelId: z.string() })
  .passthrough();

const storedTelegramEventSchema = z.union([
  z
    .object({
      type: z.enum(["adapter.message.created", "adapter.message.updated"]),
      platform: z.literal("telegram"),
      ts: z.number(),
      message: z.object({ ref: surfaceRefSchema, session: surfaceRefSchema }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.enum([
        "adapter.message.deleted",
        "adapter.reaction.added",
        "adapter.reaction.removed",
      ]),
      platform: z.literal("telegram"),
      ts: z.number(),
      messageRef: surfaceRefSchema,
      session: surfaceRefSchema,
    })
    .passthrough(),
]);

const storedTelegramRawSchema = z.json();

export type TelegramStoredRaw = z.output<typeof storedTelegramRawSchema>;

/**
 * Narrows a stored payload back to an `AdapterEvent`, or `null` if it cannot
 * be trusted.
 *
 * The cast is confined to this one place and is guarded by the schema above:
 * zod cannot express `AdapterEvent`'s full union without duplicating it, but
 * it can prove the discriminant and the fields replay depends on.
 */
export function parseStoredAdapterEvent(serialized: string): AdapterEvent | null {
  const decoded = Result.try({
    try: () => JSON.parse(serialized),
    catch: () => null,
  });
  return decoded.match({
    err: () => null,
    ok: (value) => {
      const parsed = storedTelegramEventSchema.safeParse(value);
      if (!parsed.success) return null;

      const candidate = parsed.data as AdapterEvent;
      // Re-deriving the key proves the parsed value is one this module recognises,
      // rather than trusting the schema alone.
      return telegramIngressDedupeKey(candidate) === null ? null : candidate;
    },
  });
}

export function parseStoredTelegramRaw(serialized: string | null): TelegramStoredRaw | undefined {
  if (serialized === null) return undefined;
  const decoded = Result.try({
    try: () => JSON.parse(serialized),
    catch: () => undefined,
  });
  return decoded.match({
    err: () => undefined,
    ok: (value) => {
      const parsed = storedTelegramRawSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  });
}

/**
 * Durable-ingress identity for an inbound Telegram event.
 *
 * grammY advances its poll offset before the update handler runs
 * (`lastTriedUpdateId = update.update_id` precedes `handleUpdate` in
 * `bot.js`), so Telegram will not resend an update whose handler failed. The
 * outbox therefore has to commit the event before publishing, and replay needs
 * a stable identity to avoid publishing the same thing twice.
 *
 * The key is derived from the event's own content rather than `update_id`:
 * one update can produce several events (a reaction change yields one per
 * emoji), and `update_id` is not threaded down to the emit sites. Content
 * derivation also survives a redelivery after a crash, where the update id
 * would differ but the event is the same.
 *
 * Returns `null` for events that must not be queued. That deliberately covers
 * the interactive ones: a cancel request or a button press is only meaningful
 * against a run that is still live, so replaying one after a restart would
 * abort a *different* request the user never asked to stop. Losing one is the
 * safer failure — the user is still looking at the chat and can press again.
 */
export function telegramIngressDedupeKey(evt: AdapterEvent): string | null {
  switch (evt.type) {
    case "adapter.message.created":
      return `created:${evt.message.session.channelId}:${evt.message.ref.messageId}`;

    case "adapter.message.updated":
      // Edits are keyed by their timestamp: a second edit of the same message
      // is a distinct event that must not be swallowed as a duplicate.
      return [
        "updated",
        evt.message.session.channelId,
        evt.message.ref.messageId,
        String(evt.message.editedTs ?? evt.ts),
      ].join(":");

    case "adapter.message.deleted":
      return `deleted:${evt.session.channelId}:${evt.messageRef.messageId}`;

    case "adapter.reaction.added":
      return [
        "reaction+",
        evt.session.channelId,
        evt.messageRef.messageId,
        evt.userId ?? "unknown",
        evt.reaction,
      ].join(":");

    case "adapter.reaction.removed":
      return [
        "reaction-",
        evt.session.channelId,
        evt.messageRef.messageId,
        evt.userId ?? "unknown",
        evt.reaction,
      ].join(":");

    case "adapter.request.cancel":
    case "adapter.command.invoked":
    case "adapter.action.invoked":
      return null;

    default: {
      const exhaustive: never = evt;
      return exhaustive;
    }
  }
}
