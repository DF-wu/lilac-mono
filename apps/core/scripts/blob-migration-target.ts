import path from "node:path";
import fs from "node:fs/promises";

import {
  createLocalBlobStore,
  createS3BlobStore,
  materializeBlobRead,
  preflightLocalBlobStore,
  preflightS3BlobStore,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobRefV1,
  type BlobStore,
  type BlobStoreCreateError,
  type BlobStorePreflight,
  type S3BlobStoreOptions,
  type BlobUploadStartError,
  type BlobWriteError,
} from "@stanley2058/lilac-blob-storage";
import {
  decodeCoreConfigYaml,
  parseCoreConfigResult,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { preserveToolPanic } from "../src/tools/tool-result-adapters";

export type BlobMigrationTarget =
  | {
      readonly kind: "local";
      readonly root: string;
    }
  | {
      readonly kind: "s3";
      readonly bucket: string;
      readonly prefix: string;
      readonly endpoint: string;
      readonly region: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
      readonly forcePathStyle: boolean;
    };

export type LoadedBlobMigrationTarget = {
  readonly coreConfig: CoreConfig;
  readonly target: BlobMigrationTarget;
};

export class BlobMigrationConfigReadFailed extends TaggedError("BlobMigrationConfigReadFailed")<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class BlobMigrationConfigInvalid extends TaggedError("BlobMigrationConfigInvalid")<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class BlobMigrationCredentialMissing extends TaggedError("BlobMigrationCredentialMissing")<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export class BlobMigrationLocalCapacityInspectFailed extends TaggedError(
  "BlobMigrationLocalCapacityInspectFailed",
)<{
  readonly message: string;
}> {}

export type BlobMigrationTargetConfigError =
  | BlobMigrationConfigReadFailed
  | BlobMigrationConfigInvalid
  | BlobMigrationCredentialMissing;

export type BlobMigrationUploadError =
  | BlobUploadStartError
  | BlobWriteError
  | BlobReadError
  | BlobReadTerminalError;

export type BlobMigrationTargetDependencies = {
  readonly readConfigText?: (configPath: string) => Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

type CapturedConfigReadFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary" };
type ConfigReadFailureSettlement = () => CapturedConfigReadFailure;

type CapturedLocalStatfsFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "missing" }
  | { readonly kind: "ordinary" };
type LocalStatfsFailureSettlement = () => CapturedLocalStatfsFailure;

export type BlobMigrationTargetPreflight = {
  readonly adapterKind: "local" | "s3";
  readonly status: BlobStorePreflight["status"];
  readonly availableLocalBytes?: number;
};

export type BlobMigrationTargetPreflightError =
  | BlobStoreCreateError
  | BlobMigrationLocalCapacityInspectFailed;

function configInvalid(configPath: string, message: string): BlobMigrationConfigInvalid {
  return new BlobMigrationConfigInvalid({ configPath, message });
}

function captureConfigReadFailure(cause: unknown): ConfigReadFailureSettlement {
  return () => {
    const inspected = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspected.match({ ok: (value) => value, err: () => undefined });
    return panic === undefined ? { kind: "ordinary" } : { kind: "panic", panic };
  };
}

function captureLocalStatfsFailure(cause: unknown): LocalStatfsFailureSettlement {
  return () => {
    const inspectedPanic = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspectedPanic.match({ ok: (value) => value, err: () => undefined });
    if (panic !== undefined) return { kind: "panic", panic };

    const inspectedMissingPath = Result.try({
      try: (): boolean =>
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR"),
      catch: () => false,
    });
    const missingPath = inspectedMissingPath.match({ ok: (value) => value, err: () => false });
    return missingPath ? { kind: "missing" } : { kind: "ordinary" };
  };
}

function decodeCoreConfig(raw: unknown): ReturnType<typeof parseCoreConfigResult> {
  return parseCoreConfigResult(raw);
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): ResultType<string, BlobMigrationCredentialMissing> {
  const value = environment[name];
  if (value !== undefined && value.length > 0) return Result.ok(value);
  return Result.err(
    new BlobMigrationCredentialMissing({
      environmentVariable: name,
      message: `Blob storage credential environment variable ${name} is not set`,
    }),
  );
}

function resolveBlobMigrationTarget(
  coreConfig: CoreConfig,
  dataDir: string,
  environment: Readonly<Record<string, string | undefined>>,
): ResultType<BlobMigrationTarget, BlobMigrationCredentialMissing> {
  const configured = coreConfig.blobStorage;
  if (configured.kind === "local") {
    return Result.ok({
      kind: "local",
      root: configured.root ?? path.resolve(dataDir, "blobs"),
    });
  }

  return Result.gen(function* () {
    const accessKeyId = yield* requiredEnvironmentValue(environment, configured.accessKeyIdEnv);
    const secretAccessKey = yield* requiredEnvironmentValue(
      environment,
      configured.secretAccessKeyEnv,
    );
    const sessionToken = configured.sessionTokenEnv
      ? yield* requiredEnvironmentValue(environment, configured.sessionTokenEnv)
      : undefined;
    return Result.ok({
      kind: "s3" as const,
      bucket: configured.bucket,
      prefix: configured.prefix,
      endpoint: configured.endpoint,
      region: configured.region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      forcePathStyle: configured.forcePathStyle,
    });
  });
}

export async function loadBlobMigrationTargetConfig(
  input: {
    readonly configPath: string;
    readonly dataDir: string;
  },
  dependencies: BlobMigrationTargetDependencies = {},
): Promise<ResultType<LoadedBlobMigrationTarget, BlobMigrationTargetConfigError>> {
  const readConfigText =
    dependencies.readConfigText ?? ((configPath: string) => Bun.file(configPath).text());
  const environment = dependencies.environment ?? process.env;
  const captured = await Result.tryPromise<string, ConfigReadFailureSettlement>({
    try: () => readConfigText(input.configPath),
    catch: captureConfigReadFailure,
  });
  const settled = captured.mapError((settle) => settle());
  const source = settled.match<() => ResultType<string, BlobMigrationConfigReadFailed>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") preserveToolPanic(failure.panic);
      return Result.err(
        new BlobMigrationConfigReadFailed({
          configPath: input.configPath,
          message: `Failed to read Core config from ${input.configPath}`,
        }),
      );
    },
  })();

  return source
    .andThen((text) =>
      decodeCoreConfigYaml(text)
        .andThen(decodeCoreConfig)
        .mapError((error) => configInvalid(input.configPath, error.message)),
    )
    .andThen((coreConfig) =>
      resolveBlobMigrationTarget(coreConfig, input.dataDir, environment).map((target) => ({
        coreConfig,
        target,
      })),
    );
}

