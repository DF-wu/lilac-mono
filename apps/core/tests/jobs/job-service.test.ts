import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";

import { JOB_LIMITS, type JobOwner, type JobRecord } from "../../src/jobs/job-domain";
import { JobService, type JobWakeDelivery } from "../../src/jobs/job-service";
import { JobStoreFailed, SqliteJobStore } from "../../src/jobs/job-store";

const owner: JobOwner = {
  requestId: "request-1",
  requestDeliveryId: "delivery-1",
  sessionId: "native:thread-1",
  platform: "native",
  userId: "user-1",
  originMessageId: "message-1",
  runProfile: "primary",
};

function launch(command: string, literalSecrets: readonly string[] = []) {
  return {
    args: ["bash", "-c", command],
    cwd: tmpdir(),
    env: process.env,
    literalSecrets,
    redactedCommand: command,
  };
}

function ok<T>(result: {
  match: (handlers: { ok: (value: T) => T; err: (error: unknown) => T }) => T;
}): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

describe("JobService", () => {
  let dir: string;
  let store: SqliteJobStore;
  let service: JobService;
  const services: JobService[] = [];

  function createService(options: { now?: () => number } = {}): JobService {
    const created = new JobService({ store, logDir: path.join(dir, "logs"), ...options });
    services.push(created);
    return created;
  }

  function untilEnded(target: JobService, jobId: string): Promise<JobRecord> {
    const current = () => ok<JobRecord | null>(store.get(jobId));
    return new Promise((resolve) => {
      const check = () => {
        const job = current();
        if (job && job.status !== "running" && job.status !== "starting") {
          unsubscribe();
          resolve(job);
        }
      };
      const unsubscribe = target.subscribe(check);
      check();
    });
  }

  function start(
    target: JobService,
    command: string,
    overrides: {
      toolCallId?: string;
      mode?: "await" | "service";
      owner?: JobOwner;
      timeoutMs?: number;
      literalSecrets?: readonly string[];
    } = {},
  ) {
    return target.start({
      owner: overrides.owner ?? owner,
      toolCallId: overrides.toolCallId ?? crypto.randomUUID(),
      mode: overrides.mode ?? "await",
      label: "test job",
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
      launch: launch(command, overrides.literalSecrets),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lilac-jobs-"));
    store = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
    service = createService();
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((created) => created.close()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes an output handle when preparing the read fails", async () => {
    const job = ok<JobRecord>(await start(service, "printf output"));
    await untilEnded(service, job.jobId);
    const logPath = path.join(dir, "logs", `${job.jobId}.log`);
    const handles = () =>
      readdirSync("/proc/self/fd").filter((entry) => {
        try {
          return readlinkSync(`/proc/self/fd/${entry}`) === logPath;
        } catch {
          return false;
        }
      }).length;
    const before = handles();
    expect((await service.read(owner.sessionId, job.jobId, { tailBytes: -1 })).status).toBe(
      "error",
    );
    expect(handles()).toBe(before);
  });

  it("expires ended jobs during the hourly retention tick", async () => {
    let now = Date.now();
    const retained = createService({ now: () => now });
    const job = ok<JobRecord>(await start(retained, "true"));
    await untilEnded(retained, job.jobId);
    retained.acknowledgeEvents([job.jobId]);
    const intervals = spyOn(globalThis, "setInterval");
    try {
      retained.startWakes({
        port: { deliver: async () => Result.ok<JobWakeDelivery>("accepted") },
        isSessionBusy: () => true,
      });
      const retentionTick = intervals.mock.calls[0]?.[0];
      expect(typeof retentionTick).toBe("function");
      now =
        (ok<JobRecord | null>(store.get(job.jobId))?.endedAt ?? now) + JOB_LIMITS.retentionMs + 1;
      if (typeof retentionTick === "function") retentionTick();
      expect(ok<JobRecord | null>(store.get(job.jobId))).toBeNull();
    } finally {
      intervals.mockRestore();
    }
  });

  it("holds the request while an await job runs and leaves an event when it exits", async () => {
    const job = ok<JobRecord>(await start(service, "echo done; exit 3"));
    const ended = await untilEnded(service, job.jobId);

    expect(ended.status).toBe("exited");
    expect(ended.exitCode).toBe(3);
    expect(service.hasActiveAwait(owner.requestId)).toBe(false);
    const events = await service.pendingEvents(owner.sessionId);
    expect(events.map((event) => event.job.jobId)).toEqual([job.jobId]);
    expect(events[0]?.outputTail).toContain("done");
  });

  it("reports an await job as held until it ends", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 60"));
    expect(service.hasActiveAwait(owner.requestId)).toBe(true);
    await service.stopAwaitJobs(owner.requestId, "user_stop");
    const ended = await untilEnded(service, job.jobId);
    expect(ended.stopReason).toBe("user_stop");
    expect(service.hasActiveAwait(owner.requestId)).toBe(false);
  });

  it("does not hold the request for a service job, and keeps it through a primary run's end", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 60", { mode: "service" }));
    expect(service.hasActiveAwait(owner.requestId)).toBe(false);
    await service.onRunSettled({
      requestId: owner.requestId,
      sessionId: owner.sessionId,
      isPrimary: true,
    });
    expect(ok<JobRecord | null>(store.get(job.jobId))?.status).toBe("running");
  });

  it("returns the existing job when a recovered tool call replays its launch", async () => {
    const first = ok<JobRecord>(await start(service, "sleep 60", { toolCallId: "call-1" }));
    const second = ok<JobRecord>(await start(service, "sleep 60", { toolCallId: "call-1" }));
    expect(second.jobId).toBe(first.jobId);
    expect(ok<JobRecord[]>(store.listActive())).toHaveLength(1);
  });

  it("never writes a secret to the job log, even across output chunks", async () => {
    const secret = "s3cr3t-token-value";
    const job = ok<JobRecord>(
      await start(service, `printf 's3cr3t-'; sleep 0.05; printf 'token-value\\n'`, {
        literalSecrets: [secret],
      }),
    );
    await untilEnded(service, job.jobId);
    const log = readFileSync(path.join(dir, "logs", `${job.jobId}.log`), "utf8");
    expect(log).not.toContain(secret);
    const read = ok<{ job: JobRecord; output: { output: string } }>(
      await service.read(owner.sessionId, job.jobId, {}),
    );
    expect(read.output.output).not.toContain(secret);
  });

  it("shows a running job's output before the job ends", async () => {
    const job = ok<JobRecord>(
      await start(service, "printf 'listening on :3000\\n'; sleep 60", {
        mode: "service",
        literalSecrets: ["a-secret-longer-than-the-output-line-so-far"],
      }),
    );
    await untilLogContains(job.jobId, "listening on :3000");
    const read = ok<{ job: JobRecord; output: { output: string } }>(
      await service.read(owner.sessionId, job.jobId, {}),
    );
    expect(read.job.status).toBe("running");
    expect(read.output.output).toBe("listening on :3000\n");
  });

  it("caps captured output and keeps the job running to completion", async () => {
    const maxOutputBytes = 64 * 1024;
    const capped = new JobService({ store, logDir: path.join(dir, "logs"), maxOutputBytes });
    services.push(capped);
    const job = ok<JobRecord>(
      await start(capped, `head -c ${maxOutputBytes + 1024} /dev/zero | tr '\\0' 'x'`),
    );
    const ended = await untilEnded(capped, job.jobId);
    expect(ended.status).toBe("exited");
    expect(ended.outputTruncated).toBe(true);
    expect(ended.outputBytes).toBe(maxOutputBytes);
  });

  it("stops a job on request without leaving an event for the agent", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 60", { mode: "service" }));
    const stopped = ok<JobRecord>(await service.stop(owner.sessionId, job.jobId));
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("job_stop");
    expect(await service.pendingEvents(owner.sessionId)).toEqual([]);
  });

  it("kills children the command left behind when it exits", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 300 & echo $!", { mode: "service" }));
    await untilEnded(service, job.jobId);
    const read = ok<{ job: JobRecord; output: { output: string } }>(
      await service.read(owner.sessionId, job.jobId, {}),
    );
    const childPid = Number.parseInt(read.output.output, 10);
    expect(existsSync(`/proc/${childPid}/stat`)).toBe(false);
  });

  it("rejects reads and stops from another session", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 60"));
    const denied = await service.stop("native:other", job.jobId);
    expect(denied.match({ ok: () => "ok", err: (error) => error._tag })).toBe("JobNotFound");
    expect(ok<JobRecord | null>(store.get(job.jobId))?.status).toBe("running");
  });

  it("enforces the per-session running limit", async () => {
    for (let index = 0; index < JOB_LIMITS.maxRunningPerSession; index += 1) {
      ok<JobRecord>(await start(service, "sleep 60"));
    }
    const refused = await start(service, "sleep 60");
    expect(refused.match({ ok: () => "ok", err: (error) => error._tag })).toBe(
      "JobCapacityExceeded",
    );
  });

  it("stops a job at its time limit and tells the agent", async () => {
    const job = ok<JobRecord>(await start(service, "sleep 60", { timeoutMs: 50 }));
    const ended = await untilEnded(service, job.jobId);
    expect(ended.status).toBe("timed_out");
    expect(ended.delivery).toBe("pending");
  });

  it("stops a subagent's jobs and drops its events when the subagent ends", async () => {
    const childOwner = {
      ...owner,
      sessionId: "child",
      requestId: "child-request",
      runProfile: "full",
    };
    const job = ok<JobRecord>(
      await start(service, "sleep 60", { mode: "service", owner: childOwner }),
    );
    await service.onRunSettled({
      requestId: childOwner.requestId,
      sessionId: childOwner.sessionId,
      isPrimary: false,
    });
    const ended = ok<JobRecord | null>(store.get(job.jobId));
    expect(ended?.stopReason).toBe("subagent_ended");
    expect(ended?.delivery).toBe("suppressed");
  });

  it("stops every job in a session silently and discards undelivered events", async () => {
    const running = ok<JobRecord>(await start(service, "sleep 60", { mode: "service" }));
    const finished = ok<JobRecord>(await start(service, "true", { mode: "service" }));
    await untilEnded(service, finished.jobId);
    expect(service.hasPendingEvents(owner.sessionId)).toBe(true);

    await service.stopSession(owner.sessionId, "thread_settled");

    expect(ok<JobRecord | null>(store.get(running.jobId))?.stopReason).toBe("thread_settled");
    expect(service.hasPendingEvents(owner.sessionId)).toBe(false);
  });

  it("rewind selects request owners despite overlapping timestamps and retries pending suppression", async () => {
    const discardedOwner = { ...owner, requestId: "discarded" };
    // Both retained jobs start after the discarded input could have been queued.
    const retained = ok<JobRecord>(await start(service, "sleep 60", { mode: "service" }));
    const retainedEvent = ok<JobRecord>(await start(service, "true", { mode: "service" }));
    const discarded = ok<JobRecord>(
      await start(service, "sleep 60", { mode: "service", owner: discardedOwner }),
    );
    const discardedEvent = ok<JobRecord>(
      await start(service, "true", { mode: "service", owner: discardedOwner }),
    );
    await untilEnded(service, retainedEvent.jobId);
    await untilEnded(service, discardedEvent.jobId);
    const suppress = spyOn(store, "suppress").mockReturnValueOnce(
      Result.err(
        new JobStoreFailed({ operation: "suppress", code: "SQLITE_BUSY", message: "busy" }),
      ),
    );
    try {
      expect(
        (
          await service.stopSessionRequests(
            owner.sessionId,
            [discardedOwner.requestId],
            "thread_rewound",
          )
        ).isErr(),
      ).toBe(true);
      expect(ok<JobRecord | null>(store.get(discarded.jobId))?.stopReason).toBe("thread_rewound");
      expect(ok<JobRecord | null>(store.get(discardedEvent.jobId))?.delivery).toBe("pending");
      ok(
        await service.stopSessionRequests(
          owner.sessionId,
          [discardedOwner.requestId],
          "thread_rewound",
        ),
      );
      ok(
        await service.stopSessionRequests(
          owner.sessionId,
          [discardedOwner.requestId],
          "thread_rewound",
        ),
      );
      expect(ok<JobRecord | null>(store.get(discardedEvent.jobId))?.delivery).toBe("suppressed");
      expect(ok<JobRecord | null>(store.get(retained.jobId))?.status).toBe("running");
      expect(ok<JobRecord | null>(store.get(retainedEvent.jobId))?.delivery).toBe("pending");
      expect(suppress.mock.calls[1]?.[0]).toEqual([discardedEvent.jobId]);
      expect(suppress.mock.calls[2]?.[0]).toEqual([]);
    } finally {
      suppress.mockRestore();
    }
  });

  it("rewind suppresses pending await output only for discarded request owners", async () => {
    const retained = ok<JobRecord>(await start(service, "printf retained-output"));
    const discarded = ok<JobRecord>(
      await start(service, "printf discarded-output", {
        owner: { ...owner, requestId: "discarded-await" },
      }),
    );
    await untilEnded(service, retained.jobId);
    await untilEnded(service, discarded.jobId);
    ok(await service.stopSessionRequests(owner.sessionId, ["discarded-await"], "thread_rewound"));
    expect(ok<JobRecord | null>(store.get(discarded.jobId))?.delivery).toBe("suppressed");
    expect(ok<JobRecord | null>(store.get(retained.jobId))?.delivery).toBe("pending");
    const events = await service.pendingEvents(owner.sessionId);
    expect(events.map((event) => event.job.jobId)).toEqual([retained.jobId]);
    expect(events[0]?.outputTail).toBe("retained-output");
  });

  it.each(["await", "service"] as const)(
    "rewind waits for live discarded %s supervision and preserves retained owners",
    async (mode) => {
      const retained = ok<JobRecord>(await start(service, "sleep 60", { mode }));
      const discarded = ok<JobRecord>(
        await start(service, "printf 'ready\\n'; exec sleep 60", {
          mode,
          owner: { ...owner, requestId: "discarded-live" },
        }),
      );
      await untilLogContains(discarded.jobId, "ready");
      const finish = spyOn(store, "finish");
      try {
        process.kill(discarded.pid!, "SIGSTOP");
        const cleanup = service.stopSessionRequests(
          owner.sessionId,
          ["discarded-live"],
          "thread_rewound",
        );
        expect(
          await Promise.race([
            cleanup.then(() => "released"),
            new Promise<string>((resolve) => setImmediate(() => resolve("waiting"))),
          ]),
        ).toBe("waiting");
        expect(finish).not.toHaveBeenCalled();
        process.kill(discarded.pid!, "SIGCONT");
        ok(await cleanup);
        expect(existsSync(`/proc/${discarded.pid}/stat`)).toBe(false);
        expect(ok<JobRecord | null>(store.get(discarded.jobId))).toMatchObject({
          status: "stopped",
          stopReason: "thread_rewound",
          delivery: "suppressed",
          outputBytes: 6,
        });
        expect(ok<JobRecord | null>(store.get(retained.jobId))?.status).toBe("running");
      } finally {
        finish.mockRestore();
      }
    },
  );

  it.each([
    ["await", "enumeration"],
    ["service", "enumeration"],
    ["await", "finish"],
    ["service", "finish"],
    ["await", "markRunning"],
    ["service", "markRunning"],
  ] as const)(
    "rewind tolerates stale %s rows after failed startup/launch %s once storage recovers",
    async (mode, phase) => {
      const failure = new JobStoreFailed({
        operation: phase,
        code: "SQLITE_BUSY",
        message: "transient storage failure",
      });
      const discardedOwner = { ...owner, requestId: "discarded-stale" };
      if (phase === "markRunning") {
        const registration = spyOn(store, "markRunning").mockReturnValueOnce(Result.err(failure));
        try {
          expect(
            (await start(service, "sleep 60", { mode, owner: discardedOwner })).match({
              ok: () => null,
              err: (error) => error,
            }),
          ).toBe(failure);
          await untilProcessExits(registration.mock.calls[0]![1].pid);
        } finally {
          registration.mockRestore();
        }
      } else {
        ok(
          store.reserve({
            jobId: "job_stale",
            launchKey: "stale",
            owner: discardedOwner,
            toolCallId: "stale",
            mode,
            label: "stale startup row",
            command: "unused",
            cwd: tmpdir(),
            deadlineAt: Date.now() + 1000,
          }),
        );
        const unavailable = spyOn(
          store,
          phase === "enumeration" ? "listActive" : "finish",
        ).mockReturnValue(Result.err(failure));
        try {
          createService().reconcileAfterRestart();
        } finally {
          unavailable.mockRestore();
        }
      }
      const stale = ok<JobRecord[]>(store.listActiveForSession(owner.sessionId))[0]!;
      expect(stale.status).toBe("starting");
      const retained = ok<JobRecord>(await start(service, "sleep 60", { mode }));
      const retainedBefore = ok<JobRecord | null>(store.get(retained.jobId));
      const retainedEvent = ok<JobRecord>(await start(service, "printf retained", { mode }));
      const discardedEvent = ok<JobRecord>(
        await start(service, "printf discarded", {
          mode,
          owner: discardedOwner,
        }),
      );
      await untilEnded(service, retainedEvent.jobId);
      await untilEnded(service, discardedEvent.jobId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ok(
          await service.stopSessionRequests(
            owner.sessionId,
            [discardedOwner.requestId],
            "thread_rewound",
          ),
        );
        expect(ok<JobRecord | null>(store.get(stale.jobId))).toEqual(stale);
        expect(ok<JobRecord | null>(store.get(retained.jobId))).toEqual(retainedBefore);
        expect(existsSync(`/proc/${retained.pid}/stat`)).toBe(true);
        expect(ok<JobRecord | null>(store.get(discardedEvent.jobId))?.delivery).toBe("suppressed");
        expect(
          (await service.pendingEvents(owner.sessionId)).map((event) => event.job.jobId),
        ).toEqual([retainedEvent.jobId]);
      }
    },
  );

  it.each(["listActiveForSession", "listPending"] as const)(
    "rewind propagates %s failures and retries cleanup",
    async (operation) => {
      const job = ok<JobRecord>(await start(service, "printf discarded"));
      await untilEnded(service, job.jobId);
      const failure = new JobStoreFailed({ operation, code: "SQLITE_BUSY", message: "busy" });
      const read = spyOn(store, operation).mockReturnValueOnce(Result.err(failure));
      try {
        expect(
          (
            await service.stopSessionRequests(owner.sessionId, [owner.requestId], "thread_rewound")
          ).match({ ok: () => null, err: (error) => error }),
        ).toBe(failure);
        expect(ok<JobRecord | null>(store.get(job.jobId))?.delivery).toBe("pending");
        ok(await service.stopSessionRequests(owner.sessionId, [owner.requestId], "thread_rewound"));
        expect(await service.pendingEvents(owner.sessionId)).toEqual([]);
      } finally {
        read.mockRestore();
      }
    },
  );

  describe("after a restart", () => {
    it("kills what it can identify and reports the job lost", async () => {
      const job = ok<JobRecord>(await start(service, "sleep 300", { mode: "service" }));
      const running = ok<JobRecord | null>(store.get(job.jobId));
      expect(running?.pid).toBeGreaterThan(0);

      // A second service over the same store sees what a new process would after a crash.
      const restarted = createService();
      restarted.reconcileAfterRestart();

      const lost = ok<JobRecord | null>(store.get(job.jobId));
      expect(lost?.status).toBe("lost");
      expect(lost?.delivery).toBe("pending");
      expect(service.hasPendingEvents(owner.sessionId)).toBe(true);
      await untilProcessExits(running?.pid ?? 0);
    });

    it("reports a launch that never recorded its process as lost", () => {
      ok(
        store.reserve({
          jobId: "job_unrecorded",
          launchKey: "request-1:call-x",
          owner,
          toolCallId: "call-x",
          mode: "await",
          label: "unrecorded",
          command: "sleep 1",
          cwd: tmpdir(),
          deadlineAt: Date.now() + 1000,
        }) as never,
      );
      createService().reconcileAfterRestart();
      expect(ok<JobRecord | null>(store.get("job_unrecorded"))?.status).toBe("lost");
    });

    it("returns the lost job when the recovered run replays the launch", async () => {
      const job = ok<JobRecord>(await start(service, "sleep 300", { toolCallId: "call-replay" }));
      const restarted = createService();
      restarted.reconcileAfterRestart();
      const replayed = ok<JobRecord>(
        await start(restarted, "sleep 300", { toolCallId: "call-replay" }),
      );
      expect(replayed.jobId).toBe(job.jobId);
      expect(replayed.status).toBe("lost");
    });
  });

  describe("wakes", () => {
    type Delivered = { wakeId: string; sessionId: string; jobIds: string[] };

    function wakeService(input: { busy?: () => boolean; outcome?: JobWakeDelivery }): {
      service: JobService;
      delivered: Delivered[];
      next: () => Promise<Delivered>;
    } {
      const delivered: Delivered[] = [];
      const waiters: ((value: Delivered) => void)[] = [];
      const created = createService();
      created.startWakes({
        isSessionBusy: input.busy ?? (() => false),
        port: {
          deliver: async ({ wakeId, sessionId, jobs }) => {
            const entry = { wakeId, sessionId, jobIds: jobs.map((job) => job.jobId) };
            delivered.push(entry);
            waiters.shift()?.(entry);
            return Result.ok(input.outcome ?? "accepted");
          },
        },
      });
      return {
        service: created,
        delivered,
        next: () => new Promise((resolve) => waiters.push(resolve)),
      };
    }

    it("wakes an idle session once for jobs that end together", async () => {
      const wakes = wakeService({});
      const received = wakes.next();
      const first = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      const second = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      const wake = await received;
      expect(wake.sessionId).toBe(owner.sessionId);
      await untilEnded(wakes.service, first.jobId);
      await untilEnded(wakes.service, second.jobId);
      expect(wakes.delivered.length).toBeLessThanOrEqual(2);
      expect(new Set(wakes.delivered.flatMap((entry) => entry.jobIds))).toEqual(
        new Set([first.jobId, second.jobId]),
      );
    });

    it("leaves a busy session to drain the event, and wakes once the run settles", async () => {
      let busy = true;
      const wakes = wakeService({ busy: () => busy });
      const job = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      await untilEnded(wakes.service, job.jobId);
      expect(wakes.delivered).toEqual([]);

      busy = false;
      const received = wakes.next();
      await wakes.service.onRunSettled({
        requestId: "other-request",
        sessionId: owner.sessionId,
        isPrimary: true,
      });
      expect((await received).jobIds).toEqual([job.jobId]);
    });

    it("holds events back after ten wakes in a row until a person writes", async () => {
      const wakes = wakeService({});
      const sessionId = owner.sessionId;
      for (let index = 0; index < JOB_LIMITS.maxConsecutiveWakes; index += 1) {
        expect(
          ok<boolean>(store.claimWake({ sessionId, jobIds: [], wakeId: `wake-${index}` })),
        ).toBe(true);
      }
      expect(ok<boolean>(store.claimWake({ sessionId, jobIds: [], wakeId: "over" }))).toBe(false);

      const job = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      await untilEnded(wakes.service, job.jobId);
      await wakes.service.onRunSettled({ requestId: "r", sessionId, isPrimary: true });
      expect(wakes.delivered).toEqual([]);
      expect(wakes.service.hasPendingEvents(sessionId)).toBe(true);

      wakes.service.noteUserInput(sessionId);
      const received = wakes.next();
      await wakes.service.onRunSettled({ requestId: "r", sessionId, isPrimary: true });
      expect((await received).jobIds).toEqual([job.jobId]);
    });

    it("drops the event when the destination is gone for good", async () => {
      const wakes = wakeService({ outcome: "abandon" });
      const received = wakes.next();
      const job = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      await received;
      await untilDelivery(job.jobId, "suppressed");
    });

    it("retries a wake that could not be delivered, without spending more budget", async () => {
      const deliveries: string[] = [];
      const delivered = Promise.withResolvers<void>();
      const created = new JobService({
        store,
        logDir: path.join(dir, "logs"),
        wakeRetryDelaysMs: [1, 1],
      });
      services.push(created);
      created.startWakes({
        isSessionBusy: () => false,
        port: {
          deliver: async ({ wakeId }) => {
            deliveries.push(wakeId);
            if (deliveries.length < 3) return Result.ok("unavailable");
            delivered.resolve();
            return Result.ok("accepted");
          },
        },
      });

      ok<JobRecord>(await start(created, "true", { mode: "service" }));
      await delivered.promise;

      expect(new Set(deliveries).size).toBe(1);
      for (let index = 1; index < JOB_LIMITS.maxConsecutiveWakes; index += 1) {
        expect(
          ok<boolean>(
            store.claimWake({ sessionId: owner.sessionId, jobIds: [], wakeId: `w${index}` }),
          ),
        ).toBe(true);
      }
      const spent = ok<boolean>(
        store.claimWake({ sessionId: owner.sessionId, jobIds: [], wakeId: "over" }),
      );
      expect(spent).toBe(false);
    });

    it("stops retrying after its delays and leaves the event pending", async () => {
      let attempts = 0;
      const exhausted = Promise.withResolvers<void>();
      const created = new JobService({
        store,
        logDir: path.join(dir, "logs"),
        wakeRetryDelaysMs: [1],
      });
      services.push(created);
      created.startWakes({
        isSessionBusy: () => false,
        port: {
          deliver: async () => {
            attempts += 1;
            if (attempts === 2) exhausted.resolve();
            return Result.ok("unavailable");
          },
        },
      });

      const job = ok<JobRecord>(await start(created, "true", { mode: "service" }));
      await exhausted.promise;
      await untilEnded(created, job.jobId);
      expect(created.hasPendingEvents(owner.sessionId)).toBe(true);
      expect(attempts).toBe(2);
    });

    it("retries an accepted wake under the same ID after a restart", async () => {
      const wakes = wakeService({});
      const received = wakes.next();
      const job = ok<JobRecord>(await start(wakes.service, "true", { mode: "service" }));
      const original = await received;

      const restarted = wakeService({});
      const retried = restarted.next();
      expect((await retried).wakeId).toBe(original.wakeId);
      expect(ok<JobRecord | null>(store.get(job.jobId))?.delivery).toBe("pending");
    });
  });

  function untilDelivery(jobId: string, delivery: string): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        if (ok<JobRecord | null>(store.get(jobId))?.delivery === delivery) {
          resolve();
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
  }

  function untilLogContains(jobId: string, text: string): Promise<void> {
    const logPath = path.join(dir, "logs", `${jobId}.log`);
    return new Promise((resolve) => {
      const poll = () => {
        if (existsSync(logPath) && readFileSync(logPath, "utf8").includes(text)) {
          resolve();
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
  }

  function untilProcessExits(pid: number): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        if (!existsSync(`/proc/${pid}/stat`)) {
          resolve();
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
  }
});
