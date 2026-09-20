import { createContext, useContext } from "react";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import type { AppProps } from "../types";

export type MessageServices = Pick<AppProps, "resourceUrl"> & {
  canEdit: boolean;
  rewindDisabled?: boolean;
  upload?: AppProps["upload"];
  onAction: (
    messageId: string,
    part: Extract<DisplayPart, { type: "data-actions" }>,
    actionId: string,
  ) => void;
  onReaction: (messageId: string, emoji: string, active: boolean) => void;
};
export const MessageServicesContext = createContext<MessageServices | undefined>(undefined);
export function useMessageServices() {
  return useContext(MessageServicesContext)!;
}
