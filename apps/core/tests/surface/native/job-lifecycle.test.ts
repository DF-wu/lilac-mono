import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";

import type { JobOwner, JobRecord } from "../../../src/jobs/job-domain";
import { JobService } from "../../../src/jobs/job-service";
import { Result } from "better-result";
import { JobStoreFailed, SqliteJobStore } from "../../../src/jobs/job-store";
import { nativeSessionId } from "../../../src/surface/native/native-protocol";
import type { NativeStore } from "../../../src/surface/native/store";
import {
  createNativeIntegrationFixture,
  integrationValue,
  nativeFixtureTextResponse,
} from "./integration-fixture";

function waitForStore(store: NativeStore, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = store.subscribeChanges(() => {
      if (!predicate()) return;
      stop();
      resolve();
    });
    if (predicate()) {
      stop();
      resolve();
    }
  });
}

async function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "lilac-native-jobs-"));
  const jobStore = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
  const jobs = new JobService({ store: jobStore, logDir: path.join(dir, "logs") });
  const prompts: string[] = [];
  const fixture = await createNativeIntegrationFixture({
    jobs,
    additionalLocalUsers: [
      { userId: "reader", username: "reader", password: "reader-fixture-password" },
    ],
    model: new MockLanguageModelV4({
      modelId: "job-lifecycle-fixture",
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return nativeFixtureTextResponse("NO_REPLY");
      },
    }),
  });
  const client = fixture.connect().client;
  const thread = await client.threads.create({ commandId: crypto.randomUUID(), title: "Jobs" });
  const sessionId = nativeSessionId(thread.id);
  const owner: JobOwner = {
    requestId: "request",
    requestDeliveryId: null,
    sessionId,
    platform: "native",
    userId: thread.starterId,
    originMessageId: null,
    runProfile: "primary",
  };
  const startService = async (requestId = owner.requestId, mode: "service" | "await" = "service") =>
    (
      await jobs.start({
        owner: { ...owner, requestId },
        toolCallId: crypto.randomUUID(),
        mode,
        label: "dev server",
        launch: {
          args: ["bash", "-c", mode === "await" ? "printf await-output" : "sleep 60"],
          cwd: tmpdir(),
          env: process.env,
          literalSecrets: [],
          redactedCommand: "sleep 60",
        },
      })
    ).match({
      ok: (job) => job,
      err: (error) => {
        throw error;
      },
    });
  const read = (jobId: string) =>
    jobStore.get(jobId).match<JobRecord | null>({ ok: (job) => job, err: () => null });
  const untilStopped = (jobId: string) =>
    new Promise<JobRecord>((resolve) => {
      const check = () => {
        const job = read(jobId);
        if (job && job.status !== "running" && job.status !== "starting") {
          stop();
          resolve(job);
        }
      };
      const stop = jobs.subscribe(check);
      check();
    });
  return {
    fixture,
    client,
    thread,
    jobs,
    jobStore,
    prompts,
    startService,
    read,
    untilStopped,
    close: async () => {
      await jobs.close();
      await fixture.close();
      jobStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("native thread actions stop jobs without telling the agent", () => {
  test("settling the thread", async () => {
    const h = await harness();
    try {
      const job = await h.startService();
      await h.client.sidebar.move({ threadId: h.thread.id, section: "settled" });
      const stopped = await h.untilStopped(job.jobId);
      expect(stopped.stopReason).toBe("thread_settled");
      expect(stopped.delivery).toBe("suppressed");
      expect(h.prompts).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test("a reader settling their own sidebar leaves the jobs running", async () => {
    const h = await harness();
    try {
      const job = await h.startService();
      await h.client.participants.set({ threadId: h.thread.id, userId: "reader", role: "read" });
      const reader = h.fixture.connect(
        await h.fixture.loginAs("reader", "reader-fixture-password"),
      ).client;
      await reader.sidebar.move({ threadId: h.thread.id, section: "settled" });
      expect(h.read(job.jobId)?.status).toBe("running");
    } finally {
      await h.close();
    }
  });

  test("archiving the thread", async () => {
    const h = await harness();
    try {
      const job = await h.startService();
      await h.client.threads.update({
        threadId: h.thread.id,
        archived: true,
        expectedRevision: h.fixture.store
          .getThreadRecord(h.thread.id)
          .match({ ok: (thread) => thread.revision, err: () => 0 }),
      });
      const stopped = await h.untilStopped(job.jobId);
      expect(stopped.stopReason).toBe("thread_archived");
      expect(stopped.delivery).toBe("suppressed");
    } finally {
      await h.close();
    }
  });

  test("deleting the thread", async () => {
    const h = await harness();
    try {
      const job = await h.startService();
      await h.client.threads.delete({
        threadId: h.thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
      });
      expect(h.read(job.jobId)?.stopReason).toBe("thread_deleted");
    } finally {
      await h.close();
    }
  });
});

describe("rewinding", () => {
  test.each([false, true])(
    "rewind suppresses discarded job output and retries pending suppression (%s)",
    async (failSuppress) => {
      const h = await harness();
      try {
        const submit = async (text: string) => {
          const receipt = await h.client.inputs.submit({
            threadId: h.thread.id,
            commandId: crypto.randomUUID(),
            historyGeneration: 0,
            text,
            mode: "prompt",
            attachmentIds: [],
            skillIds: [],
          });
          await waitForStore(
            h.fixture.store,
            () =>
              integrationValue(h.fixture.store.getInput(receipt.inputId)).completedAt !== undefined,
          );
          return receipt;
        };
        const first = await submit("first");
        const target = await submit("second");
        // Both jobs start after the discarded input; only their request ownership distinguishes them.
        const kept = await h.startService(
          integrationValue(h.fixture.store.getInput(first.inputId)).requestId,
        );
        const discarded = await h.startService(
          integrationValue(h.fixture.store.getInput(target.inputId)).requestId,
        );
        const keptAwait = await h.startService(
          integrationValue(h.fixture.store.getInput(first.inputId)).requestId,
          "await",
        );
        const discardedAwait = await h.startService(
          integrationValue(h.fixture.store.getInput(target.inputId)).requestId,
          "await",
        );
        await h.untilStopped(keptAwait.jobId);
        await h.untilStopped(discardedAwait.jobId);
        if (!target.turnId) throw new Error("Full turn missing stable identity");
        const before = await h.client.threads.sync({ threadId: h.thread.id });

        const request = {
          threadId: h.thread.id,
          commandId: crypto.randomUUID(),
          historyGeneration: 0,
          expectedRevision: before.checkpoint.projectionRevision,
          turnId: target.turnId,
        };
        let failing = failSuppress;
        const persist = h.jobStore.suppress.bind(h.jobStore);
        const suppress = spyOn(h.jobStore, "suppress").mockImplementation((ids) =>
          failing
            ? Result.err(
                new JobStoreFailed({
                  operation: "suppress",
                  code: "SQLITE_BUSY",
                  message: "transient suppression failure",
                }),
              )
            : persist(ids),
        );
        try {
          if (failSuppress) {
            await expect(h.client.threads.rewind(request)).rejects.toThrow();
            expect(
              integrationValue(h.fixture.store.getThreadRecord(h.thread.id)).mutationPending,
            ).toBe(true);
            expect(h.read(discarded.jobId)?.status).toBe("stopped");
            expect(h.read(discardedAwait.jobId)?.delivery).toBe("pending");
            failing = false;
          }
          await h.client.threads.rewind(request);
          expect(
            integrationValue(h.fixture.store.getThreadRecord(h.thread.id)).mutationPending,
          ).toBe(false);
          expect(h.read(discardedAwait.jobId)?.delivery).toBe("suppressed");
          expect(h.read(keptAwait.jobId)?.delivery).toBe("pending");
          expect(
            (await h.jobs.pendingEvents(nativeSessionId(h.thread.id))).map(
              (event) => event.job.jobId,
            ),
          ).toEqual([keptAwait.jobId]);
        } finally {
          suppress.mockRestore();
        }

        expect(h.read(discarded.jobId)?.stopReason).toBe("thread_rewound");
        expect(h.read(kept.jobId)?.status).toBe("running");
      } finally {
        await h.close();
      }
    },
  );
});

test.each(["enumeration", "markRunning", "finish"] as const)(
  "rewind completes after storage recovers from %s despite a stale active row",
  async (phase) => {
    const h = await harness();
    try {
      const target = await h.client.inputs.submit({
        threadId: h.thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        text: "stale-job target",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      });
      await waitForStore(
        h.fixture.store,
        () => integrationValue(h.fixture.store.getInput(target.inputId)).completedAt !== undefined,
      );
      const requestId = integrationValue(h.fixture.store.getInput(target.inputId)).requestId;
      const failure = new JobStoreFailed({
        operation: phase,
        code: "SQLITE_BUSY",
        message: "busy",
      });
      if (phase === "enumeration") {
        integrationValue(
          h.jobStore.reserve({
            jobId: "job_stale",
            launchKey: "stale",
            owner: {
              requestId,
              requestDeliveryId: null,
              sessionId: nativeSessionId(h.thread.id),
              platform: "native",
              userId: h.thread.starterId,
              originMessageId: null,
              runProfile: "primary",
            },
            toolCallId: "stale",
            mode: "await",
            label: "stale",
            command: "unused",
            cwd: tmpdir(),
            deadlineAt: Date.now() + 1000,
          }),
        );
        const enumeration = spyOn(h.jobStore, "listActive").mockReturnValue(Result.err(failure));
        try {
          h.jobs.reconcileAfterRestart();
        } finally {
          enumeration.mockRestore();
        }
      } else if (phase === "markRunning") {
        const registration = spyOn(h.jobStore, "markRunning").mockReturnValueOnce(
          Result.err(failure),
        );
        try {
          await expect(h.startService(requestId, "await")).rejects.toMatchObject({
            cause: failure,
          });
        } finally {
          registration.mockRestore();
        }
      } else {
        const attempted = Promise.withResolvers<void>();
        const finish = spyOn(h.jobStore, "finish").mockImplementation(() => {
          attempted.resolve();
          return Result.err(failure);
        });
        try {
          await h.startService(requestId, "await");
          await attempted.promise;
        } finally {
          finish.mockRestore();
        }
      }
      const stale = integrationValue(
        h.jobStore.listActiveForSession(nativeSessionId(h.thread.id)),
      )[0]!;
      expect(stale.status).toBe(phase === "finish" ? "running" : "starting");
      const before = await h.client.threads.sync({ threadId: h.thread.id });
      const request = {
        threadId: h.thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        expectedRevision: before.checkpoint.projectionRevision,
        turnId: target.turnId!,
      };
      await h.client.threads.rewind(request);
      await h.client.threads.rewind(request);
      expect(integrationValue(h.fixture.store.getThreadRecord(h.thread.id)).mutationPending).toBe(
        false,
      );
      expect(h.read(stale.jobId)).toEqual(stale);
      expect(await h.jobs.pendingEvents(nativeSessionId(h.thread.id))).toEqual([]);
      const next = await h.client.inputs.submit({
        threadId: h.thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 1,
        text: "after successful rewind",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      });
      await waitForStore(
        h.fixture.store,
        () => integrationValue(h.fixture.store.getInput(next.inputId)).completedAt !== undefined,
      );
      expect(h.prompts.at(-1)?.includes("await-output")).toBe(false);
    } finally {
      await h.close();
    }
  },
);

describe("native job wakes", () => {
  const wake = (h: Awaited<ReturnType<typeof harness>>, wakeId = crypto.randomUUID()) =>
    integrationValue(
      h.fixture.runtime.deliverJobWake({
        wakeId,
        threadId: h.thread.id,
        userId: h.thread.starterId,
        text: "Background job update:\n- dev server exited with code 1",
      }),
    );
  const idle = (h: Awaited<ReturnType<typeof harness>>) =>
    waitForStore(h.fixture.store, () =>
      h.fixture.store
        .getThreadRecord(h.thread.id)
        .match({ ok: (thread) => thread.activeRunId === undefined, err: () => false }),
    );
  const submit = async (h: Awaited<ReturnType<typeof harness>>, text: string) => {
    const receipt = await h.client.inputs.submit({
      threadId: h.thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await waitForStore(
      h.fixture.store,
      () => integrationValue(h.fixture.store.getInput(receipt.inputId)).completedAt !== undefined,
    );
  };

  test("the model sees the wake, and a silent reply leaves nothing for people", async () => {
    const h = await harness();
    try {
      await submit(h, "start the server");
      const before = await h.client.threads.get({ threadId: h.thread.id });
      const beforeOutline = await h.client.threads.outline({ threadId: h.thread.id });
      await h.client.threads.markRead({
        threadId: h.thread.id,
        turnId: (await latestTurnId(h)) ?? "",
      });

      const sent = h.prompts.length;
      expect(wake(h)).toBe("accepted");
      await waitForStore(h.fixture.store, () => h.prompts.length > sent);
      expect(h.prompts.at(-1)).toContain("dev server exited with code 1");
      await idle(h);

      const synced = JSON.stringify(await h.client.threads.sync({ threadId: h.thread.id }));
      expect(synced).not.toContain("dev server exited with code 1");
      const after = await h.client.threads.get({ threadId: h.thread.id });
      expect(after.displayStatus).toBe("idle");
      expect(before.title).toBe(after.title);
      const afterOutline = await h.client.threads.outline({ threadId: h.thread.id });
      expect(afterOutline.positions).toEqual(beforeOutline.positions);
    } finally {
      await h.close();
    }
  });

  test("a retry under the same ID does not start another run", async () => {
    const h = await harness();
    try {
      await submit(h, "start the server");
      const wakeId = crypto.randomUUID();
      const sent = h.prompts.length;
      expect(wake(h, wakeId)).toBe("accepted");
      await waitForStore(h.fixture.store, () => h.prompts.length > sent);
      await idle(h);

      expect(wake(h, wakeId)).toBe("accepted");
      await h.fixture.runtime.execution.kick(h.thread.id);
      expect(h.prompts).toHaveLength(sent + 1);
    } finally {
      await h.close();
    }
  });

  test("abandons the wake when the thread is archived", async () => {
    const h = await harness();
    try {
      await h.client.threads.update({
        threadId: h.thread.id,
        archived: true,
        expectedRevision: h.fixture.store
          .getThreadRecord(h.thread.id)
          .match({ ok: (thread) => thread.revision, err: () => 0 }),
      });
      expect(wake(h)).toBe("abandon");
    } finally {
      await h.close();
    }
  });

  async function latestTurnId(h: Awaited<ReturnType<typeof harness>>) {
    const synced = await h.client.threads.sync({ threadId: h.thread.id });
    return synced.kind === "window"
      ? synced.slots.findLast((slot) => slot.kind === "ready")?.turnId
      : undefined;
  }
});

describe("a wake the agent answers", () => {
  test("appears as a reply, with no wake message above it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lilac-native-jobs-reply-"));
    const jobStore = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
    const jobs = new JobService({ store: jobStore, logDir: path.join(dir, "logs") });
    let modelCalls = 0;
    const fixture = await createNativeIntegrationFixture({
      jobs,
      model: new MockLanguageModelV4({
        modelId: "job-reply-fixture",
        doStream: async () => {
          modelCalls += 1;
          return nativeFixtureTextResponse(`Reply number ${modelCalls}.`);
        },
      }),
    });
    try {
      const { client } = fixture.connect();
      const thread = await client.threads.create({ commandId: crypto.randomUUID(), title: "Jobs" });
      const receipt = await client.inputs.submit({
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        text: "start",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      });
      await waitForStore(
        fixture.store,
        () => integrationValue(fixture.store.getInput(receipt.inputId)).completedAt !== undefined,
      );

      expect(
        integrationValue(
          fixture.runtime.deliverJobWake({
            wakeId: crypto.randomUUID(),
            threadId: thread.id,
            userId: thread.starterId,
            text: "Background job update",
          }),
        ),
      ).toBe("accepted");
      await waitForStore(
        fixture.store,
        () =>
          modelCalls === 2 &&
          fixture.store
            .getThreadRecord(thread.id)
            .match({ ok: (value) => value.activeRunId === undefined, err: () => false }),
      );

      const synced = JSON.stringify(await client.threads.sync({ threadId: thread.id }));
      expect(synced).not.toContain("Background job update");
      expect(synced).toContain("Reply number 2.");
      const summary = await client.threads.get({ threadId: thread.id });
      expect(summary.displayStatus).toBe("completed");
    } finally {
      await jobs.close();
      await fixture.close();
      jobStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
