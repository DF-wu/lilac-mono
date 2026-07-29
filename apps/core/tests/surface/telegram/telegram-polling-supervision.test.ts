import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config/v2";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { GrammyError } from "grammy";

import {
  isFatalTelegramPollingExit,
  TelegramAdapter,
} from "../../../src/surface/telegram/telegram-adapter";
import { FakeBotApiServer } from "./fake-bot-api-server";
import { BOT_USER_ID, BOT_USERNAME } from "./telegram-fixtures";

/**
 * grammY calls `onStart` *before* the first `getUpdates`, so "ready" only means
 * polling was launched. A fatal 401/409 rejects `start()` moments later
 * (grammY's `handlePollingError` rethrows those two codes and retries
 * everything else). Without a supervisor on that promise the surface keeps
 * reporting ready while receiving nothing, and the rejection sits unhandled
 * until shutdown.
 */
const ALLOWED_CHAT = 1001;
const TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

let server: FakeBotApiServer;
let adapter: TelegramAdapter | null = null;
let scratchDir = "";
let previousToken: string | undefined;

function testConfig(): CoreConfig {
  const cfg = parseCoreConfigV2ToUniversal({
    configVersion: 2,
    surface: {
      telegram: {
        enabled: true,
        botName: "lilac",
        allowedChatIds: [String(ALLOWED_CHAT)],
        commandMenu: false,
      },
    },
  });
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

function makeAdapter(): TelegramAdapter {
  const cfg = testConfig();
  return new TelegramAdapter({
    apiRoot: server.url,
    getConfig: async () => ({
      ...cfg,
      surface: {
        ...cfg.surface,
        telegram: { ...cfg.surface.telegram, dbPath: path.join(scratchDir, "telegram.db") },
      },
    }),
  });
}

/**
 * Waits for the adapter to notice polling died. Resolves as soon as the health
 * snapshot degrades, so the successful path is never delayed.
 */
async function waitForPollingExit(a: TelegramAdapter): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (a.getHealthSnapshot().connectionState === "failed") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for the adapter to report a polling exit");
}

beforeEach(async () => {
  previousToken = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = "000000:fake-token";
  scratchDir = await mkdtemp(path.join(tmpdir(), "lilac-telegram-poll-"));
  server = new FakeBotApiServer(BOT_USER_ID, BOT_USERNAME);
});

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
  await server.close();
  await rm(scratchDir, { recursive: true, force: true });

  if (previousToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = previousToken;
});

describe("fatal polling exit classification", () => {
  const grammyError = (code: number, description: string) =>
    new GrammyError(
      "Call to getUpdates failed!",
      { ok: false, error_code: code, description },
      "getUpdates",
      {},
    );

  it("treats a rival poller and a bad token as fatal", () => {
    // These are exactly the two codes grammY rethrows rather than retrying,
    // so they are the only ones that can terminate polling by themselves.
    expect(
      isFatalTelegramPollingExit(
        grammyError(409, "Conflict: terminated by other getUpdates request"),
      ),
    ).toBe(true);
    expect(isFatalTelegramPollingExit(grammyError(401, "Unauthorized"))).toBe(true);
  });

  it("does not treat retryable failures as fatal", () => {
    expect(isFatalTelegramPollingExit(grammyError(429, "Too Many Requests"))).toBe(false);
    expect(isFatalTelegramPollingExit(grammyError(500, "Internal Server Error"))).toBe(false);
    expect(isFatalTelegramPollingExit(new Error("socket hang up"))).toBe(false);
    expect(isFatalTelegramPollingExit(null)).toBe(false);
  });
});

describe("polling supervision", () => {
  it("reports the surface unhealthy when a 409 kills polling after ready", async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.whenReady();

    // Ready before the failure: this is the state that used to persist.
    expect(adapter.getHealthSnapshot()).toMatchObject({
      connectionState: "ready",
      isReady: true,
    });

    server.failNext("getUpdates", {
      errorCode: 409,
      description: "Conflict: terminated by other getUpdates request",
    });

    await waitForPollingExit(adapter);

    const health = adapter.getHealthSnapshot();
    expect(health.isReady).toBe(false);
    expect(health.connectionState).toBe("failed");
    expect(health.pollingExitFatal).toBe(true);
    expect(health.pollingExitedAt).toBeGreaterThan(0);
    // The reason has to survive into the snapshot, or an operator sees a red
    // check with nothing to act on.
    expect(health.lastError).toContain("Conflict");
  });

  it("reports unhealthy when a 401 kills polling", async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.whenReady();

    server.failNext("getUpdates", { errorCode: 401, description: "Unauthorized" });
    await waitForPollingExit(adapter);

    expect(adapter.getHealthSnapshot()).toMatchObject({
      isReady: false,
      connectionState: "failed",
      pollingExitFatal: true,
    });
  });

  it("reports a failure through whenReady() once the exit is known", async () => {
    // grammY fires onStart *before* the first getUpdates, so a caller that
    // asks during that window legitimately gets a clean answer — the failure
    // has not happened yet. What must not happen is whenReady() continuing to
    // report success after the exit is known.
    server.failNext("getUpdates", {
      errorCode: 409,
      description: "Conflict: terminated by other getUpdates request",
    });

    adapter = makeAdapter();
    await adapter.connect();
    await waitForPollingExit(adapter);

    await expect(adapter.whenReady()).rejects.toThrow(/Conflict/);
    expect(adapter.getHealthSnapshot().isReady).toBe(false);
  });

  it("does not report a failure for a deliberate disconnect", async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.whenReady();

    await adapter.disconnect();

    const health = adapter.getHealthSnapshot();
    expect(health.connectionState).toBe("disconnected");
    expect(health.isReady).toBe(false);
    // `failed` and `disconnected` must stay distinguishable, otherwise every
    // clean shutdown looks like an incident.
    expect(health.pollingExitedAt).toBeUndefined();
    expect(health.pollingExitFatal).toBeUndefined();

    adapter = null;
  });

  it("keeps polling through a retryable error rather than reporting failure", async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.whenReady();

    // grammY retries a 500 internally, so `start()` never settles and the
    // supervisor must stay quiet. This guards against classifying every
    // hiccup as a terminal exit.
    server.failNext("getUpdates", { errorCode: 500, description: "Internal Server Error" });

    await server.waitForCall("getUpdates", server.callsOf("getUpdates").length + 1);

    expect(adapter.getHealthSnapshot()).toMatchObject({
      connectionState: "ready",
      isReady: true,
    });
  });
});
