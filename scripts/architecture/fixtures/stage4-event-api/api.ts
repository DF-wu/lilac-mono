export interface FixtureMessage {
  readonly type: string;
}

export type FixtureDeliveryError =
  | { readonly _tag: "HandlerFailed" }
  | { readonly _tag: "Stopping" };

export interface FixtureEventBus {
  subscribeTopic(): Promise<void>;
}

export function fixtureDeliveryPolicy(error: FixtureDeliveryError): "retry" | "stop" {
  switch (error._tag) {
    case "HandlerFailed":
      return "retry";
    case "Stopping":
      return "stop";
  }
}
