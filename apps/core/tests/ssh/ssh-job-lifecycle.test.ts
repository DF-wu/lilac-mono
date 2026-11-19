import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Panic, Result } from "better-result";

import * as deployment from "../../src/ssh/remote-runner-deploy";
import * as command from "../../src/ssh/ssh-command";
import * as config from "../../src/ssh/ssh-config";
import { sshCallRunner, sshExecBash } from "../../src/ssh/ssh-exec";

afterEach(() => mock.restore());

function configureRunner() {
  spyOn(config, "requireConfiguredSshHost").mockResolvedValue(undefined);
  spyOn(config, "requireConfiguredSshHostResult").mockResolvedValue(Result.ok(undefined));
  spyOn(deployment, "resolveRemoteRunner").mockResolvedValue(
    Result.ok({ kind: "runner", target: "x86_64-unknown-linux-musl", command: ["runner"] }),
  );
  return spyOn(command, "buildSshArgs").mockResolvedValue(["host", "runner"]);
}

function closedOutput(text = "") {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
}

function handledRejection(error: Error) {
  const promise = Promise.reject(error);
  // The assertion must detect a lost rejection without making the test runner own it.
  void promise.catch(() => undefined);
  return promise;
}

function fakeChild(options?: { running?: boolean; output?: string; pid?: number }) {
  const exit = Promise.withResolvers<number>();
  if (!options?.running) exit.resolve(0);
  const stdin = {
    write: mock((): number | Promise<number> => 1),
    flush: mock((): number | Promise<number> => 1),
    end: mock((): number | Promise<number> => {
      exit.resolve(0);
      return 0;
    }),
  };
  const child = {
    pid: options?.pid ?? 0,
    stdin,
    stdout: closedOutput(options?.output),
    stderr: closedOutput(),
    exited: exit.promise,
  } as unknown as ReturnType<typeof Bun.spawn>;
  spyOn(Bun, "spawn").mockImplementation(() => child);
  return { child, stdin, exit };
}

