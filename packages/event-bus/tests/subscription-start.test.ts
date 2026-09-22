import { afterEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";
import {
  createRedisStreamsBus,
  managedRedisPhysicalGroup,
  type RawBus,
  type RawMessageDecodeOutcome,
} from "../index";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const redis = new Redis(env.redisUrl || "redis://127.0.0.1:6379");
  const keyPrefix = `test:lilac-event-bus:subscription-start:${crypto.randomUUID()}`;
  const raw = createRedisStreamsBus({ redis, keyPrefix });
  cleanups.push(async () => {
    await raw.close();
    const keys = await redis.keys(`${keyPrefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  const publish = (value: number) =>
    raw.publish(
      { topic: "topic", type: "fixture.event", data: value },
      { topic: "topic", type: "fixture.event" },
    );
  return { raw, redis, keyPrefix, publish };
}

function messageValue(message: RawMessageDecodeOutcome): number {
  if ("_tag" in message || typeof message.data !== "number")
    throw new Error("Invalid fixture event");
  return message.data;
}

async function subscribe(
  raw: RawBus,
  mode: "work" | "fanout",
  startFrom: "beginning" | "latest" | undefined,
  subscriptionId: string,
  onMessage: (value: number) => void,
) {
  const subscription = (
    await raw.subscribe(
      "topic",
      { mode, subscriptionId, startFrom, batch: { maxWaitMs: 10 } },
      async (message) => {
        onMessage(messageValue(message));
        return { disposition: "commit" };
      },
    )
  ).unwrap();
  return subscription;
}

async function waitCommitted(redis: Redis, stream: string, group: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pending = await redis.xpending(stream, group);
    if (Array.isArray(pending) && pending[0] === 0) return;
  }
  throw new Error("Expected subscription commit before the deadline");
}

describe("managed subscription initial frontier", () => {
  for (const mode of ["work", "fanout"] as const) {
    for (const startFrom of [undefined, "latest", "beginning"] as const) {
      test(`${mode} ${startFrom ?? "default"} selects only the initial group frontier`, async () => {
        const { raw, publish } = fixture();
        await publish(1);
        await publish(2);
        const seen: number[] = [];
        const delivered = Promise.withResolvers<void>();
        const active = await subscribe(raw, mode, startFrom, "initial", (value) => {
          seen.push(value);
          if (value === 3) delivered.resolve();
        });
        cleanups.push(async () => {
          (await active.stop()).unwrap();
        });
        await publish(3);
        await delivered.promise;
        expect(seen).toEqual(startFrom === "beginning" ? [1, 2, 3] : [3]);
      });
    }

    for (const initial of ["beginning", "latest"] as const) {
      test(`${mode} preserves the existing frontier when restarting from ${initial}`, async () => {
        const { raw, redis, keyPrefix, publish } = fixture();
        await publish(1);
        const firstSeen: number[] = [];
        const firstDelivered = Promise.withResolvers<void>();
        const first = await subscribe(raw, mode, initial, "durable", (value) => {
          firstSeen.push(value);
          if (value === 2) firstDelivered.resolve();
        });
        await publish(2);
        await firstDelivered.promise;
        await waitCommitted(
          redis,
          `${keyPrefix}:topic`,
          managedRedisPhysicalGroup(mode, "durable"),
        );
        (await first.stop()).unwrap();
        expect(firstSeen).toEqual(initial === "beginning" ? [1, 2] : [2]);
        await publish(3);
        const resumed: number[] = [];
        const resumedDelivered = Promise.withResolvers<void>();
        const second = await subscribe(
          raw,
          mode,
          initial === "beginning" ? "latest" : "beginning",
          "durable",
          (value) => {
            resumed.push(value);
            if (value === 4) resumedDelivered.resolve();
          },
        );
        cleanups.push(async () => {
          (await second.stop()).unwrap();
        });
        await publish(4);
        await resumedDelivered.promise;
        expect(resumed).toEqual([3, 4]);
      });
    }
  }
});
