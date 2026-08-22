import * as fs from "node:fs/promises";
import path from "node:path";

import { Result, type Result as ResultType } from "better-result";

import { captureAdapterOperation, LAYOUT_MARKER, signalRetainedBlobPanic } from "./backend";
import type { BlobLifecycleLogger, BlobStore } from "./contracts";
import {
  BlobAdapterFailure,
  BlobAdapterLayoutInvalid,
  BlobInvalidConfiguration,
  type BlobStoreCreateError,
} from "./errors";
import {
  classifyLocalFileCause,
  LocalBlobBackend,
  type ClassifiedLocalFileCause,
} from "./local-backend";
import { MemoryBlobBackend } from "./memory-backend";
import { S3BlobBackend, type S3BackendOptions } from "./s3-backend";
import { SupervisedBlobStore } from "./store";

export type LocalBlobStoreOptions = {
  readonly root: string;
  readonly logger?: BlobLifecycleLogger;
};

export type S3BlobStoreOptions = Omit<S3BackendOptions, "client" | "clientFactory" | "fetch"> & {
  readonly logger?: BlobLifecycleLogger;
};

export type BlobStorePreflight = {
  readonly status: "ready" | "absent";
};

export async function createLocalBlobStore(
  options: LocalBlobStoreOptions,
): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  const valid = validateLocalOptions(options);
  return valid.match<Promise<ResultType<BlobStore, BlobStoreCreateError>>>({
    ok: async () => {
      const preflight = await preflightLocalBlobStore(options);
      return preflight.match<Promise<ResultType<BlobStore, BlobStoreCreateError>>>({
        ok: async () => initializeBackend(new LocalBlobBackend(options.root), options.logger),
        err: async (error) => Result.err(error),
      });
    },
    err: async (error) => Result.err(error),
  });
}

export async function createS3BlobStore(
  options: S3BlobStoreOptions,
): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  const valid = validateS3Options(options);
  return valid.match<Promise<ResultType<BlobStore, BlobStoreCreateError>>>({
    ok: async () => {
      const preflight = await preflightS3BlobStore(options);
      return preflight.match<Promise<ResultType<BlobStore, BlobStoreCreateError>>>({
        ok: async () => {
          const { logger, ...backendOptions } = options;
          return initializeBackend(new S3BlobBackend(backendOptions), logger);
        },
        err: async (error) => Result.err(error),
      });
    },
    err: async (error) => Result.err(error),
  });
}

export async function createMemoryBlobStore(options?: {
  readonly logger?: BlobLifecycleLogger;
}): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  return initializeBackend(new MemoryBlobBackend(), options?.logger);
}

