import { expect, test } from "bun:test";
import { BinaryRelay, connectBinaryWebSocket } from "./binary-relay";

test("binary relay preserves the upstream greeting and serializes input", async () => {
  const writes: number[] = [];
  const sends: number[] = [];
  const released = Promise.withResolvers<void>();
  let closes = 0;
  const relay = new BinaryRelay(
    async (data) => {
      if (data[0] === 1) await released.promise;
      writes.push(data[0]!);
    },
    () => closes++,
  );
  relay.push(new Uint8Array([3]));
  relay.attach({
    send: (data) => {
      sends.push(data[0]!);
      return 1;
    },
    close() {},
  });
  expect(sends).toEqual([3]);
  const first = relay.receive(new Uint8Array([1]));
  const second = relay.receive(new Uint8Array([2]));
  released.resolve();
  await Promise.all([first, second]);
  expect(writes).toEqual([1, 2]);
  relay.close();
  relay.close();
  expect(closes).toBe(1);
});

test("binary relay closes on revoked access, text frames, and oversized buffered input", () => {
  for (const invalid of ["text", new Uint8Array(2 * 1024 * 1024 + 1)]) {
    let closed = false;
    const relay = new BinaryRelay(
      async () => {},
      () => {
        closed = true;
      },
    );
    relay.receive(invalid);
    expect(closed).toBe(true);
  }
  let allowed = true;
  let closed = false;
  const relay = new BinaryRelay(
    async () => {},
    () => {
      closed = true;
    },
    () => allowed,
  );
  allowed = false;
  relay.check();
  expect(closed).toBe(true);
});

test("WebSocket relay preserves binary bytes and closes the upstream", async () => {
  const closed = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      expect(request.headers.get("authorization")).toBe("Bearer relay-test");
      if (server.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(new Uint8Array([82, 70, 66]));
      },
      message(socket, bytes) {
        socket.send(bytes);
      },
      close() {
        closed.resolve();
      },
    },
  });
  try {
    const relay = (
      await connectBinaryWebSocket(
        server.url.href.replace("http:", "ws:"),
        { authorization: "Bearer relay-test" },
        new AbortController().signal,
        () => true,
      )
    ).unwrap();
    const messages: number[][] = [];
    const echoed = Promise.withResolvers<void>();
    relay.attach({
      send(bytes) {
        messages.push([...bytes]);
        if (messages.length === 2) echoed.resolve();
        return bytes.length;
      },
      close() {},
    });
    await relay.receive(new Uint8Array([1, 2, 3]));
    await echoed.promise;
    expect(messages).toEqual([
      [82, 70, 66],
      [1, 2, 3],
    ]);
    relay.close();
    await closed.promise;
  } finally {
    await server.stop(true);
  }
});
