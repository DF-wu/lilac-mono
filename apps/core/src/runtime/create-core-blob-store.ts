import {
  createLocalBlobStore,
  createS3BlobStore,
  type BlobStore,
  type BlobStoreCreateError,
} from "@stanley2058/lilac-blob-storage";
import type { BlobStorageConfig } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import path from "node:path";

export class CoreBlobStorageCredentialMissing extends TaggedError(
  "CoreBlobStorageCredentialMissing",
)<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export type CoreBlobStoreCreateError = BlobStoreCreateError | CoreBlobStorageCredentialMissing;

export type CoreBlobStoreEnvironment = Readonly<Record<string, string | undefined>>;

export async function createCoreBlobStore(input: {
  readonly config: BlobStorageConfig;
  readonly dataDir: string;
  readonly environment?: CoreBlobStoreEnvironment;
}): Promise<ResultType<BlobStore, CoreBlobStoreCreateError>> {
  if (input.config.kind === "local") {
    return createLocalBlobStore({
      root: input.config.root ?? path.resolve(input.dataDir, "blobs"),
    });
  }

  const environment = input.environment ?? process.env;
  const accessKeyId = environment[input.config.accessKeyIdEnv];
  if (!accessKeyId) {
    return Result.err(
      new CoreBlobStorageCredentialMissing({
        environmentVariable: input.config.accessKeyIdEnv,
        message: `Blob storage credential environment variable is missing: ${input.config.accessKeyIdEnv}`,
      }),
    );
  }
  const secretAccessKey = environment[input.config.secretAccessKeyEnv];
  if (!secretAccessKey) {
    return Result.err(
      new CoreBlobStorageCredentialMissing({
        environmentVariable: input.config.secretAccessKeyEnv,
        message: `Blob storage credential environment variable is missing: ${input.config.secretAccessKeyEnv}`,
      }),
    );
  }
  const sessionToken = input.config.sessionTokenEnv
    ? environment[input.config.sessionTokenEnv]
    : undefined;
  if (input.config.sessionTokenEnv && !sessionToken) {
    return Result.err(
      new CoreBlobStorageCredentialMissing({
        environmentVariable: input.config.sessionTokenEnv,
        message: `Blob storage credential environment variable is missing: ${input.config.sessionTokenEnv}`,
      }),
    );
  }

  return createS3BlobStore({
    bucket: input.config.bucket,
    prefix: input.config.prefix,
    endpoint: input.config.endpoint,
    region: input.config.region,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    forcePathStyle: input.config.forcePathStyle,
  });
}
