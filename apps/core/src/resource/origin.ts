import { Result, type Result as ResultType } from "better-result";

import type { ResourceOriginV1, ResourceRecordV1 } from "./contracts";
import { ResourceOriginUnavailable } from "./errors";

export type ResolvedResourceOrigin = {
  readonly url: URL;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly reportedByteLength?: number;
};

export interface ResourceOriginAdapter<TOrigin extends ResourceOriginV1 = ResourceOriginV1> {
  readonly kind: TOrigin["kind"];
  resolve(input: {
    readonly record: ResourceRecordV1 & { readonly origin: TOrigin };
    readonly signal?: AbortSignal;
  }): Promise<ResultType<ResolvedResourceOrigin, ResourceOriginUnavailable>>;
}

export class ResourceOriginAdapterRegistry {
  readonly #adapters: ReadonlyMap<ResourceOriginV1["kind"], ResourceOriginAdapter>;

  constructor(adapters: readonly ResourceOriginAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  resolve(input: {
    readonly record: ResourceRecordV1;
    readonly signal?: AbortSignal;
  }): Promise<ResultType<ResolvedResourceOrigin, ResourceOriginUnavailable>> {
    const adapter = this.#adapters.get(input.record.origin.kind);
    if (adapter !== undefined) return adapter.resolve(input);
    return Promise.resolve(
      Result.err(
        new ResourceOriginUnavailable({
          uri: `resource://${input.record.resourceId}`,
          retryable: false,
          message: "No origin adapter is registered for this resource",
        }),
      ),
    );
  }
}
