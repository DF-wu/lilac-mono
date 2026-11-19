import { Result } from "better-result";
import type { ResourceAccess } from "../../resource/service";

// Deadline includes opening, streaming and terminal integrity verification.
export async function readDiscordMirrorAttachment(
  access: ResourceAccess,
  uri: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (signal.aborted) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancel!: () => void;
  const canceled = new Promise<null>((resolve) => {
    cancel = () => resolve(null);
  });
  const onAbort = () => {
    cancel();
    if (reader) void Result.tryPromise({ try: () => reader!.cancel(), catch: () => null });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const captured = await Result.tryPromise({
    try: async () => {
      async function open() {
        const opened = await access.open(uri, { expected: "any", maxBytes, signal });
        const read = opened.match({ ok: (value) => value, err: () => null });
        if (read && signal.aborted) {
          void Result.tryPromise({ try: () => read.stream.cancel(), catch: () => null });
          return null;
        }
        return read;
      }
      const read = await Promise.race([open(), canceled]);
      if (!read) return null;
      if (signal.aborted) {
        void Result.tryPromise({ try: () => read.stream.cancel(), catch: () => null });
        return null;
      }
      reader = read.stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (!signal.aborted) {
        const chunk = await Promise.race([reader.read(), canceled]);
        if (!chunk) return null;
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          const owned = reader;
          void Result.tryPromise({ try: () => owned.cancel(), catch: () => null });
          return null;
        }
        chunks.push(chunk.value);
      }
      const complete = await Promise.race([read.completion, canceled]);
      const verified = complete?.match({ ok: () => true, err: () => false });
      if (!verified || signal.aborted) return null;
      return new Uint8Array(Buffer.concat(chunks));
    },
    catch: () => null,
  });
  signal.removeEventListener("abort", onAbort);
  const owned = reader;
  if (owned) {
    void Result.tryPromise({ try: () => owned.cancel(), catch: () => null });
    Result.try({ try: () => owned.releaseLock(), catch: () => null });
  }
  return captured.match({ ok: (value) => value, err: () => null });
}
