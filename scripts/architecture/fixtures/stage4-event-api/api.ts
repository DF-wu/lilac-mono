export interface FixtureMessage {
  readonly type: string;
}

export type FixtureDeliveryError =
  | { readonly _tag: "HandlerFailed" }
  | { readonly _tag: "Stopping" };

export interface FixtureEventBus {
  subscribeTopic(): Promise<void>;
}

export function fixtureDeliveryPolicy(error: FixtureDeliveryError): "park-pending" | "stop" {
  switch (error._tag) {
    case "HandlerFailed":
      return "park-pending";
    case "Stopping":
      return "stop";
  }
}
