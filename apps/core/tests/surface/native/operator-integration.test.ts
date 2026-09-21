import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { nativeContract } from "@stanley2058/lilac-client-protocol";
import { createNativeIntegrationFixture } from "./integration-fixture";

test("operator console uses the existing runner alongside web login, then deletes its conversation", async () => {
  const token = randomBytes(32).toString("base64url");
  const fixture = await createNativeIntegrationFixture({
    operatorTokenSha256: createHash("sha256").update(token).digest("hex"),
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "x-lilac-operator-session": crypto.randomUUID(),
  };
  const endpoint = "http://127.0.0.1:8788/api/operator/session";
  let socket: WebSocket | undefined;
  try {
    expect(
      (await fetch(`${fixture.url}/api/operator/session`, { method: "POST", headers })).status,
    ).not.toBe(200);
    const started = await fetch(endpoint, { method: "POST", headers });
    expect(started.status).toBe(200);
    const { threadId } = (await started.json()) as { threadId: string };
    const NativeSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: { headers: Record<string, string> }): WebSocket;
    };
    socket = new NativeSocket("ws://127.0.0.1:8788/api/socket", { headers });
    const client = createORPCClient<ContractRouterClient<typeof nativeContract>>(
      new RPCLink({ websocket: socket }),
    );
    expect((await client.bootstrap.get({ threadId })).viewer.role).toBe("owner");
    expect((await client.connection.reauthenticate({ token })).id).toBe("owner");
    await expect(
      client.threads.create({ commandId: crypto.randomUUID(), title: "Not allowed" }),
    ).rejects.toThrow();
    const receipt = await client.inputs.submit({
      threadId,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "Temporary fixture prompt",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await new Promise<void>((resolve) => {
      const check = () =>
        fixture.store.getInput(receipt.inputId).unwrap().completedAt !== undefined;
      const stop = fixture.store.subscribeChanges(() => {
        if (check()) {
          stop();
          resolve();
        }
      });
      if (check()) {
        stop();
        resolve();
      }
    });
    const reply = await client.threads.sync({ threadId });
    expect(JSON.stringify(reply)).toContain("Fixture response");
    const web = fixture.connect();
    expect((await web.client.threads.list({})).items.some((thread) => thread.id === threadId)).toBe(
      false,
    );
    expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(200);
    expect(fixture.store.getThread("owner", threadId).isErr()).toBe(true);
    expect(fixture.store.getThreadRecord(threadId).unwrap().mutationPending).toBe(false);
    expect((await fetch(endpoint, { method: "POST", headers })).status).toBe(401);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    socket?.close();
    await fixture.close();
  }
}, 20_000);
