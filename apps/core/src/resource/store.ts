import type { Result } from "better-result";

import type { ResourceCacheV1, ResourceId, ResourceOriginV1, ResourceRecordV1 } from "./contracts";
import type { ResourceStoreFailure } from "./errors";

export type ResourceRegisterDecision =
  | { readonly kind: "created" | "existing"; readonly record: ResourceRecordV1 }
  | { readonly kind: "collision" };

export type ResourceCacheAttachDecision =
  | { readonly kind: "attached"; readonly record: ResourceRecordV1 }
  | { readonly kind: "lost"; readonly record: ResourceRecordV1 | null };

export type ResourceUnretainedFinalization =
  | { readonly kind: "deleted" | "absent" }
  | { readonly kind: "retained" | "changed"; readonly record: ResourceRecordV1 };

export interface ResourceStore {
  registerOrGet(input: {
    readonly candidateResourceId: ResourceId;
    readonly origin: ResourceOriginV1;
    readonly filename?: string;
    readonly declaredMediaType?: string;
    readonly reportedByteLength?: number;
    readonly createdAt: number;
  }): Result<ResourceRegisterDecision, ResourceStoreFailure>;

  getRetained(resourceId: ResourceId): Result<ResourceRecordV1 | null, ResourceStoreFailure>;

  compareAndSwapCache(input: {
    readonly resourceId: ResourceId;
    readonly expected?: ResourceCacheV1;
    readonly next: ResourceCacheV1;
    readonly detectedMediaType?: string;
  }): Result<ResourceCacheAttachDecision, ResourceStoreFailure>;

  clearCache(input: {
    readonly resourceId: ResourceId;
    readonly expected: ResourceCacheV1;
  }): Result<boolean, ResourceStoreFailure>;

  recordDetectedMediaType(input: {
    readonly resourceId: ResourceId;
    readonly expected?: string;
    readonly next: string;
  }): Result<boolean, ResourceStoreFailure>;

  listUnretained(input: {
    readonly limit: number;
  }): Result<readonly ResourceRecordV1[], ResourceStoreFailure>;

  finalizeUnretained(input: {
    readonly resourceId: ResourceId;
    readonly expectedCache?: ResourceCacheV1;
  }): Result<ResourceUnretainedFinalization, ResourceStoreFailure>;
}
