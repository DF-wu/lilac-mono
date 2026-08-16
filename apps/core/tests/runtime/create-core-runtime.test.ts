import { describe, expect, it } from "bun:test";

import { Panic, Result, type Result as ResultType } from "better-result";
import {
  createLilacBus,
  EventDeliveryStopFailed,
  EventDeliveryTransportFailed,
  RedisEventDeadLetter,
  type EventDeliveryDoneError,
  type RawBus,
} from "@stanley2058/lilac-event-bus";
import Redis from "ioredis";

import {
  adaptCoreEventBusCleanupResultToHost,
  captureCoreEventBusCleanup,
  CoreEventBusCleanupFailed,
  CoreResidualDiscordRequestRouterDoneTimedOut,
  type CoreResidualDiscordRequestRouterDoneOutcome,
  type CoreRuntimeCleanupFailure,
  createCoreEventBusDeliveryOptions,
  createCoreEventBusFatalReporter,
  createCoreEventBusLogger,
  createCoreRuntimeCleanupSupervisor,
  createCoreRuntimeFatalReporter,
  resolveRequestCapabilityIdentity,
  retainCoreResidualDiscordRequestRouter,
  selectCoreRuntimeStopPass,
  settleCoreResidualDiscordRequestRouterDone,
  stopCoreResidualDiscordRequestRouter,
  superviseDetachedCoreConfigValidation,
  superviseCoreResidualDiscordRequestRouterDone,
  superviseCoreRouterDone,
} from "../../src/runtime/create-core-runtime";
import {
  ResidualDiscordRequestRouterStopFailed,
  type ResidualDiscordRequestRouter,
} from "../../src/surface/discord/discord-request-router";
import {
  BUILTIN_SURFACE_PROTOCOLS,
  resolveBuiltinSurfaceProtocolSafetyMode,
} from "../../src/surface/builtin-surface-protocols";
import type { SurfaceProtocolRouting } from "../../src/surface/protocol";

describe("delegated request capability identity", () => {
  const authenticatedOrigin = {
    platform: "discord" as const,
    userId: "user-1",
    sessionRef: { platform: "discord" as const, channelId: "channel-1" },
  };

  it("preserves resolved safety only for a matching internal unknown-client projection", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "unknown",
        sessionId: "workflow-child",
        safetyMode: "trusted",
        authenticatedOrigin,
        cachedRequest: {
          requestId: "child-1",
          requestClient: "unknown",
          sessionId: "workflow-child",
          source: "internal-delegated",
          authenticatedOrigin,
          authenticationMetadataKind: "origin",
          verifiedIngress: false,
        },
      }),
    ).toEqual({
      principal: { platform: "discord", userId: "user-1" },
      authenticatedOrigin,
      safetyMode: "trusted",
    });
  });

  it("does not grant trust to a raw external unknown-client projection", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "unknown",
        sessionId: "workflow-child",
        safetyMode: "trusted",
        cachedRequest: {
          requestId: "child-1",
          requestClient: "unknown",
          sessionId: "workflow-child",
          source: "external",
          authenticationMetadataKind: "absent",
          verifiedIngress: false,
        },
      }),
    ).toEqual({ principal: null, authenticatedOrigin: null, safetyMode: "restricted" });
  });

  it("does not grant principal or asserted trust from registered protocol membership", () => {
    expect(
      resolveRequestCapabilityIdentity({
        requestClient: "discord",
        sessionId: "channel-1",
        safetyMode: "trusted",
        cachedRequest: {
          requestId: "discord:channel-1:message-1",
          requestClient: "discord",
          sessionId: "channel-1",
          source: "external",
          platform: "discord",
          sessionRef: { platform: "discord", channelId: "channel-1" },
          messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
          authenticationMetadataKind: "absent",
          verifiedIngress: false,
        },
      }),
    ).toEqual({ principal: null, authenticatedOrigin: null, safetyMode: "restricted" });
  });

  it("preserves asserted safety when a built-in protocol has no external override", () => {
    const protocol = {
      ...BUILTIN_SURFACE_PROTOCOLS.discord,
      requestProjection: { inferRequestMessageRef: true },
    } satisfies SurfaceProtocolRouting<"discord">;

    expect(
      resolveBuiltinSurfaceProtocolSafetyMode({
        protocol,
        verifiedIngress: true,
        assertedSafetyMode: "trusted",
      }),
    ).toBe("trusted");
    expect(
      resolveBuiltinSurfaceProtocolSafetyMode({
        protocol,
        verifiedIngress: true,
        assertedSafetyMode: "restricted",
      }),
    ).toBe("restricted");
  });
});

