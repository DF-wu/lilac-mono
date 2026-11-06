import { Result, TaggedError } from "better-result";

export class BinaryRelayError extends TaggedError("BinaryRelayError")<{ message: string }> {}
const limit = 2 * 1024 * 1024;
type Peer = { send(data: Uint8Array): number; close(code?: number, reason?: string): void };

export class BinaryRelay {
  private peer?: Peer;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private writingBytes = 0;
  private writing = Promise.resolve();
  private ended = false;
  private readonly closeListeners: (() => void)[] = [];

  constructor(
    private readonly write: (data: Uint8Array) => Promise<void>,
    private readonly disconnect: () => void,
    private readonly allowed: () => boolean = () => true,
  ) {}

  attach(peer: Peer) {
    if (this.ended) {
      peer.close(1011, "Viewer unavailable");
      return;
    }
    this.peer = peer;
    for (const data of this.pending) this.push(data);
    this.pending = [];
    this.pendingBytes = 0;
  }

  check() {
    if (!this.allowed()) this.close();
  }

  whenClosed(listener: () => void) {
    if (this.ended) {
      listener();
      return;
    }
    this.closeListeners.push(listener);
  }

  push(data: Uint8Array) {
    if (this.ended) return;
    if (!this.allowed() || data.byteLength > limit) {
      this.close();
      return;
    }
    if (this.peer) {
      if (this.peer.send(data) === 0) this.close();
      return;
    }
    this.pendingBytes += data.byteLength;
    if (this.pendingBytes > limit) {
      this.close();
      return;
    }
    this.pending.push(data);
  }

  receive(data: string | Uint8Array) {
    if (this.ended) return;
    if (typeof data === "string" || !this.allowed()) {
      this.close();
      return;
    }
    this.writingBytes += data.byteLength;
    if (this.writingBytes > limit) {
      this.close();
      return;
    }
    this.writing = this.writing.then(() => this.writeChunk(data));
    return this.writing;
  }

  private async writeChunk(data: Uint8Array) {
    if (this.ended) return;
    const result = await Result.tryPromise({
      try: () => this.write(data),
      catch: () => new BinaryRelayError({ message: "Viewer transport failed" }),
    });
    this.writingBytes -= data.byteLength;
    result.match({ ok: () => {}, err: () => this.close() });
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    this.pending = [];
    this.pendingBytes = 0;
    for (const listener of this.closeListeners.splice(0)) listener();
    this.disconnect();
    this.peer?.close(1000, "Viewer ended");
  }
}

export async function connectBinaryWebSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  allowed: () => boolean,
): Promise<Result<BinaryRelay, BinaryRelayError>> {
  const created = Result.try({
    try: () => {
      const Socket = globalThis.WebSocket as typeof globalThis.WebSocket & {
        new (url: string, options: Bun.WebSocketOptions): WebSocket;
      };
      return new Socket(url, { headers: { ...headers } });
    },
    catch: () => new BinaryRelayError({ message: "Viewer transport unavailable" }),
  });
  const socket = created.match({ ok: (value) => value, err: () => null });
  if (!socket) return Result.err(new BinaryRelayError({ message: "Viewer transport unavailable" }));
  socket.binaryType = "arraybuffer";
  const relay = new BinaryRelay(
    async (data) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + data.byteLength > limit) {
        relay.close();
        return;
      }
      socket.send(new Uint8Array(data));
    },
    () => socket.close(),
    allowed,
  );
  socket.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      relay.close();
      return;
    }
    relay.push(new Uint8Array(event.data));
  });
  socket.addEventListener("close", () => relay.close());
  socket.addEventListener("error", () => relay.close());
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("close", abort);
      socket.removeEventListener("error", abort);
      if (!ready) relay.close();
      resolve(
        ready
          ? Result.ok(relay)
          : Result.err(new BinaryRelayError({ message: "Viewer connection failed" })),
      );
    };
    const open = () => finish(true);
    const abort = () => finish(false);
    const timer = setTimeout(abort, 5000);
    socket.addEventListener("open", open);
    socket.addEventListener("close", abort);
    socket.addEventListener("error", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
