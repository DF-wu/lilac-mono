import { createHash } from "node:crypto";

import { Result, type Result as ResultType } from "better-result";

import {
  captureAdapterOperation,
  expiryIndexKey,
  LAYOUT_MARKER,
  metadataKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
  signalBlobAdapterFailure,
  temporaryKey,
  type BlobBackend,
  type BlobSink,
} from "./backend";
import { BlobAdapterFailure } from "./errors";

export type S3BackendOptions = {
  readonly bucket: string;
  readonly prefix?: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly forcePathStyle?: boolean;
  readonly client?: Bun.S3Client;
  readonly clientFactory?: (options: Bun.S3Options) => Bun.S3Client;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export class S3BlobBackend implements BlobBackend {
  readonly kind = "s3" as const;
  readonly #client: Bun.S3Client;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #prefix: string;

  constructor(options: S3BackendOptions) {
    this.#prefix = normalizePrefix(options.prefix);
    const clientOptions: Bun.S3Options = {
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      virtualHostedStyle:
        options.forcePathStyle === undefined ? undefined : !options.forcePathStyle,
    };
    this.#client =
      options.client ?? options.clientFactory?.(clientOptions) ?? new Bun.S3Client(clientOptions);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async initialize(input: {
    readonly createIfMissing: boolean;
  }): Promise<ResultType<void, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "initialize layout",
      run: async () => {
        const marker = this.#key("layout.json");
        const exists = await this.#client.exists(marker);
        if (!exists && input.createIfMissing) {
          await this.#client.write(marker, LAYOUT_MARKER, {
            acl: "private",
            type: "application/json",
          });
        }
        if (!exists && !input.createIfMissing) {
          signalBlobAdapterFailure("Blob storage layout marker is absent");
        }
        const value = exists ? await this.#client.file(marker).text() : LAYOUT_MARKER;
        if (value !== LAYOUT_MARKER) {
          signalBlobAdapterFailure("Unsupported blob storage layout marker");
        }
      },
    });
  }

  async createReservation(
    objectId: string,
    serialized: string,
    expiresAt?: number,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const reserved = await this.#writeText(
      reservationKey(objectId),
      serialized,
      "create upload reservation",
    );
    if (expiresAt === undefined) return reserved;
    const reservationFailure = reserved.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (reservationFailure !== null) return Result.err(reservationFailure);
    const indexed = await this.#writeText(
      expiryIndexKey(expiresAt, objectId),
      "",
      "create expiry index",
    );
    const indexFailure = indexed.match<BlobAdapterFailure | null>({
      ok: () => null,
      err: (failure) => failure,
    });
    if (indexFailure === null) return Result.ok(undefined);
    await this.deleteKeys([reservationKey(objectId)]);
    await this.deleteKeys([expiryIndexKey(expiresAt, objectId)]);
    return Result.err(indexFailure);
  }

  async readReservation(objectId: string): Promise<ResultType<string | null, BlobAdapterFailure>> {
    for (const reservationPath of [
      reservationFenceKey(objectId),
      reservationTransitionKey(objectId),
      reservationKey(objectId),
    ]) {
      const key = this.#key(reservationPath);
      const read = await captureAdapterOperation({
        adapter: this.kind,
        operation: "read upload reservation",
        run: async () => {
          if (!(await this.#client.exists(key))) return null;
          return this.#client.file(key).text();
        },
      });
      const outcome = read.match<
        | { readonly kind: "value"; readonly value: string | null }
        | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
      >({
        ok: (value) => ({ kind: "value", value }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (outcome.kind === "failure") return Result.err(outcome.failure);
      if (outcome.value !== null) return Result.ok(outcome.value);
    }
    return Result.ok(null);
  }

  async compareAndSwapReservation(
    objectId: string,
    expectedSerialized: string,
    serialized: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const observed = await this.readReservation(objectId);
    const state = observed.match<
      | { readonly kind: "value"; readonly value: string | null }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "failure") return Result.err(state.failure);
    if (state.value !== expectedSerialized) return Result.ok(false);
    const key = expectedSerialized.includes('"state":"pending"')
      ? reservationTransitionKey(objectId)
      : reservationFenceKey(objectId);
    const published = await this.#writeTextExclusive(
      key,
      serialized,
      "compare and swap upload reservation",
    );
    const publishState = published.match<
      | { readonly kind: "published"; readonly published: boolean }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (value) => ({ kind: "published", published: value }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (publishState.kind === "failure") return Result.err(publishState.failure);
    if (!publishState.published) return Result.ok(false);
    const effective = await this.readReservation(objectId);
    return effective.map((value) => value === serialized);
  }

  async openSink(
    objectId: string,
    generation: string,
  ): Promise<ResultType<BlobSink, BlobAdapterFailure>> {
    const key = this.#key(temporaryKey(objectId, generation));
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "open temporary upload",
      run: async () => this.#client.file(key).writer({ acl: "private" }),
    }).then((opened) =>
      opened.map((writer) => {
        let settled = false;
        return {
          write: async (chunk) =>
            captureAdapterOperation({
              adapter: this.kind,
              operation: "write upload content",
              run: async () => {
                await writer.write(chunk);
              },
            }),
          finish: async () => {
            if (settled) return Result.ok(undefined);
            const finished = await captureAdapterOperation({
              adapter: this.kind,
              operation: "finish upload content",
              run: async () => {
                await writer.end();
              },
            });
            const complete = finished.match({
              ok: () => true,
              err: () => false,
            });
            if (complete) settled = true;
            return finished;
          },
          abort: async () => {
            if (settled) return Result.ok(undefined);
            settled = true;
            const ended = await captureAdapterOperation({
              adapter: this.kind,
              operation: "abort temporary upload",
              run: async () => {
                await writer.end(new Error("Blob upload interrupted"));
              },
            });
            const removed = await captureAdapterOperation({
              adapter: this.kind,
              operation: "remove aborted temporary upload",
              run: async () => this.#client.delete(key),
            });
            return ended.andThen(() => removed);
          },
        };
      }),
    );
  }

  async commitTemp(
    objectId: string,
    generation: string,
    contentKey: string,
    metadata: string,
    expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const temporary = this.#key(temporaryKey(objectId, generation));
    const destination = this.#key(contentKey);
    const metadataPath = this.#key(metadataKey(contentKey));
    const copiedOperation = captureAdapterOperation({
      adapter: this.kind,
      operation: "commit upload content",
      run: async () => {
        await this.#client.write(destination, this.#client.file(temporary), {
          acl: "private",
        });
      },
    });
    const metadataOperation = captureAdapterOperation({
      adapter: this.kind,
      operation: "commit upload metadata",
      run: async () => {
        await this.#client.write(metadataPath, metadata, {
          acl: "private",
          type: "application/json",
        });
      },
    });
    const [copied, metadataWritten] = await Promise.all([copiedOperation, metadataOperation]);
    const copyState = copied.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (!copyState.complete) {
      const inspected = await this.#inspectAmbiguousContent(destination, expected);
      const recovered = inspected.match({
        ok: (valid) => valid,
        err: () => false,
      });
      if (!recovered) return Result.err(copyState.failure);
    }

    const metadataState = metadataWritten.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (!metadataState.complete) {
      const inspected = await captureAdapterOperation({
        adapter: this.kind,
        operation: "inspect ambiguous metadata write",
        run: async () =>
          (await this.#client.exists(metadataPath)) &&
          (await this.#client.file(metadataPath).text()) === metadata,
      });
      const recovered = inspected.match({
        ok: (valid) => valid,
        err: () => false,
      });
      if (!recovered) return Result.err(metadataState.failure);
    }

    return captureAdapterOperation({
      adapter: this.kind,
      operation: "remove committed temporary upload",
      run: async () => {
        await this.#client.delete(temporary);
      },
    });
  }

  async openContent(
    contentKey: string,
  ): Promise<ResultType<ReadableStream<Uint8Array> | null, BlobAdapterFailure>> {
    const key = this.#key(contentKey);
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "open blob content",
      run: async () => {
        if (!(await this.#client.exists(key))) return null;
        await this.#client.stat(key);
        return this.#client.file(key).stream();
      },
    });
  }

  async readMetadata(contentKey: string): Promise<ResultType<string | null, BlobAdapterFailure>> {
    const key = this.#key(metadataKey(contentKey));
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "read blob metadata",
      run: async () => {
        if (!(await this.#client.exists(key))) return null;
        return this.#client.file(key).text();
      },
    });
  }

  async deleteKeys(keys: readonly string[]): Promise<ResultType<number, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "delete blob objects",
      run: async () => {
        let deleted = 0;
        for (const key of keys) {
          const fullKey = this.#key(key);
          if (await this.#client.exists(fullKey)) {
            await this.#client.delete(fullKey);
            deleted += 1;
          }
        }
        return deleted;
      },
    });
  }

  async listExpiredReservationIds(
    now: number,
    limit: number,
  ): Promise<
    ResultType<{ readonly ids: readonly string[]; readonly remaining: boolean }, BlobAdapterFailure>
  > {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "list expired upload reservations",
      run: async () => {
        const requested = Math.min(1_000, limit + 1);
        const response = await this.#client.list({
          prefix: this.#key("expiry/"),
          maxKeys: requested,
        });
        const prefixLength = this.#key("expiry/").length;
        const ids = (response.contents ?? [])
          .map(({ key }) => key.slice(prefixLength))
          .filter((key) => {
            const [partition] = key.split("/");
            return partition !== undefined && Number(partition) <= now;
          })
          .map((key) => key.split("/")[1])
          .filter((objectId): objectId is string => objectId !== undefined);
        return {
          ids: ids.slice(0, limit),
          remaining: response.isTruncated === true || ids.length > limit,
        };
      },
    });
  }

  async #writeText(
    key: string,
    serialized: string,
    operation: string,
  ): Promise<ResultType<void, BlobAdapterFailure>> {
    const fullKey = this.#key(key);
    const written = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => {
        await this.#client.write(fullKey, serialized, {
          acl: "private",
          type: "application/json",
        });
      },
    });
    const state = written.match<
      | { readonly complete: true }
      | { readonly complete: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ complete: true }),
      err: (failure) => ({ complete: false, failure }),
    });
    if (state.complete) return Result.ok(undefined);
    const inspected = await captureAdapterOperation({
      adapter: this.kind,
      operation: `inspect ambiguous ${operation}`,
      run: async () =>
        (await this.#client.exists(fullKey)) &&
        (await this.#client.file(fullKey).text()) === serialized,
    });
    return inspected.match<ResultType<void, BlobAdapterFailure>>({
      ok: (matches) => (matches ? Result.ok(undefined) : Result.err(state.failure)),
      err: () => Result.err(state.failure),
    });
  }

  async #writeTextExclusive(
    key: string,
    serialized: string,
    operation: string,
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    const fullKey = this.#key(key);
    const written = await captureAdapterOperation({
      adapter: this.kind,
      operation,
      run: async () => {
        const response = await this.#fetch(
          this.#client.presign(fullKey, {
            method: "PUT",
            expiresIn: 60,
            acl: "private",
            type: "application/json",
          }),
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "if-none-match": "*",
              "x-amz-acl": "private",
            },
            body: serialized,
          },
        );
        return { ok: response.ok, status: response.status };
      },
    });
    const state = written.match<
      | { readonly kind: "response"; readonly ok: boolean; readonly status: number }
      | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
    >({
      ok: (response) => ({ kind: "response", ...response }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "response" && state.ok) return Result.ok(true);
    if (state.kind === "response" && state.status === 412) return Result.ok(false);

    const inspected = await captureAdapterOperation({
      adapter: this.kind,
      operation: `inspect ambiguous ${operation}`,
      run: async () =>
        (await this.#client.exists(fullKey)) &&
        (await this.#client.file(fullKey).text()) === serialized,
    });
    return inspected.match<ResultType<boolean, BlobAdapterFailure>>({
      ok: (matches) =>
        matches
          ? Result.ok(true)
          : Result.err(
              state.kind === "failure"
                ? state.failure
                : new BlobAdapterFailure({
                    adapter: this.kind,
                    kind: "io",
                    operation,
                    message: `s3 blob storage failed to ${operation}`,
                  }),
            ),
      err: (failure) => Result.err(state.kind === "failure" ? state.failure : failure),
    });
  }

  async #inspectAmbiguousContent(
    key: string,
    expected: { readonly sha256: string; readonly byteLength: number },
  ): Promise<ResultType<boolean, BlobAdapterFailure>> {
    return captureAdapterOperation({
      adapter: this.kind,
      operation: "inspect ambiguous content write",
      run: async () => {
        if (!(await this.#client.exists(key))) return false;
        const bytes = new Uint8Array(await this.#client.file(key).arrayBuffer());
        return (
          bytes.byteLength === expected.byteLength &&
          createHash("sha256").update(bytes).digest("hex") === expected.sha256
        );
      },
    });
  }

  #key(key: string): string {
    return this.#prefix === "" ? key : `${this.#prefix}/${key}`;
  }
}

function normalizePrefix(prefix: string | undefined): string {
  return (prefix ?? "").replace(/^\/+|\/+$/gu, "");
}
