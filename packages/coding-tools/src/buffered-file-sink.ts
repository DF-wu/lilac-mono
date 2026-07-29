import fs, { type FileHandle } from "node:fs/promises";

const DEFAULT_BLOCK_BYTES = 64 * 1024;

/**
 * Concurrent writes are serialized in call order. Termination stops admission
 * synchronously and closes the handle only after every accepted write settles.
 */
export class BufferedFileSink {
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private acceptingWrites = true;
  private operationTail = Promise.resolve();
  private terminalPromise: Promise<void> | undefined;
  private handleClosePromise: Promise<void> | undefined;

  private constructor(
    private readonly handle: FileHandle,
    private readonly blockBytes: number,
  ) {}

  static async open(
    filePath: string,
    options?: { flags?: "w" | "wx"; mode?: number; blockBytes?: number },
  ): Promise<BufferedFileSink> {
    const mode = options?.mode ?? 0o600;
    const blockBytes = options?.blockBytes ?? DEFAULT_BLOCK_BYTES;
    if (!Number.isFinite(blockBytes) || blockBytes < 1) {
      throw new RangeError("Buffered file sink blockBytes must be a positive finite number");
    }
    const handle = await fs.open(filePath, options?.flags ?? "w", mode);
    try {
      await handle.chmod(mode);
      return new BufferedFileSink(handle, Math.floor(blockBytes));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async write(chunk: Uint8Array | string): Promise<void> {
    if (!this.acceptingWrites) throw new Error("Cannot write to a closed buffered file sink");
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (buffer.byteLength === 0) return;

    const operation = this.operationTail.then(async () => {
      this.pending.push(buffer);
      this.pendingBytes += buffer.byteLength;
      while (this.pendingBytes >= this.blockBytes) {
        await this.writeBytes(this.take(this.blockBytes));
      }
    });
    // Continue the queue after a failed write without changing that write's returned rejection.
    this.operationTail = operation.catch(() => undefined);
    await operation;
  }

  close(): Promise<void> {
    if (this.terminalPromise) return this.terminalPromise;
    this.acceptingWrites = false;
    const operation = this.operationTail.then(async () => {
      try {
        if (this.pendingBytes > 0) await this.writeBytes(this.take(this.pendingBytes));
      } finally {
        await this.closeHandle();
      }
    });
    this.terminalPromise = operation;
    this.operationTail = operation.catch(() => undefined);
    return operation;
  }

  async abort(): Promise<void> {
    this.acceptingWrites = false;
    if (this.terminalPromise) {
      await this.terminalPromise.catch(() => undefined);
      return;
    }

    const operation = this.operationTail.then(async () => {
      this.pending.length = 0;
      this.pendingBytes = 0;
      await this.closeHandle().catch(() => undefined);
    });
    this.terminalPromise = operation;
    this.operationTail = operation;
    await operation;
  }

  private take(byteLength: number): Buffer {
    const output = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const chunk = this.pending[0];
      if (!chunk) throw new Error("Buffered file sink accounting mismatch");
      const consumed = Math.min(chunk.byteLength, byteLength - offset);
      chunk.copy(output, offset, 0, consumed);
      offset += consumed;
      this.pendingBytes -= consumed;
      if (consumed === chunk.byteLength) this.pending.shift();
      else this.pending[0] = chunk.subarray(consumed);
    }
    return output;
  }

  private async writeBytes(buffer: Buffer): Promise<void> {
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await this.handle.write(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesWritten === 0) throw new Error("Buffered file sink made no write progress");
      offset += bytesWritten;
    }
  }

  private closeHandle(): Promise<void> {
    this.handleClosePromise ??= this.handle.close();
    return this.handleClosePromise;
  }
}
