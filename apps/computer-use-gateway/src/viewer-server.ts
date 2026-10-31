import type { BinaryRelay } from "@stanley2058/lilac-utils/binary-relay";
import { decodeSessionHeader, decodeViewerGeneration } from "./contracts";
import type { ComputerLifecycle } from "./lifecycle";
import { createDockerViewerRelay } from "./viewer-relay";
import { authorized, createGatewayHandler } from "./server";

type ViewerData = { relay: BinaryRelay; expiry?: ReturnType<typeof setInterval> };

export function createComputerGatewayServer(lifecycle: ComputerLifecycle, bearer: string) {
  const handler = createGatewayHandler(lifecycle, bearer);
  const relays = new Set<BinaryRelay>();
  return {
    async fetch(request: Request, server: Bun.Server<ViewerData>): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== "/viewer/socket") return handler(request);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!authorized(request, bearer)) return new Response("Unauthorized", { status: 401 });
      const session = decodeSessionHeader(request.headers.get("x-lilac-session-hash"));
      const generation = decodeViewerGeneration(url.searchParams.get("generation"));
      if (!session || !generation) return new Response("Invalid viewer request", { status: 400 });
      if (relays.size >= 64) return new Response("Viewer capacity exceeded", { status: 503 });
      const container = lifecycle
        .viewerContainer(session, generation)
        .match({ ok: (value) => value, err: () => null });
      if (!container) return new Response("Desktop unavailable", { status: 404 });
      const allowed = () =>
        lifecycle
          .viewerContainer(session, generation)
          .match({ ok: (id) => id === container, err: () => false });
      const relay = createDockerViewerRelay(container, allowed).match({
        ok: (value) => value,
        err: () => null,
      });
      if (!relay) return new Response("Desktop unavailable", { status: 503 });
      relays.add(relay);
      relay.whenClosed(() => relays.delete(relay));
      if (server.upgrade(request, { data: { relay } })) return;
      relay.close();
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: 2 * 1024 * 1024,
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket: Bun.ServerWebSocket<ViewerData>) {
        socket.data.relay.attach(socket);
        socket.data.expiry = setInterval(() => socket.data.relay.check(), 1000);
      },
      message(socket: Bun.ServerWebSocket<ViewerData>, message: string | Buffer) {
        socket.data.relay.receive(message);
      },
      close(socket: Bun.ServerWebSocket<ViewerData>) {
        clearInterval(socket.data.expiry);
        socket.data.relay.close();
      },
    },
    close() {
      for (const relay of relays) relay.close();
    },
  };
}
