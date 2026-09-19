import { Result } from "better-result";
import { join } from "node:path";
import {
  cacheScopeKey,
  type CachePatch,
  type CacheScope,
  type NativeCache,
  type ThreadCheckpoint,
} from "@stanley2058/lilac-client";
import { decodeTuiCache, type CacheFile } from "./persistence-codec";
import { readPrivateFile, writePrivateFile, type TuiFileError } from "./private-file";

export function nativeTuiCacheFailure(error: TuiFileError): never {
  throw error;
}

export class DiskNativeCache implements NativeCache {
  private pending: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(
    directory: string,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxThreads = 64,
  ) {
    this.path = join(directory, "cache-v1.json");
  }
  private async load(): Promise<Result<CacheFile, TuiFileError>> {
    const loaded = await readPrivateFile(this.path, this.maxBytes);
    return loaded.map((data) => {
      if (!data) return { version: 1, entries: [] };
      return decodeTuiCache({ version: 1, data }).match({
        ok: (decoded) => decoded.value,
        err: () => ({ version: 1, entries: [] }),
      });
    });
  }
  private async readFile(): Promise<CacheFile> {
    const decision = (await this.load()).match<{ value: CacheFile } | { error: TuiFileError }>({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in decision) nativeTuiCacheFailure(decision.error);
    return decision.value;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation);
    this.pending = Result.tryPromise({ try: () => task, catch: () => undefined }).then(() => {});
    return task;
  }
  async read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined> {
    return this.enqueue(async () => {
      const file = await this.readFile();
      const entry = file.entries.find((row) => row.key === this.key(scope, threadId));
      if (!entry) return undefined;
      return { checkpoint: entry.checkpoint, slots: entry.slots };
    });
  }
  async commit(scope: CacheScope, threadId: string, patch: CachePatch): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readFile();
      const key = this.key(scope, threadId);
      const old = file.entries.find((row) => row.key === key);
      if (!old && !patch.replace) return;
      const slots = new Map(
        (patch.replace ? [] : (old?.slots ?? [])).map((slot) => [slot.slot.slotId, slot]),
      );
      for (const id of patch.remove) slots.delete(id);
      for (const slot of patch.put) slots.set(slot.slot.slotId, slot);
      file.entries = file.entries.filter((row) => row.key !== key);
      file.entries.push({
        key,
        scope: cacheScopeKey(scope),
        updatedAt: Date.now(),
        checkpoint: patch.checkpoint,
        slots: [...slots.values()],
      });
      file.entries = file.entries.slice(-Math.min(this.maxThreads, 64));
      let data = JSON.stringify(file);
      while (Buffer.byteLength(data) > this.maxBytes && file.entries.length) {
        file.entries.shift();
        data = JSON.stringify(file);
      }
      await this.save(data);
    });
  }
  async remove(scope: CacheScope, threadId: string): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readFile();
      file.entries = file.entries.filter((row) => row.key !== this.key(scope, threadId));
      await this.save(JSON.stringify(file));
    });
  }
  async purge(scope: CacheScope): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.readFile();
      file.entries = file.entries.filter((row) => row.scope !== cacheScopeKey(scope));
      await this.save(JSON.stringify(file));
    });
  }
  private async save(data: string): Promise<void> {
    const failure = (await writePrivateFile(this.path, data)).match({
      ok: () => undefined,
      err: (error) => error,
    });
    if (failure) nativeTuiCacheFailure(failure);
  }
  private key(scope: CacheScope, threadId: string): string {
    return JSON.stringify([cacheScopeKey(scope), threadId]);
  }
}
