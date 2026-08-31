import { TaggedError } from "better-result";

export class ResourceInvalidUri extends TaggedError("ResourceInvalidUri")<{
  readonly uri: string;
  readonly message: string;
}> {}

export class ResourceNotFound extends TaggedError("ResourceNotFound")<{
  readonly uri: string;
  readonly message: string;
}> {}

export class ResourceOriginUnavailable extends TaggedError("ResourceOriginUnavailable")<{
  readonly uri: string;
  readonly retryable: boolean;
  readonly message: string;
}> {}

export class ResourceUnsupportedClassification extends TaggedError(
  "ResourceUnsupportedClassification",
)<{
  readonly uri: string;
  readonly expected: "text" | "image" | "pdf" | "any";
  readonly detectedMediaType?: string;
  readonly message: string;
}> {}

export class ResourceTooLarge extends TaggedError("ResourceTooLarge")<{
  readonly uri: string;
  readonly limit: number;
  readonly limitKind: "resource" | "operation";
  readonly reportedBytes?: number;
  readonly observedBytes?: number;
  readonly message: string;
}> {}

export class ResourceCacheUnavailable extends TaggedError("ResourceCacheUnavailable")<{
  readonly uri: string;
  readonly retryable: boolean;
  readonly message: string;
}> {}

export class ResourceIntegrityFailure extends TaggedError("ResourceIntegrityFailure")<{
  readonly uri: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class ResourceCancelled extends TaggedError("ResourceCancelled")<{
  readonly uri: string;
  readonly message: string;
}> {}

export class ResourceAlreadyExists extends TaggedError("ResourceAlreadyExists")<{
  readonly uri: string;
  readonly path: string;
  readonly message: string;
}> {}

export class ResourceWriteFailed extends TaggedError("ResourceWriteFailed")<{
  readonly uri: string;
  readonly path: string;
  readonly message: string;
}> {}

export class ResourceStoreFailure extends TaggedError("ResourceStoreFailure")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class ResourceIdCollisionExhausted extends TaggedError("ResourceIdCollisionExhausted")<{
  readonly attempts: number;
  readonly message: string;
}> {}

export type ResourceAccessError =
  | ResourceInvalidUri
  | ResourceNotFound
  | ResourceOriginUnavailable
  | ResourceUnsupportedClassification
  | ResourceTooLarge
  | ResourceCacheUnavailable
  | ResourceIntegrityFailure
  | ResourceCancelled
  | ResourceAlreadyExists
  | ResourceWriteFailed;

export type ResourceRegistrationError = ResourceStoreFailure | ResourceIdCollisionExhausted;