describe("Core runtime startup", () => {
  it.each([
    ["Error", () => new Error("cleanup failed")],
    ["Panic", () => new Panic({ message: "cleanup invariant failed" })],
  ] as const)(
    "preserves a startup Panic through cleanup %s and continues cleanup",
    async (_, cause) => {
      const startupPanic = new Panic({ message: "startup invariant failed" });
      const cleanupFailure = cause();
      const calls: string[] = [];
      const cleanup = createCoreRuntimeCleanupSupervisor(startupPanic);
      let thrown: unknown;

      try {
        await cleanup.run("failing", async () => {
          calls.push("failing");
          throw cleanupFailure;
        });
        await cleanup.run("continued", async () => {
          calls.push("continued");
        });
        cleanup.finish();
        throw startupPanic;
      } catch (cause) {
        thrown = cause;
      }

      expect(calls).toEqual(["failing", "continued"]);
      expect(cleanup.failures).toEqual([
        {
          label: "failing",
          error: cleanupFailure.message,
          panic: Panic.is(cleanupFailure),
        },
      ]);
      expect(thrown).toBe(startupPanic);
    },
  );

  it("continues cleanup before propagating the first cleanup Panic without a prior Panic", async () => {
    const firstPanic = new Panic({ message: "first cleanup invariant failed" });
    const secondPanic = new Panic({ message: "second cleanup invariant failed" });
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.run("first", async () => {
      calls.push("first");
      throw firstPanic;
    });
    await cleanup.run("second", async () => {
      calls.push("second");
      throw secondPanic;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["first", "second", "continued"]);
    expect(() => cleanup.finish()).toThrow(firstPanic);
  });

  it("reports detached config validation Panic with exact identity", async () => {
    const panic = new Panic({ message: "config validation invariant failed" });
    const reported: Error[] = [];

    await superviseDetachedCoreConfigValidation({
      validate: async () => {
        throw panic;
      },
      reportFatalError: (error) => reported.push(error),
    });

    expect(reported).toEqual([panic]);
  });

  it("supervises typed cleanup outcomes without converting them back to rejections", async () => {
    const cleanupPanic = new Panic({ message: "typed cleanup invariant failed" });
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await cleanup.runOutcome("ordinary", async () => ({
      kind: "result",
      result: Result.err(new Error("typed cleanup failed")),
    }));
    await cleanup.runOutcome("panic", async () => ({ kind: "panic", panic: cleanupPanic }));

    expect(cleanup.failures).toEqual([
      { label: "ordinary", error: "typed cleanup failed", panic: false },
      { label: "panic", error: "typed cleanup invariant failed", panic: true },
    ]);
    expect(() => cleanup.finish()).toThrow(cleanupPanic);
  });

  it("contains a revoked cleanup cause, continues cleanup, and preserves the startup Panic", async () => {
    const startupPanic = new Panic({ message: "startup invariant failed" });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const calls: string[] = [];
    const cleanup = createCoreRuntimeCleanupSupervisor(startupPanic);

    await cleanup.run("revoked", async () => {
      calls.push("revoked");
      throw proxy;
    });
    await cleanup.run("continued", async () => {
      calls.push("continued");
    });

    expect(calls).toEqual(["revoked", "continued"]);
    expect(cleanup.failures).toEqual([
      { label: "revoked", error: "Opaque cleanup failure", panic: false },
    ]);
    expect(() => {
      cleanup.finish();
      throw startupPanic;
    }).toThrow(startupPanic);
  });

  it("retains and retries residual router ownership after an ordinary stop failure", async () => {
    const stopFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.request",
          cause: new Error("cleanup failed"),
          message: "forced cleanup failure",
        }),
      ],
      message: "Residual router cleanup failed",
    });
    const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const calls: string[] = [];
    let router: ResidualDiscordRequestRouter;
    router = {
      done: done.promise,
      stop: async () => {
        calls.push("stop");
        if (calls.length === 1) {
          return { kind: "result", result: Result.err(stopFailure), residualRouter: router };
        }
        done.resolve(Result.ok(undefined));
        return { kind: "result", result: Result.ok(undefined), residualRouter: null };
      },
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup,
    });
    expect(retained).toBe(router);
    if (!retained) throw new Error("expected retained residual ownership");
    const released = await stopCoreResidualDiscordRequestRouter({
      router: retained,
      cleanup,
    });

    expect(released).toBeNull();
    expect(calls).toEqual(["stop", "stop"]);
    expect(cleanup.failures).toEqual([
      { label: "residualRouter.stop", error: stopFailure.message, panic: false },
    ]);
  });

  it("retains ownership after a synchronous residual router stop throw", async () => {
    const rejection = new Error("stop threw synchronously");
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const router: ResidualDiscordRequestRouter = {
      done: Promise.resolve(Result.ok(undefined)),
      stop() {
        throw rejection;
      },
    };

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup,
    });

    expect(retained).toBe(router);
    expect(cleanup.failures).toHaveLength(1);
    expect(cleanup.failures[0]).toMatchObject({
      label: "residualRouter.stop",
      panic: false,
    });
  });

  it("supervises a residual done rejection immediately and preserves Panic identity", async () => {
    const panic = new Panic({ message: "residual done invariant failed" });
    const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const supervision = superviseCoreResidualDiscordRequestRouterDone(done.promise);
    done.reject(panic);
    const cleanup = createCoreRuntimeCleanupSupervisor(null);

    await settleCoreResidualDiscordRequestRouterDone({
      supervision,
      cleanup,
      reportLatePanic: () => {},
      deadlineMs: 3_000,
    });

    expect(cleanup.failures).toEqual([
      { label: "residualRouter.done", error: panic.message, panic: true },
    ]);
    expect(() => cleanup.finish()).toThrow(panic);
  });

  it("records an in-time residual done Result error", async () => {
    const failure = new EventDeliveryTransportFailed({
      topic: "evt.request",
      operation: "ack",
      cursor: "8-0",
      cause: new Error("Redis connection closed"),
      message: "Redis delivery acknowledgement failed",
    });
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    let cancelled = false;

    await settleCoreResidualDiscordRequestRouterDone({
      supervision: Promise.resolve({ kind: "result", result: Result.err(failure) }),
      cleanup,
      reportLatePanic: () => {},
      deadlineMs: 3_000,
      scheduleDeadline: () => () => {
        cancelled = true;
      },
    });

    expect(cancelled).toBe(true);
    expect(cleanup.failures).toEqual([
      { label: "residualRouter.done", error: failure.message, panic: false },
    ]);
  });

  it("records every residual stop Panic and keeps exact first-Panic precedence", async () => {
    const firstPanic = new Panic({ message: "first residual stop panic" });
    const secondPanic = new Panic({ message: "second residual stop panic" });
    const ordinaryFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.surface",
          cause: new Error("surface cleanup failed"),
          message: "forced surface cleanup failure",
        }),
      ],
      message: "Residual router ordinary cleanup failed",
    });
    let router: ResidualDiscordRequestRouter;
    router = {
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => ({
        kind: "panic",
        panic: firstPanic,
        additionalPanics: [secondPanic],
        ordinaryFailure,
        residualRouter: router,
      }),
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const fatalReports: Error[] = [];
    const cleanupBoundary = {
      record: cleanup.record,
      reportFatalError: (error: Error) => fatalReports.push(error),
    };

    const retained = await stopCoreResidualDiscordRequestRouter({
      router,
      cleanup: cleanupBoundary,
    });

    expect(retained).toBe(router);
    expect(fatalReports).toEqual([]);
    expect(cleanup.panics).toEqual([firstPanic, secondPanic]);
    expect(cleanup.failures).toEqual([
      { label: "residualRouter.stop.panic", error: firstPanic.message, panic: true },
      { label: "residualRouter.stop.panic", error: secondPanic.message, panic: true },
      { label: "residualRouter.stop", error: ordinaryFailure.message, panic: false },
    ]);
    expect(() => cleanup.finish()).toThrow(firstPanic);
  });

  it("attaches done supervision immediately to a residual replacement", async () => {
    const replacementDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const donePanic = new Panic({ message: "replacement done invariant failed" });
    const stopFailure = new ResidualDiscordRequestRouterStopFailed({
      failures: [
        new EventDeliveryStopFailed({
          topic: "evt.request",
          cause: new Error("replacement remained live"),
          message: "forced replacement cleanup failure",
        }),
      ],
      message: "Residual router cleanup retained a replacement",
    });
    const replacement: ResidualDiscordRequestRouter = {
      done: replacementDone.promise,
      stop: async () => ({
        kind: "result",
        result: Result.err(stopFailure),
        residualRouter: replacement,
      }),
    };
    const initial: ResidualDiscordRequestRouter = {
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => ({
        kind: "result",
        result: Result.err(stopFailure),
        residualRouter: replacement,
      }),
    };
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const supervisions: Array<Promise<CoreResidualDiscordRequestRouterDoneOutcome>> = [];
    const ownership: { router: ResidualDiscordRequestRouter | null } = { router: null };

    retainCoreResidualDiscordRequestRouter({
      router: initial,
      retainRouter: (router) => {
        ownership.router = router;
      },
      retainDoneSupervision: (supervision) => supervisions.push(supervision),
    });

    const retainedInitial = ownership.router;
    if (!retainedInitial) throw new Error("expected initial residual ownership");
    const returnedReplacement = await stopCoreResidualDiscordRequestRouter({
      router: retainedInitial,
      cleanup,
    });
    if (!returnedReplacement) throw new Error("expected a residual replacement");
    retainCoreResidualDiscordRequestRouter({
      router: returnedReplacement,
      retainRouter: (router) => {
        ownership.router = router;
      },
      retainDoneSupervision: (supervision) => supervisions.push(supervision),
    });
    replacementDone.reject(donePanic);

    expect(ownership.router).toBe(replacement);
    expect(supervisions).toHaveLength(2);
    const supervision = supervisions[1];
    if (!supervision) throw new Error("expected replacement done supervision");
    await settleCoreResidualDiscordRequestRouterDone({
      supervision,
      cleanup,
      reportLatePanic: () => {},
      deadlineMs: 3_000,
    });
    expect(cleanup.panics).toEqual([donePanic]);
  });

  it("reports a residual done Panic that settles after the cleanup deadline", async () => {
    const done = Promise.withResolvers<CoreResidualDiscordRequestRouterDoneOutcome>();
    const reported = Promise.withResolvers<Panic>();
    const panic = new Panic({ message: "late residual done invariant failed" });
    const recorded: Array<{ readonly label: string; readonly cause: Error }> = [];
    let expireDeadline: () => void = () => {
      throw new Error("deadline was not scheduled");
    };
    let cancelled = false;

    const settling = settleCoreResidualDiscordRequestRouterDone({
      supervision: done.promise,
      cleanup: {
        record: (label, cause) => recorded.push({ label, cause }),
      },
      reportLatePanic: (latePanic) => {
        reported.resolve(latePanic);
      },
      deadlineMs: 3_000,
      scheduleDeadline: (callback, delayMs) => {
        expect(delayMs).toBe(3_000);
        expireDeadline = callback;
        return () => {
          cancelled = true;
        };
      },
    });
    expireDeadline();
    await settling;

    expect(cancelled).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.label).toBe("residualRouter.done");
    expect(recorded[0]?.cause).toBeInstanceOf(CoreResidualDiscordRequestRouterDoneTimedOut);
    expect(recorded[0]?.cause).toMatchObject({ deadlineMs: 3_000 });

    done.resolve({ kind: "panic", panic });
    expect(await reported.promise).toBe(panic);
    expect(recorded).toHaveLength(1);
  });

  it("runs full cleanup once across residual-router stop re-entry and eventual release", async () => {
    const fullCleanupOperations = [
      "agentRunner.stop",
      "mcpOAuthCallback.stop",
      "mcpRegistry.shutdown",
      "durableWorkflowStore.close",
      "transcriptStore.close",
      "bus.close",
    ] as const;
    const fullCleanupCounts = new Map(fullCleanupOperations.map((operation) => [operation, 0]));
    const failures = [
      new ResidualDiscordRequestRouterStopFailed({
        failures: [
          new EventDeliveryStopFailed({
            topic: "evt.request",
            cause: new Error("initial residual stop failed"),
            message: "initial residual stop failed",
          }),
        ],
        message: "Initial residual router cleanup failed",
      }),
      new ResidualDiscordRequestRouterStopFailed({
        failures: [
          new EventDeliveryStopFailed({
            topic: "evt.request",
            cause: new Error("residual retry failed"),
            message: "residual retry failed",
          }),
        ],
        message: "Residual router cleanup retry failed",
      }),
    ] as const;
    const stopPasses: string[] = [];
    const cleanupFailures: Array<readonly CoreRuntimeCleanupFailure[]> = [];
    let fullCleanupPending = true;
    let residualStopAttempts = 0;
    let residualDoneSettlements = 0;
    let residualRouter: ResidualDiscordRequestRouter | null = null;
    const residualDoneSupervisions: Array<Promise<CoreResidualDiscordRequestRouterDoneOutcome>> =
      [];

    const retainResidualRouter = (router: ResidualDiscordRequestRouter): void => {
      retainCoreResidualDiscordRequestRouter({
        router,
        retainRouter: (retained) => {
          residualRouter = retained;
        },
        retainDoneSupervision: (supervision) => {
          residualDoneSupervisions.push(
            supervision.then((outcome) => {
              residualDoneSettlements += 1;
              return outcome;
            }),
          );
        },
      });
    };
    const createResidualRouter = (): ResidualDiscordRequestRouter => ({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => {
        const failure = failures[residualStopAttempts];
        residualStopAttempts += 1;
        if (!failure) {
          return { kind: "result", result: Result.ok(undefined), residualRouter: null };
        }
        const replacement = createResidualRouter();
        return { kind: "result", result: Result.err(failure), residualRouter: replacement };
      },
    });
    retainResidualRouter(createResidualRouter());

    const stopRuntime = async (): Promise<void> => {
      const stopPass = selectCoreRuntimeStopPass({
        fullCleanupPending,
        hasResidualRouter: residualRouter !== null,
      });
      if (stopPass === "none") return;
      stopPasses.push(stopPass);
      const cleanup = createCoreRuntimeCleanupSupervisor(null);

      if (stopPass === "full") {
        for (const operation of fullCleanupOperations) {
          await cleanup.run(operation, async () => {
            fullCleanupCounts.set(operation, (fullCleanupCounts.get(operation) ?? 0) + 1);
          });
        }
      }

      if (residualRouter) {
        const replacement = await stopCoreResidualDiscordRequestRouter({
          router: residualRouter,
          cleanup,
        });
        residualRouter = null;
        if (replacement) retainResidualRouter(replacement);
      }

      if (stopPass === "full") fullCleanupPending = false;
      for (const supervision of residualDoneSupervisions) {
        await settleCoreResidualDiscordRequestRouterDone({
          supervision,
          cleanup,
          reportLatePanic: () => {},
          deadlineMs: 3_000,
        });
      }
      residualDoneSupervisions.length = 0;
      cleanupFailures.push(cleanup.failures);
      cleanup.finish();
    };

    await stopRuntime();
    await stopRuntime();
    await stopRuntime();
    await stopRuntime();

    expect(stopPasses).toEqual(["full", "residual-router", "residual-router"]);
    expect(Object.fromEntries(fullCleanupCounts)).toEqual({
      "agentRunner.stop": 1,
      "mcpOAuthCallback.stop": 1,
      "mcpRegistry.shutdown": 1,
      "durableWorkflowStore.close": 1,
      "transcriptStore.close": 1,
      "bus.close": 1,
    });
    expect(residualStopAttempts).toBe(3);
    expect(residualDoneSettlements).toBe(3);
    expect(residualRouter).toBeNull();
    expect(cleanupFailures).toEqual([
      [{ label: "residualRouter.stop", error: failures[0].message, panic: false }],
      [{ label: "residualRouter.stop", error: failures[1].message, panic: false }],
      [],
    ]);
  });
});