export async function preflightLocalBlobStore(
  options: LocalBlobStoreOptions,
): Promise<ResultType<BlobStorePreflight, BlobStoreCreateError>> {
  const valid = validateLocalOptions(options);
  const validation = valid.match<BlobInvalidConfiguration | null>({
    ok: () => null,
    err: (error) => error,
  });
  if (validation !== null) return Result.err(validation);
  const root = path.resolve(options.root);
  const safeComponents = await validateExistingLocalPathComponents(root);
  const componentFailure = safeComponents.match<BlobStoreCreateError | null>({
    ok: () => null,
    err: (error) => error,
  });
  if (componentFailure !== null) return Result.err(componentFailure);
  const inspected = await Result.tryPromise({
    try: async () => fs.lstat(root),
    catch: classifyLocalFileCause,
  });
  const rootState = inspected.match<
    | {
        readonly kind: "stats";
        readonly stats: Awaited<ReturnType<typeof fs.lstat>>;
      }
    | { readonly kind: "failure"; readonly failure: ClassifiedLocalFileCause }
  >({
    ok: (stats) => ({ kind: "stats", stats }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (rootState.kind === "failure") {
    if (rootState.failure.kind === "panic") signalRetainedBlobPanic(rootState.failure.panic);
    if (rootState.failure.kind === "missing") return Result.ok({ status: "absent" });
    if (rootState.failure.kind === "not-directory") {
      return Result.err(
        new BlobAdapterLayoutInvalid({
          adapter: "local",
          message: "Local blob storage root traverses a non-directory path",
        }),
      );
    }
    return Result.err(
      new BlobAdapterFailure({
        adapter: "local",
        kind: "io",
        operation: "preflight layout",
        message: "Local blob storage preflight failed",
      }),
    );
  }
  if (rootState.stats.isSymbolicLink() || !rootState.stats.isDirectory()) {
    return Result.err(
      new BlobAdapterLayoutInvalid({
        adapter: "local",
        message: "Local blob storage root is not a real directory",
      }),
    );
  }
  const markerExists = await Bun.file(path.join(root, "layout.json")).exists();
  if (!markerExists) {
    const entries = await captureAdapterOperation({
      adapter: "local",
      operation: "preflight unmarked root",
      run: async () => fs.readdir(root),
    });
    return entries.andThen((values) =>
      values.length === 0
        ? Result.ok({ status: "absent" as const })
        : Result.err(
            new BlobAdapterLayoutInvalid({
              adapter: "local",
              message: "Existing local blob storage root is nonempty and has no layout marker",
            }),
          ),
    );
  }
  const markerInspection = await Result.tryPromise({
    try: async () => fs.lstat(path.join(root, "layout.json")),
    catch: classifyLocalFileCause,
  });
  const markerState = markerInspection.match<
    | {
        readonly kind: "stats";
        readonly stats: Awaited<ReturnType<typeof fs.lstat>>;
      }
    | { readonly kind: "failure"; readonly failure: ClassifiedLocalFileCause }
  >({
    ok: (stats) => ({ kind: "stats", stats }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (markerState.kind === "failure") {
    if (markerState.failure.kind === "panic") signalRetainedBlobPanic(markerState.failure.panic);
    return Result.err(
      new BlobAdapterFailure({
        adapter: "local",
        kind: "io",
        operation: "preflight layout marker",
        message: "Local blob storage preflight could not inspect its marker",
      }),
    );
  }
  if (markerState.stats.isSymbolicLink() || !markerState.stats.isFile()) {
    return Result.err(
      new BlobAdapterLayoutInvalid({
        adapter: "local",
        message: "Local blob storage layout marker is not a regular file",
      }),
    );
  }
  const markerRead = await captureAdapterOperation({
    adapter: "local",
    operation: "preflight layout marker",
    run: async () => fs.readFile(path.join(root, "layout.json"), "utf8"),
  });
  const markerContents = markerRead.match<
    { readonly value: string } | { readonly failure: BlobAdapterFailure }
  >({
    ok: (value) => ({ value }),
    err: (failure) => ({ failure }),
  });
  if ("failure" in markerContents) return Result.err(markerContents.failure);
  if (markerContents.value !== LAYOUT_MARKER) {
    return Result.err(
      new BlobAdapterLayoutInvalid({
        adapter: "local",
        message: "Local blob storage layout marker is unsupported",
      }),
    );
  }
  const layout = await validateExistingLocalLayout(root);
  return layout.map(() => ({ status: "ready" as const }));
}

export async function preflightS3BlobStore(
  options: S3BlobStoreOptions,
): Promise<ResultType<BlobStorePreflight, BlobStoreCreateError>> {
  const valid = validateS3Options(options);
  const validation = valid.match<BlobInvalidConfiguration | null>({
    ok: () => null,
    err: (error) => error,
  });
  if (validation !== null) return Result.err(validation);
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/gu, "");
  const key = prefix === "" ? "layout.json" : `${prefix}/layout.json`;
  const client = new Bun.S3Client({
    bucket: options.bucket,
    endpoint: options.endpoint,
    region: options.region,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    virtualHostedStyle: options.forcePathStyle === undefined ? undefined : !options.forcePathStyle,
  });
  const inspected = await captureAdapterOperation({
    adapter: "s3",
    operation: "preflight layout",
    run: async () => {
      const listed = await client.list({
        prefix: prefix === "" ? undefined : `${prefix}/`,
        maxKeys: 1,
      });
      if (!(await client.exists(key))) {
        if ((listed.contents?.length ?? 0) > 0) {
          return "invalid-unmarked" as const;
        }
        return "absent" as const;
      }
      const marker = await client.file(key).text();
      if (marker !== LAYOUT_MARKER) return "invalid-marker" as const;
      return "ready" as const;
    },
  });
  return inspected.andThen((status) =>
    status === "ready" || status === "absent"
      ? Result.ok({ status })
      : Result.err(
          new BlobAdapterLayoutInvalid({
            adapter: "s3",
            message:
              status === "invalid-marker"
                ? "S3 blob storage layout marker is unsupported"
                : "Existing S3 blob storage prefix is nonempty and has no layout marker",
          }),
        ),
  );
}

async function initializeBackend(
  backend: LocalBlobBackend | S3BlobBackend | MemoryBlobBackend,
  logger?: BlobLifecycleLogger,
): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  const initialized = await backend.initialize({ createIfMissing: true });
  return initialized.map(() => new SupervisedBlobStore(backend, logger));
}

function validateLocalOptions(
  options: LocalBlobStoreOptions,
): ResultType<void, BlobInvalidConfiguration> {
  const issues: string[] = [];
  if (typeof options.root !== "string" || options.root.trim() === "") {
    issues.push("root must be a non-empty path");
  } else if (!path.isAbsolute(options.root)) {
    issues.push("root must be an absolute path");
  }
  return issues.length === 0
    ? Result.ok(undefined)
    : Result.err(
        new BlobInvalidConfiguration({
          issues,
          message: "Local blob storage configuration is invalid",
        }),
      );
}

function validateS3Options(
  options: S3BlobStoreOptions,
): ResultType<void, BlobInvalidConfiguration> {
  const issues: string[] = [];
  if (typeof options.bucket !== "string" || options.bucket.trim() === "") {
    issues.push("bucket must not be empty");
  }
  if (typeof options.accessKeyId !== "string" || options.accessKeyId.trim() === "") {
    issues.push("accessKeyId must not be empty");
  }
  if (typeof options.secretAccessKey !== "string" || options.secretAccessKey.trim() === "") {
    issues.push("secretAccessKey must not be empty");
  }
  if (options.prefix?.split("/").includes("..") || options.prefix?.includes("\\")) {
    issues.push("prefix must not contain parent traversal");
  }
  if (options.endpoint !== undefined) {
    const parsed = URL.canParse(options.endpoint);
    if (!parsed || !["http:", "https:"].includes(new URL(options.endpoint).protocol)) {
      issues.push("endpoint must be an absolute HTTP(S) URL");
    }
  }
  return issues.length === 0
    ? Result.ok(undefined)
    : Result.err(
        new BlobInvalidConfiguration({
          issues,
          message: "S3 blob storage configuration is invalid",
        }),
      );
}

async function validateExistingLocalPathComponents(
  target: string,
): Promise<ResultType<void, BlobStoreCreateError>> {
  const parsed = path.parse(target);
  const relative = path.relative(parsed.root, target);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const inspected = await Result.tryPromise({
      try: async () => fs.lstat(current),
      catch: classifyLocalFileCause,
    });
    const state = inspected.match<
      | {
          readonly kind: "stats";
          readonly stats: Awaited<ReturnType<typeof fs.lstat>>;
        }
      | {
          readonly kind: "failure";
          readonly failure: ClassifiedLocalFileCause;
        }
    >({
      ok: (stats) => ({ kind: "stats", stats }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "stats") {
      if (state.stats.isSymbolicLink() || !state.stats.isDirectory()) {
        return Result.err(
          new BlobAdapterLayoutInvalid({
            adapter: "local",
            message: "Local blob storage root traverses an unsafe existing path",
          }),
        );
      }
      continue;
    }
    if (state.failure.kind === "panic") signalRetainedBlobPanic(state.failure.panic);
    if (state.failure.kind === "missing") return Result.ok(undefined);
    if (state.failure.kind === "not-directory") {
      return Result.err(
        new BlobAdapterLayoutInvalid({
          adapter: "local",
          message: "Local blob storage root traverses a non-directory path",
        }),
      );
    }
    return Result.err(
      new BlobAdapterFailure({
        adapter: "local",
        kind: "io",
        operation: "preflight path components",
        message: "Local blob storage preflight could not inspect path components",
      }),
    );
  }
  return Result.ok(undefined);
}

async function validateExistingLocalLayout(
  root: string,
): Promise<ResultType<void, BlobStoreCreateError>> {
  for (const relative of [
    "reservations",
    "temporary",
    "expiry",
    "content",
    "content/durable",
    "content/expires",
  ]) {
    const inspected = await Result.tryPromise({
      try: async () => fs.lstat(path.join(root, relative)),
      catch: classifyLocalFileCause,
    });
    const state = inspected.match<
      | {
          readonly kind: "stats";
          readonly stats: Awaited<ReturnType<typeof fs.lstat>>;
        }
      | {
          readonly kind: "failure";
          readonly failure: ClassifiedLocalFileCause;
        }
    >({
      ok: (stats) => ({ kind: "stats", stats }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "failure") {
      if (state.failure.kind === "panic") signalRetainedBlobPanic(state.failure.panic);
      if (state.failure.kind === "missing" || state.failure.kind === "not-directory") {
        return Result.err(
          new BlobAdapterLayoutInvalid({
            adapter: "local",
            message: `Local blob storage layout directory ${relative} is absent or unsafe`,
          }),
        );
      }
      return Result.err(
        new BlobAdapterFailure({
          adapter: "local",
          kind: "io",
          operation: "preflight layout directories",
          message: "Local blob storage preflight could not inspect its layout",
        }),
      );
    }
    if (state.stats.isSymbolicLink() || !state.stats.isDirectory()) {
      return Result.err(
        new BlobAdapterLayoutInvalid({
          adapter: "local",
          message: `Local blob storage layout directory ${relative} is unsafe`,
        }),
      );
    }
  }
  return Result.ok(undefined);
}
