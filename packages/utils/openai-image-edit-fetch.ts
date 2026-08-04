type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function requestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

function blobFilename(blob: Blob): string | undefined {
  const name = Reflect.get(blob, "name");
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function filenameFor(key: string, blob: Blob): string {
  const basename = key.replace(/\[\]$/u, "") || "image";
  const extension = IMAGE_EXTENSIONS[blob.type] ?? "bin";
  return `${basename}.${extension}`;
}

/**
 * Bun serializes unnamed Blobs with filename="", which OpenAI rejects for image edits.
 * Add a filename without changing multipart requests that already provide one.
 */
export function withOpenAIImageEditFilenamesFetch(
  fetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const wrappedFetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    if (
      !requestUrl(input).pathname.endsWith("/images/edits") ||
      !(init?.body instanceof FormData)
    ) {
      return fetchFn(input, init);
    }

    const entries = [...init.body.entries()];
    if (!entries.some(([, value]) => typeof value !== "string" && !blobFilename(value))) {
      return fetchFn(input, init);
    }

    const body = new FormData();
    for (const [key, value] of entries) {
      if (typeof value === "string") {
        body.append(key, value);
      } else {
        body.append(key, value, blobFilename(value) ?? filenameFor(key, value));
      }
    }

    return fetchFn(input, { ...init, body });
  };

  return Object.assign(wrappedFetch, {
    preconnect:
      typeof fetchFn.preconnect === "function" ? fetchFn.preconnect.bind(fetchFn) : () => {},
  });
}