describe("Core runtime event delivery", () => {
  it("adapts cleanup Results only at the exact runtime host boundary", () => {
    const cleanupError = new CoreEventBusCleanupFailed({
      cause: new Error("close failed"),
      message: "Core event bus cleanup failed",
    });

    expect(() => adaptCoreEventBusCleanupResultToHost(Result.err(cleanupError))).toThrow(
      cleanupError.message,
    );
  });

  it("captures ordinary owned Redis cleanup failure and preserves cleanup Panic identity", async () => {
    const redis = new Redis({ lazyConnect: true });
    const cleanupError = new Error("redis close failed");
    Reflect.set(redis, "quit", async () => {
      throw cleanupError;
    });

    try {
      const captured = await captureCoreEventBusCleanup({ redis, raw: null, bus: null });
      expect(captured.status).toBe("error");
      if (captured.status === "error") expect(captured.error.cause).toBe(cleanupError);

      const panic = new Panic({ message: "redis cleanup invariant failed" });
      Reflect.set(redis, "quit", async () => {
        throw panic;
      });
      await expect(captureCoreEventBusCleanup({ redis, raw: null, bus: null })).rejects.toBe(panic);
    } finally {
      redis.disconnect();
    }
  });

  it("adapts a typed bus close Err into owned runtime cleanup failure", async () => {
    const redis = new Redis({ lazyConnect: true });
    const closeFailure = new Error("event transport close failed");
    const raw: RawBus = {
      publish: async () => ({ id: "1-0", cursor: "1-0" }),
      subscribe: async () => {
        throw new Error("unused test subscription");
      },
      fetch: async () => ({ messages: [] }),
      close: async () => {
        throw closeFailure;
      },
    };

    try {
      const captured = await captureCoreEventBusCleanup({
        redis,
        raw: null,
        bus: createLilacBus(raw),
      });
      expect(captured.status).toBe("error");
      if (captured.status === "error") {
        expect(captured.error.cause).toMatchObject({
          _tag: "EventBusCloseFailed",
          cause: closeFailure,
        });
      }
    } finally {
      redis.disconnect();
    }
  });

  it("wires the owned Redis client, redacted logger, and fatal reporter", () => {
    const redis = new Redis({ lazyConnect: true });
    const reported: Error[] = [];
    const logs: unknown[] = [];

    try {
      const options = createCoreEventBusDeliveryOptions({
        redis,
        deadLetterEncryptionKey: Buffer.alloc(32, 0x42),
        logger: {
          warn: (...args) => logs.push(args),
          error: (...args) => logs.push(args),
        },
        reportFatalError: (error) => reported.push(error),
      });

      expect(options.deadLetter).toBeInstanceOf(RedisEventDeadLetter);
      expect(Reflect.get(options.deadLetter!, "redis")).toBe(redis);
      expect(options.logger).toBeDefined();
      expect(options.reportFatal).toBeDefined();

      const panic = new Panic({ message: "delivery invariant failed" });
      options.reportFatal!.report(panic, {
        topic: "cmd.request",
        cursor: "1-0",
        phase: "handler",
      });
      expect(reported).toEqual([panic]);
    } finally {
      redis.disconnect();
    }
  });

  it("forwards only payload-redacted event delivery metadata", () => {
    const secret = "event-payload-secret";
    const logs: Array<{ event: unknown; context: unknown }> = [];
    const logger = createCoreEventBusLogger({
      warn: (event, context) => logs.push({ event, context }),
      error: (event, context) => logs.push({ event, context }),
    });

    logger.warn("event_bus.contract_invalid", {
      topic: "cmd.request",
      cursor: "1-0",
      source: "contract",
      stage: "payload",
      eventType: "cmd.request.message",
      payload: secret,
      evidence: secret,
    });

    expect(logs).toEqual([
      {
        event: "event_bus.contract_invalid",
        context: {
          topic: "cmd.request",
          cursor: "1-0",
          source: "contract",
          stage: "payload",
          eventType: "cmd.request.message",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("propagates fatal identities to process supervision exactly once", () => {
    const reported: Error[] = [];
    const reporter = createCoreEventBusFatalReporter((error) => reported.push(error));
    const panic = new Panic({ message: "delivery panic" });
    const defect = new Error("delivery defect");
    const nonErrorDefect = { broken: true };
    const context = {
      topic: "cmd.request",
      cursor: "2-0",
      phase: "delivery-action" as const,
    };

    reporter.report(panic, context);
    reporter.report(panic, context);
    reporter.report(defect, context);
    reporter.report(defect, context);
    reporter.report(nonErrorDefect, context);
    reporter.report(nonErrorDefect, context);

    expect(reported).toHaveLength(3);
    expect(reported[0]).toBe(panic);
    expect(reported[1]).toBe(defect);
    expect(Panic.is(reported[2])).toBe(true);
  });

  it("supervises router transport termination without a direct done await", async () => {
    const routerDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const fatalObserved = Promise.withResolvers<void>();
    const reported: Error[] = [];
    let healthy = true;
    const reportFatalError = createCoreRuntimeFatalReporter((error) => {
      reported.push(error);
      fatalObserved.resolve();
    });
    const transportFailure = new EventDeliveryTransportFailed({
      topic: "evt.request",
      operation: "ack",
      cursor: "7-0",
      cause: new Error("Redis connection closed"),
      message: "Redis delivery acknowledgement failed",
    });

    const supervision = superviseCoreRouterDone({
      done: routerDone.promise,
      isStopping: () => false,
      markUnhealthy: () => {
        healthy = false;
      },
      reportFatalError,
    });
    routerDone.resolve(Result.err(transportFailure));

    await fatalObserved.promise;
    reportFatalError(transportFailure);
    await supervision;

    expect(reported).toEqual([transportFailure]);
    expect(healthy).toBe(false);
  });

  it("preserves a rejected router Panic identity at fatal supervision", async () => {
    const panic = new Panic({ message: "router delivery invariant failed" });
    const reported: Error[] = [];

    await superviseCoreRouterDone({
      done: Promise.reject(panic),
      isStopping: () => false,
      markUnhealthy: () => {},
      reportFatalError: (error) => reported.push(error),
    });

    expect(reported).toEqual([panic]);
  });

  it("waits for subscription and dead-letter work before closing owned Redis", async () => {
    const calls: string[] = [];
    const deliveryStarted = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const routerDone = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
    const reported: Error[] = [];
    let stopping = false;
    const cleanup = createCoreRuntimeCleanupSupervisor(null);
    const routerSupervision = superviseCoreRouterDone({
      done: routerDone.promise,
      isStopping: () => stopping,
      markUnhealthy: () => {
        throw new Error("requested shutdown must not mark the runtime unhealthy");
      },
      reportFatalError: (error) => reported.push(error),
    });

    const shutdown = (async () => {
      stopping = true;
      await cleanup.run("subscription.stop", async () => {
        calls.push("subscription.stop");
        deliveryStarted.resolve();
        await releaseDelivery.promise;
        calls.push("dead-letter.done");
        routerDone.resolve(Result.ok(undefined));
      });
      await cleanup.run("subscription.done", () => routerSupervision);
      await cleanup.run("bus.close", async () => {
        calls.push("redis.close");
      });
      cleanup.finish();
    })();

    await deliveryStarted.promise;
    expect(calls).toEqual(["subscription.stop"]);
    releaseDelivery.resolve();
    await shutdown;

    expect(calls).toEqual(["subscription.stop", "dead-letter.done", "redis.close"]);
    expect(reported).toEqual([]);
  });
});
