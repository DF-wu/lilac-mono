import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";

import { DefaultBrowserPageAcquisition } from "../../src/tool-server/tools/web/browser-page-acquisition";
import { PageContent } from "../../src/tool-server/tools/web/page-content";

function createAcquisition(
  close: () => Promise<void>,
  goto: () => Promise<void> = async () => {},
): DefaultBrowserPageAcquisition {
  const acquisition = new DefaultBrowserPageAcquisition(
    new PageContent(),
    createLogger({ module: "browser-page-acquisition-test" }),
  );
  Object.defineProperty(acquisition, "ensureBrowserContext", {
    value: async () => ({
      context: {
        newPage: async () => ({
          goto,
          evaluate: async () => {},
          content: async () => "<html><body>content</body></html>",
          close,
        }),
      },
    }),
  });
  return acquisition;
}

describe("browser page acquisition cleanup", () => {
  it("gives page close failures precedence over acquisition failures", async () => {
    const acquisitionFailure = new Error("page acquisition failed");
    const failure = new Error("page close failed");
    const acquisition = createAcquisition(
      () => Promise.reject(failure),
      () => Promise.reject(acquisitionFailure),
    );

    const [settled] = await Promise.allSettled([
      acquisition.acquire({ url: "https://example.com" }),
    ]);

    expect(settled).toEqual({ status: "rejected", reason: failure });
  });

  it("preserves Panic from page close", async () => {
    const panic = new Panic({ message: "page close invariant" });
    const acquisition = createAcquisition(() => Promise.reject(panic));

    const [settled] = await Promise.allSettled([
      acquisition.acquire({ url: "https://example.com" }),
    ]);

    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") {
      expect(settled.reason).toBe(panic);
      expect(Panic.is(settled.reason)).toBe(true);
    }
  });

  for (const closeFailure of [
    new Error("page close rejected while navigation remained pending"),
    new Panic({ message: "page close panicked while navigation remained pending" }),
  ]) {
    it(`observes ${closeFailure.name} from abort close before pending navigation settles`, async () => {
      const navigation = Promise.withResolvers<void>();
      const navigationStarted = Promise.withResolvers<void>();
      const closeStarted = Promise.withResolvers<void>();
      const acquisition = createAcquisition(
        () => {
          closeStarted.resolve();
          return Promise.reject(closeFailure);
        },
        async () => {
          navigationStarted.resolve();
          await navigation.promise;
        },
      );
      const controller = new AbortController();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        const pending = acquisition.acquire(
          { url: "https://example.com" },
          { signal: controller.signal },
        );
        const settledPending = Promise.allSettled([pending]);
        await navigationStarted.promise;
        controller.abort();
        await closeStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);

        navigation.resolve();
        const [settled] = await settledPending;
        expect(settled?.status).toBe("rejected");
        if (settled?.status === "rejected") expect(settled.reason).toBe(closeFailure);
      } finally {
        navigation.resolve();
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }
});
