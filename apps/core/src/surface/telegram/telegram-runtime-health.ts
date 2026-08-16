import type { SurfaceRuntimeHealthPort } from "../runtime-descriptor";
import type { TelegramAdapterHealthSnapshot } from "./telegram-adapter";

export type TelegramRuntimeHealthProvider = {
  getHealthSnapshot(): TelegramAdapterHealthSnapshot;
};

export function createTelegramRuntimeHealthPort(
  provider: TelegramRuntimeHealthProvider,
): SurfaceRuntimeHealthPort {
  return {
    getContribution: ({ runtimeFullyStarted }) => {
      const telegram = provider.getHealthSnapshot();
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
        ],
        info: telegram,
      };
    },
  };
}
