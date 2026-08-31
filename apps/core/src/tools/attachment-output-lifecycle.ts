import type { BlobHandleV1 } from "@stanley2058/lilac-blob-storage";
import { TaggedError, type Result } from "better-result";

export class AttachmentOutputLifecycleError extends TaggedError("AttachmentOutputLifecycleError")<{
  readonly message: string;
}> {}

export type AttachmentOutputLifecycle = {
  registerOutputHandle(input: {
    readonly requestId: string;
    readonly requestDeliveryId?: string;
    readonly handle: BlobHandleV1;
    readonly mimeType: string;
    readonly filename?: string;
  }):
    | Result<void, AttachmentOutputLifecycleError>
    | Promise<Result<void, AttachmentOutputLifecycleError>>;
};
