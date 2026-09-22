import type { CommandOutcome } from "@stanley2058/lilac-client";
import type { NativeInput } from "@stanley2058/lilac-client-protocol";
import type { ComposerSubmission } from "./types";

export type PendingInput = {
  commandId: string;
  text: string;
  submission: ComposerSubmission;
  input?: NativeInput;
  error?: string;
  state: "preparing" | "uncertain" | "rejected";
};

export async function deliverPendingInput(
  entry: PendingInput,
  prepare: () => Promise<NativeInput | undefined>,
  submit: (input: NativeInput) => Promise<CommandOutcome>,
  update: (patch: Partial<PendingInput> | null) => void,
  editable: boolean,
): Promise<CommandOutcome | undefined> {
  if (!editable) {
    update({
      state: entry.state === "uncertain" ? "uncertain" : "rejected",
      error: "You no longer have permission to send to this conversation.",
    });
    return;
  }
  update({ state: "preparing", error: undefined });
  const retained = entry.state === "uncertain" ? entry.input : undefined;
  const input = retained ?? (await prepare());
  if (!input) return;
  update({ input });
  const outcome = await submit(input);
  switch (outcome.kind) {
    case "accepted":
      update(null);
      return outcome;
    case "uncertain":
      update({ state: "uncertain", error: "Send not confirmed. Retry safely when connected." });
      return outcome;
    case "rejected":
      update({ input: undefined, state: "rejected", error: outcome.error.message });
      return outcome;
  }
}
