import {
  createMemoryBlobStore,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";

import type { WorkflowArtifactReference } from "../../src/workflow/workflow-domain";

export async function createWorkflowTestBlobStore(): Promise<BlobStore> {
  const created = await createMemoryBlobStore();
  return created.match({
    ok: (store) => store,
    err: (error) => {
      throw error;
    },
  });
}

export function workflowArtifactReferenceForTest(
  artifactId: string,
  seed = artifactId,
): WorkflowArtifactReference {
  const sha256 = Bun.CryptoHasher.hash("sha256", seed, "hex");
  const blobRef: BlobRefV1 = {
    version: 1,
    objectId: `b1_${sha256.slice(0, 32)}`,
    sha256,
    byteLength: 0,
  };
  return { artifactId, blobRef };
}

export function workflowSourceArtifactReferenceForTest(seed: string): WorkflowArtifactReference {
  const sourceHash = Bun.CryptoHasher.hash("sha256", seed, "hex");
  return workflowArtifactReferenceForTest(`workflow-source:${sourceHash}`, seed);
}

export function workflowValueArtifactReferenceForTest(seed: string): WorkflowArtifactReference {
  const valueHash = Bun.CryptoHasher.hash("sha256", seed, "hex");
  return workflowArtifactReferenceForTest(`workflow-value:${valueHash}`, seed);
}
