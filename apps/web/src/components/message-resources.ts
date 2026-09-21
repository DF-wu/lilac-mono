import { createContext } from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";

export type MessageResource = Extract<DisplayPart, { type: "data-resource" }>["data"];
export const MessageResourcesContext = createContext<
  ReadonlyMap<string, { resource: MessageResource; href: string }>
>(new Map());
