import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTuiAuth } from "../src/auth";

test("operator client keeps credentials in headers and renews and ends the same invocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-operator-auth-"));
  const tokenFile = path.join(root, "token");
  const token = "x".repeat(43);
  await writeFile(tokenFile, token, { mode: 0o600 });
  const sessions = new Set<string>();
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(request.url).not.toContain(token);
      sessions.add(request.headers.get("x-lilac-operator-session")!);
      methods.push(request.method);
      return Response.json(
        request.method === "POST" ? { threadId: "temporary-thread" } : { ok: true },
      );
    },
  });
  try {
    const auth = (await createTuiAuth({ tokenFile, baseUrl: server.url.origin })).unwrap();
    expect(auth.threadId).toBe("temporary-thread");
    (await auth.refresh()).unwrap();
    (await auth.logout()).unwrap();
    auth.dispose();
    expect(sessions.size).toBe(1);
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing token reports the root container invocation without entering login", async () => {
  const result = await createTuiAuth({ tokenFile: `/tmp/absent-${crypto.randomUUID()}` });
  expect(result.match({ ok: () => "", err: (error) => error.message })).toContain(
    "inside the container as root",
  );
});

test.each(["complete", "timeout"])(
  "deletion awaits cleanup within its own deadline: %s",
  async (outcome) => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-operator-exit-"));
    const tokenFile = path.join(root, "token");
    await writeFile(tokenFile, "x".repeat(43), { mode: 0o600 });
    const deleting = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const deadline = new AbortController();
    const deadlines = spyOn(AbortSignal, "timeout");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "POST") return Response.json({ threadId: "temporary-thread" });
        deleting.resolve();
        await cleanup.promise;
        return Response.json({ ok: true });
      },
    });
    try {
      const auth = (await createTuiAuth({ tokenFile, baseUrl: server.url.origin })).unwrap();
      expect(deadlines).toHaveBeenCalledTimes(1);
      deadlines.mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(5000);
        return deadline.signal;
      });
      const exit = auth.logout();
      await deleting.promise;
      expect(deadlines).toHaveBeenCalledTimes(2);
      if (outcome === "complete") {
        cleanup.resolve();
        (await exit).unwrap();
      } else {
        deadline.abort(new DOMException("Deadline reached", "TimeoutError"));
        expect((await exit).match({ ok: () => "", err: (error) => error.code })).toBe("network");
      }
      auth.dispose();
    } finally {
      cleanup.resolve();
      deadlines.mockRestore();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
