import { createContext, useContext } from "react";
import type {
  DisplayPart,
  DisplayStreamTarget,
  NativeQuestion,
} from "@stanley2058/lilac-client-protocol";
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
  questions?: QuestionServices;
};
export type QuestionServices = {
  /** Opens the question in the composer. */
  onReply: (messageId: string) => void;
  /** Resolves with an error message when the dismissal is not accepted. */
  onDismiss: (question: NativeQuestion) => Promise<string | undefined>;
};
/** The question the composer is answering. */
export type QuestionReplyView = { messageId?: string };
export const QuestionReplyContext = createContext<QuestionReplyView>({});
export const MessageServicesContext = createContext<MessageServices | undefined>(undefined);
export const DisplayStreamContext = createContext<DisplayStreamTarget | undefined>(undefined);
export function useMessageServices() {
  return useContext(MessageServicesContext)!;
}
