import { TaggedError } from "better-result";

export class RichRenderFailed extends TaggedError("RichRenderFailed")<{
  readonly message: string;
}> {}
