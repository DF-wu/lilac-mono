import { Result } from "better-result";
import { BinaryRelay } from "@stanley2058/lilac-utils/binary-relay";
import { failure, type GatewayFailure } from "./contracts";

// Docker exec reaches runner loopback even when Docker bridge isolation blocks gateway-to-runner IP traffic.
const tunnel = `import os,select,socket
with socket.create_connection(("127.0.0.1",5901),timeout=5) as conn:
    conn.settimeout(None)
    while True:
        ready,_,_=select.select([0,conn],[],[])
        if 0 in ready:
            data=os.read(0,65536)
            if not data: break
            conn.sendall(data)
        if conn in ready:
            data=conn.recv(65536)
            if not data: break
            view=memoryview(data)
            while view:
                view=view[os.write(1,view):]
`;

export function createDockerViewerRelay(
  containerId: string,
  allowed: () => boolean,
): Result<BinaryRelay, GatewayFailure> {
  const started = Result.try({
    try: () =>
      Bun.spawn(
        [
          "docker",
          "exec",
          "-i",
          "--user",
          "cua",
          containerId,
          "/opt/venv/bin/python",
          "-u",
          "-c",
          tunnel,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        },
      ),
    catch: () => failure("unavailable", "Cannot connect to desktop"),
  });
  if (started.isErr()) return started;
  const child = started.value;
  const relay = new BinaryRelay(
    async (data) => {
      child.stdin.write(data);
      await child.stdin.flush();
    },
    () => {
      child.kill();
    },
    allowed,
  );
  void pump(child.stdout, relay);
  void child.exited.then(() => relay.close());
  return Result.ok(relay);
}

async function pump(stream: ReadableStream<Uint8Array>, relay: BinaryRelay) {
  const result = await Result.tryPromise({
    try: async () => {
      const reader = stream.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        relay.push(chunk.value);
      }
    },
    catch: () => failure("unavailable", "Desktop stream ended"),
  });
  result.match({ ok: () => relay.close(), err: () => relay.close() });
}
