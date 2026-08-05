import type { FixtureEventBus } from "../stage4-event-api/api.ts";

export function unregisteredCrossWorkspaceConsumer(bus: FixtureEventBus): void {
  void bus.subscribeTopic();
}
