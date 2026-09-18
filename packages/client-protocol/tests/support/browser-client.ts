import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { nativeSyncContract } from "../../src/rpc.ts";

export function createProofClient(
  socket: WebSocket,
): ContractRouterClient<typeof nativeSyncContract> {
  return createORPCClient(new RPCLink({ websocket: socket }));
}