describe("SSH job lifecycle", () => {
  it("does not start SSH argument setup after deployment resolves a cancelled call", async () => {
    const args = configureRunner();
    const controller = new AbortController();
    spyOn(deployment, "resolveRemoteRunner").mockImplementation(async () => {
      controller.abort();
      return Result.ok({
        kind: "runner",
        target: "x86_64-unknown-linux-musl",
        command: ["runner"],
      });
    });
    fakeChild();
    const result = await sshExecBash({
      host: "host",
      cmd: "true",
      signal: controller.signal,
      maxOutputChars: 100,
    });
    expect(result.aborted).toBeTrue();
    expect(args).not.toHaveBeenCalled();
    expect(Bun.spawn).not.toHaveBeenCalled();
  });

  it("does not spawn or dispatch a write cancelled during SSH argument setup", async () => {
    const args = configureRunner();
    const controller = new AbortController();
    args.mockImplementation(async () => {
      controller.abort();
      return ["host", "runner"];
    });
    const { stdin } = fakeChild();
    const result = await sshCallRunner({
      host: "host",
      request: { op: "write_file", path: "/target", content: "mutation" },
      timeoutMs: 1000,
      signal: controller.signal,
      maxOutputChars: 100,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.result.aborted).toBeTrue();
    expect(Bun.spawn).not.toHaveBeenCalled();
    expect(stdin.write).not.toHaveBeenCalled();
  });

  it("does not dispatch a request if cancellation reaches the newly spawned client", async () => {
    configureRunner();
    const controller = new AbortController();
    const { child, stdin } = fakeChild();
    spyOn(Bun, "spawn").mockImplementation(() => {
      controller.abort();
      return child;
    });
    const result = await sshExecBash({
      host: "host",
      cmd: "true",
      signal: controller.signal,
      maxOutputChars: 100,
    });
    expect(result.aborted).toBeTrue();
    expect(stdin.write).not.toHaveBeenCalled();
    expect(stdin.end).toHaveBeenCalled();
  });

  for (const operation of ["write", "flush", "end"] as const) {
    it(`fails the job when asynchronous stdin ${operation} rejects`, async () => {
      configureRunner();
      const { stdin } = fakeChild({ running: operation !== "end" });
      stdin[operation].mockImplementation(() => handledRejection(new Error("broken pipe")));
      const result = await sshExecBash({ host: "host", cmd: "true", maxOutputChars: 100 });
      expect(result.exitCode).toBe(-1);
      expect(result.errors?.exitRead).toContain(
        operation === "end" ? "Failed to close SSH stdin" : "Failed to send the remote command",
      );
    });
  }

  it("closes stdin and waits for child cleanup before propagating the original output Panic", async () => {
    configureRunner();
    const { stdin, exit } = fakeChild({ running: true, output: "ready" });
    const panic = new Panic({ message: "activity invariant" });
    const execution = sshExecBash({
      host: "host",
      cmd: "sleep 300",
      maxOutputChars: 100,
      onActivity: () => {
        throw panic;
      },
    });
    await expect(execution).rejects.toBe(panic);
    expect(stdin.end).toHaveBeenCalled();
    expect(await exit.promise).toBe(0);
  });

  it("preserves the output Panic when closing stdin also panics", async () => {
    configureRunner();
    const { stdin, exit } = fakeChild({ running: true, output: "ready" });
    const panic = new Panic({ message: "activity invariant" });
    stdin.end.mockImplementation(() => {
      exit.resolve(0);
      return handledRejection(new Panic({ message: "cleanup invariant" }));
    });
    await expect(
      sshExecBash({
        host: "host",
        cmd: "true",
        maxOutputChars: 100,
        onActivity: () => {
          throw panic;
        },
      }),
    ).rejects.toBe(panic);
    expect(stdin.end).toHaveBeenCalledTimes(1);
  });

  it("escalates a wedged client through SIGKILL before bounded Panic cleanup ends", async () => {
    configureRunner();
    const { stdin, exit } = fakeChild({ running: true, output: "ready", pid: 12345 });
    const signals: string[] = [];
    spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(String(signal));
      return true;
    });
    const end = Promise.withResolvers<number>();
    stdin.end.mockReturnValue(end.promise);
    const panic = new Panic({ message: "output invariant" });
    try {
      await expect(
        sshExecBash({
          host: "host",
          cmd: "true",
          maxOutputChars: 100,
          onActivity: () => {
            throw panic;
          },
        }),
      ).rejects.toBe(panic);
      expect(signals).toContain("SIGTERM");
      expect(signals).toContain("SIGKILL");
    } finally {
      end.resolve(0);
      exit.resolve(0);
    }
  }, 10_000);

  it("keeps group escalation after the SSH leader exits on TERM and output capture finishes", async () => {
    configureRunner();
    const { stdin, exit } = fakeChild({ running: true, output: "ready", pid: 12345 });
    stdin.end.mockReturnValue(0);
    const timers: { delay: number; run: () => void; cleared: boolean }[] = [];
    spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => {
      const timer = { delay, run, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      const scheduled = timers.find((entry) => Object.is(entry, timer));
      if (scheduled) scheduled.cleared = true;
    });
    let helperAlive = true;
    const signals: [number, string][] = [];
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push([pid, String(signal)]);
      if (signal === "SIGTERM") exit.resolve(0);
      if (pid === -12345 && signal === "SIGKILL") helperAlive = false;
      return true;
    });
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const execution = sshExecBash({
      host: "host",
      cmd: "true",
      maxOutputChars: 100,
      signal: controller.signal,
      onActivity: () => {
        controller.abort();
        ready.resolve();
      },
    });
    await ready.promise;
    const term = timers.find((timer) => timer.delay === 5000);
    expect(term).toBeDefined();
    term!.run();
    expect((await execution).aborted).toBeTrue();
    const hardKill = timers.find((timer) => timer.delay === 2000);
    expect(hardKill).toBeDefined();
    expect(hardKill!.cleared).toBeFalse();
    hardKill!.run();
    expect(helperAlive).toBeFalse();
    expect(signals.every(([pid]) => pid === 12345 || pid === -12345)).toBeTrue();
  });
});
