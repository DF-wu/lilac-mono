import type { SurfaceRuntimeHealthPort } from "../runtime-descriptor";
import type { TelegramAdapterHealthSnapshot } from "./telegram-adapter";

export type TelegramRuntimeHealthProvider = {
  getHealthSnapshot(): TelegramAdapterHealthSnapshot;
};

export function createTelegramRuntimeHealthPort(
  provider: TelegramRuntimeHealthProvider,
  isRequestRouterHealthy: () => boolean = () => true,
): SurfaceRuntimeHealthPort {
  return {
    getContribution: ({ runtimeFullyStarted }) => {
      const telegram = provider.getHealthSnapshot();
      const requestRouterHealthy = isRequestRouterHealthy();
      return {
        checks: [
          {
            name: "telegram.ready",
            ok: !runtimeFullyStarted || telegram.isReady,
            impact: "ready",
            reason:
              !runtimeFullyStarted || telegram.isReady
                ? undefined
                : "telegram long polling is not ready",
            details: telegram,
          },
          {
            name: "telegram.request-router",
            ok: requestRouterHealthy,
            impact: "ready",
            reason: requestRouterHealthy
              ? undefined
              : "telegram request router subscriptions terminated",
          },
        ],
        info: telegram,
      };
    },
  };
}
