import { describe, expect, it } from "bun:test";

import type { TelegramAdapterHealthSnapshot } from "../../../src/surface/telegram/telegram-adapter";
import { createTelegramRuntimeHealthPort } from "../../../src/surface/telegram/telegram-runtime-health";

describe("Telegram runtime health", () => {
  it("reports polling readiness only after runtime startup", async () => {
    const snapshot: TelegramAdapterHealthSnapshot = {
      connectionState: "failed",
      isReady: false,
      pollingExitedAt: 42,
      pollingExitFatal: true,
    };
    const health = createTelegramRuntimeHealthPort({ getHealthSnapshot: () => snapshot });

    const starting = await health.getContribution({
      now: 50,
      runtimeFullyStarted: false,
      includeMemoryDiagnostics: false,
    });
    const started = await health.getContribution({
      now: 50,
      runtimeFullyStarted: true,
      includeMemoryDiagnostics: false,
    });

    expect(starting.checks[0]?.ok).toBe(true);
    expect(started.checks[0]).toMatchObject({
      name: "telegram.ready",
      ok: false,
      impact: "ready",
      reason: "telegram long polling is not ready",
      details: snapshot,
    });
    expect(started.info).toEqual(snapshot);
  });
});