function s3StoreOptions(
  target: Extract<BlobMigrationTarget, { readonly kind: "s3" }>,
): S3BlobStoreOptions {
  return {
    bucket: target.bucket,
    prefix: target.prefix,
    endpoint: target.endpoint,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    sessionToken: target.sessionToken,
    forcePathStyle: target.forcePathStyle,
  };
}

async function availableBytesAtNearestExistingPath(
  targetRoot: string,
): Promise<ResultType<number, BlobMigrationLocalCapacityInspectFailed>> {
  let candidate = path.resolve(targetRoot);
  while (true) {
    const inspected = await Result.tryPromise<
      Awaited<ReturnType<typeof fs.statfs>>,
      LocalStatfsFailureSettlement
    >({
      try: () => fs.statfs(candidate, { bigint: true }),
      catch: captureLocalStatfsFailure,
    });
    const outcome = inspected
      .mapError((settle) => settle())
      .match<
        | {
            readonly kind: "stats";
            readonly stats: Awaited<ReturnType<typeof fs.statfs>>;
          }
        | { readonly kind: "failure"; readonly failure: CapturedLocalStatfsFailure }
      >({
        ok: (stats) => ({ kind: "stats", stats }),
        err: (failure) => ({ kind: "failure", failure }),
      });
    if (outcome.kind === "stats") {
      const available = BigInt(outcome.stats.bavail) * BigInt(outcome.stats.bsize);
      const maximum = BigInt(Number.MAX_SAFE_INTEGER);
      return Result.ok(Number(available > maximum ? maximum : available));
    }
    if (outcome.failure.kind === "panic") preserveToolPanic(outcome.failure.panic);
    const parent = path.dirname(candidate);
    if (outcome.failure.kind === "missing" && parent !== candidate) {
      candidate = parent;
      continue;
    }
    return Result.err(
      new BlobMigrationLocalCapacityInspectFailed({
        message: "Failed to inspect available local blob storage space",
      }),
    );
  }
}

export async function preflightBlobMigrationTarget(
  target: BlobMigrationTarget,
): Promise<ResultType<BlobMigrationTargetPreflight, BlobMigrationTargetPreflightError>> {
  if (target.kind === "s3") {
    return (await preflightS3BlobStore(s3StoreOptions(target))).map((preflight) => ({
      adapterKind: "s3" as const,
      status: preflight.status,
    }));
  }
  return Result.gen(async function* () {
    const preflight = yield* Result.await(preflightLocalBlobStore({ root: target.root }));
    const availableLocalBytes = yield* Result.await(
      availableBytesAtNearestExistingPath(target.root),
    );
    return Result.ok({
      adapterKind: "local" as const,
      status: preflight.status,
      availableLocalBytes,
    });
  });
}

export function createBlobMigrationTargetStore(
  target: BlobMigrationTarget,
): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  if (target.kind === "local") return createLocalBlobStore({ root: target.root });
  return createS3BlobStore(s3StoreOptions(target));
}

export async function uploadVerifiedDurableBlob(
  store: BlobStore,
  input: {
    readonly bytes: Uint8Array;
    readonly expectedSha256?: string;
  },
): Promise<ResultType<BlobRefV1, BlobMigrationUploadError>> {
  return Result.gen(async function* () {
    const upload = yield* Result.await(
      store.startUpload({
        source: input.bytes,
        retention: { kind: "durable" },
        expectedSha256: input.expectedSha256,
        expectedByteLength: input.bytes.byteLength,
      }),
    );
    const ref = yield* Result.await(upload.completion);
    const read = yield* Result.await(store.open(ref));
    yield* Result.await(materializeBlobRead(read));
    return Result.ok(ref);
  });
}
