import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createBlobBackedToolResultArtifactStore,
  TOOL_RESULT_URI_PREFIX,
  type CreatedToolResultArtifact,
  type ToolResultArtifactStore,
  type ToolResultArtifactStoreOptions,
} from "@stanley2058/lilac-tool-results";

export * from "@stanley2058/lilac-tool-results/tool-result-artifact-store";

export const CORE_TOOL_RESULT_RESOURCE_URI_PREFIX = "resource://t1_";

const coreToolResultResourceUriPattern = /^resource:\/\/t1_([0-9a-f]{32})$/u;

function artifactIdFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatCoreToolResultResourceUri(artifactId: string): string {
  return `${CORE_TOOL_RESULT_RESOURCE_URI_PREFIX}${artifactId.replaceAll("-", "")}`;
}

export function coreToolResultArtifactIdFromUri(uri: string): string | null {
  const resourceMatch = coreToolResultResourceUriPattern.exec(uri);
  if (resourceMatch?.[1]) return artifactIdFromHex(resourceMatch[1]);
  if (!uri.startsWith(TOOL_RESULT_URI_PREFIX)) return null;
  const artifactId = uri.slice(TOOL_RESULT_URI_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(artifactId)
    ? artifactId
    : null;
}

export function isCoreToolResultResourceUri(uri: string): boolean {
  return (
    uri.startsWith(CORE_TOOL_RESULT_RESOURCE_URI_PREFIX) || uri.startsWith(TOOL_RESULT_URI_PREFIX)
  );
}

export function legacyToolResultUri(uri: string): string {
  const artifactId = coreToolResultArtifactIdFromUri(uri);
  return artifactId === null ? uri : `${TOOL_RESULT_URI_PREFIX}${artifactId}`;
}

function projectCreatedArtifact(artifact: CreatedToolResultArtifact): CreatedToolResultArtifact {
  return {
    ...artifact,
    uri: formatCoreToolResultResourceUri(artifact.id),
  };
}

function adaptCoreToolResultArtifactStore(store: ToolResultArtifactStore): ToolResultArtifactStore {
  return {
    rootDir: store.rootDir,
    init: () => store.init(),
    create: async (params) => (await store.create(params)).map(projectCreatedArtifact),
    createFromFile: async (params) =>
      (await store.createFromFile(params)).map(projectCreatedArtifact),
    createFromStream: async (params) =>
      (await store.createFromStream(params)).map(projectCreatedArtifact),
    read: (uri, scopeId, options) => store.read(legacyToolResultUri(uri), scopeId, options),
    readWindow: (uri, scopeId, options) =>
      store.readWindow(legacyToolResultUri(uri), scopeId, options),
    maintain: (now) => store.maintain(now),
  };
}

export function createToolResultArtifactStore(
  rootDir: string,
  blobStore: BlobStore,
  options: ToolResultArtifactStoreOptions = {},
): ToolResultArtifactStore {
  return adaptCoreToolResultArtifactStore(
    createBlobBackedToolResultArtifactStore(rootDir, blobStore, options),
  );
}
