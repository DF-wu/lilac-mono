import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "./helpers/result-raw-bus";
import type { RequestContext } from "../src/tool-server/types";
import { Attachment } from "../src/tool-server/tools/attachment";
import { resolveRestrictedSessionTmpDir } from "../src/shared/attachment-utils";
import { Panic } from "better-result";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let restoreFetch: (() => void) | undefined;

function installMockFetch(handler: MockFetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = undefined;
  };
}

afterEach(() => {
  restoreFetch?.();
});

async function callValue(
  tool: Attachment,
  ...args: Parameters<Attachment["call"]>
): Promise<unknown> {
  const outcome = (await tool.call(...args)).match<
    { readonly value: unknown } | { readonly error: { readonly message: string } }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in outcome) throw new Error(outcome.error.message);
  return outcome.value;
}

function createInMemoryRawBus(): RawBus & TestRawSubscriptionHost {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: TestRawMessageHandler;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-0`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, id);
      }

      return { id, cursor: id };
    },

    subscribe: subscribeForTest,
    openTestSubscription: async (
      topic: string,
      opts: SubscriptionOptions,
      handler: TestRawMessageHandler,
    ) => {
      const entry = { topic, opts, handler };
      subs.add(entry);

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
        const existing = topics.get(topic) ?? [];
        for (const m of existing) {
          await handler(m, m.id);
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async (topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

function isAddFilesResult(
  value: unknown,
): value is { ok: true; attachments: Array<{ filename: string }> } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && Array.isArray(record.attachments);
}

describe("tool-server attachment", () => {
  it("uses collision-resistant restricted tmp directories", () => {
    expect(resolveRestrictedSessionTmpDir(".")).not.toBe("/tmp/lilac-restricted");
    expect(resolveRestrictedSessionTmpDir("..")).not.toBe("/tmp");
    expect(resolveRestrictedSessionTmpDir("a/b")).not.toBe(resolveRestrictedSessionTmpDir("a_b"));
  });

  it("advertises paths as variadic primary positional input", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = new Attachment({ bus });

    const entries = await tool.list();
    const addFiles = entries.find((entry) => entry.callableId === "attachment.add_files");

    expect(addFiles?.primaryPositional).toEqual({
      field: "paths",
      variadic: true,
    });
  });

  it("accepts scalar paths and filenames", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = new Attachment({ bus });

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          paths: p,
          filenames: "renamed.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0]?.filename).toBe("renamed.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts files as an alias for paths", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = new Attachment({ bus });

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          files: p,
          filenames: "aliased.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0]?.filename).toBe("aliased.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows restricted attachment reads from sandbox /tmp", async () => {
    const sessionId = "restricted-attachment-test";
    const restrictedTmp = resolveRestrictedSessionTmpDir(sessionId);
    await fs.mkdir(restrictedTmp, { recursive: true });
    await fs.writeFile(join(restrictedTmp, "hello.txt"), "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = new Attachment({ bus });

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId,
        requestClient: "discord",
        cwd: "/tmp",
        safetyMode: "restricted",
      };

      const res = await callValue(
        tool,
        "attachment.add_files",
        {
          paths: "hello.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments[0]?.filename).toBe("hello.txt");
    } finally {
      await fs.rm(restrictedTmp, { recursive: true, force: true });
    }
  });

  it("rejects restricted attachment reads outside sandbox /tmp", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = new Attachment({ bus });

    const ctx: RequestContext = {
      requestId: "discord:c1:m1",
      sessionId: "restricted-attachment-test",
      requestClient: "discord",
      cwd: "/workspace",
      safetyMode: "restricted",
    };

    const result = await tool.call(
      "attachment.add_files",
      {
        paths: "secret.txt",
      },
      { context: ctx },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({
        kind: "denied",
        message: "Restricted mode only allows file paths under /tmp.",
      });
    }
  });

  it("reports restricted attachment download paths as sandbox /tmp paths", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = new Attachment({ bus });

    const res = await callValue(
      tool,
      "attachment.download",
      {},
      {
        context: {
          requestId: "discord:c1:m1",
          sessionId: "restricted-attachment-test",
          requestClient: "discord",
          cwd: "/workspace",
          safetyMode: "restricted",
        },
        messages: [],
      },
    );

    expect(res).toEqual({ ok: true, downloadDir: "/tmp", files: [] });
  });

  it("rejects attachment.download URLs outside Discord CDN hosts", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tool = new Attachment({ bus });

    const result = await tool.call(
      "attachment.download",
      {},
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "external.pdf",
                data: "https://example.com/external.pdf",
              },
            ],
          },
        ],
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("denied");
      expect(result.error.message).toContain("Blocked attachment host 'example.com'");
    }
  });

  it("redacts signed URL query strings from download failures", async () => {
    installMockFetch(async () => new Response("unavailable", { status: 503 }));
    const raw = createInMemoryRawBus();
    const tool = new Attachment({ bus: createLilacBus(raw) });
    const signedUrl =
      "https://cdn.discordapp.com/attachments/1/2/report.pdf?ex=secret-expiry&sig=secret-signature";

    const result = await tool.call(
      "attachment.download",
      {},
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "report.pdf",
                data: signedUrl,
              },
            ],
          },
        ],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain(
        "https://cdn.discordapp.com/attachments/1/2/report.pdf",
      );
      expect(result.error.message).not.toContain("secret-expiry");
      expect(result.error.message).not.toContain("secret-signature");
      expect(result.error.message).not.toContain("?");
    }
  });

  it("preserves Panic from attachment downloads", async () => {
    const panic = new Panic({ message: "attachment fetch invariant" });
    installMockFetch(async () => {
      throw panic;
    });
    const raw = createInMemoryRawBus();
    const tool = new Attachment({ bus: createLilacBus(raw) });

    const [settled] = await Promise.allSettled([
      tool.call(
        "attachment.download",
        {},
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "report.pdf",
                  data: "https://cdn.discordapp.com/attachments/1/2/report.pdf?sig=secret",
                },
              ],
            },
          ],
        },
      ),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });
});
