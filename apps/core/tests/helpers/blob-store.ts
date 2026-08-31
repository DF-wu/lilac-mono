import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";

let sharedBlobStore: Promise<BlobStore> | undefined;

export function getTestBlobStore(): Promise<BlobStore> {
  sharedBlobStore ??= createMemoryBlobStore().then((created) =>
    created.match({
      ok: (store) => store,
      err: (error) => {
        throw error;
      },
    }),
  );
  return sharedBlobStore;
}
