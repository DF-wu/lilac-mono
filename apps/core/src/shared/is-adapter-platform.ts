import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

export function isAdapterPlatform(x: unknown): x is AdapterPlatform {
  return (
    x === "discord" ||
    x === "github" ||
    x === "native" ||
    x === "whatsapp" ||
    x === "slack" ||
    x === "telegram" ||
    x === "web" ||
    x === "unknown"
  );
}
