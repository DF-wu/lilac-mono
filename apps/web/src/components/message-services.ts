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
  /** Puts the option into the reply draft. It never sends. */
  onOption: (messageId: string, ordinal: number, index: number) => void;
  onReply: (messageId: string) => void;
  /** Resolves with an error message when the dismissal is not accepted. */
  onDismiss: (question: NativeQuestion) => Promise<string | undefined>;
};
/** The question the composer is replying to, and its options already in the reply draft. */
export type QuestionReplyView = { messageId?: string; chosen: readonly string[] };
export const QuestionReplyContext = createContext<QuestionReplyView>({ chosen: [] });
export const MessageServicesContext = createContext<MessageServices | undefined>(undefined);
export const DisplayStreamContext = createContext<DisplayStreamTarget | undefined>(undefined);
export function useMessageServices() {
  return useContext(MessageServicesContext)!;
}
