import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import { runMiniLilac, runMiniLilacMain, type MiniLilacCommandRunners } from "./main";

function testRunners(calls: string[]): MiniLilacCommandRunners {
  return {
    tui: async (args) => {
      calls.push(`tui:${args.join("|")}`);
      return 23;
    },
    server: async (args) => {
      calls.push(`server:${args.join("|")}`);
    },
  };
}

describe("mini-lilac command", () => {
  it("starts the TUI by default and supports an explicit tui command", async () => {
    const calls: string[] = [];
    const runners = testRunners(calls);

    const implicit = await runMiniLilac(["--server", "http://localhost"], runners);
    const explicit = await runMiniLilac(["tui", "--session", "session-1"], runners);
    expect(implicit.status).toBe("ok");
    expect(explicit.status).toBe("ok");
    if (implicit.status === "ok") expect(implicit.value).toBe(23);
    if (explicit.status === "ok") expect(explicit.value).toBe(23);
    expect(calls).toEqual(["tui:--server|http://localhost", "tui:--session|session-1"]);
  });

  it("forwards all server arguments without parsing them", async () => {
    const calls: string[] = [];

    const result = await runMiniLilac(["server", "auth", "codex", "--status"], testRunners(calls));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toBe(0);
    expect(calls).toEqual(["server:auth|codex|--status"]);
  });

  it("routes top-level history recovery to server maintenance without loading the TUI", async () => {
    const calls: string[] = [];

    const result = await runMiniLilac(
      ["history-recovery", "status", "--workspace", "/workspace"],
      testRunners(calls),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toBe(0);
    expect(calls).toEqual(["server:history-recovery|status|--workspace|/workspace"]);
  });

  it("owns top-level help without loading a client", async () => {
    const calls: string[] = [];
    let output = "";

    const result = await runMiniLilac(
      ["--help"],
      testRunners(calls),
      (text) => void (output += text),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toContain("mini-lilac history-recovery status [--workspace <cwd>]");
    expect(output).toContain("mini-lilac server [server-options]");
  });

  it("returns delegated command failures as typed errors", async () => {
    const result = await runMiniLilac(["server"], {
      tui: async () => 0,
      server: async () => {
        throw new Error("server unavailable");
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("MiniLilacCommandFailed");
      expect(result.error.command).toBe("server");
      expect(result.error.message).toBe("server unavailable");
    }
  });

  it("uses a bounded message for opaque delegated failures", async () => {
    const result = await runMiniLilac(["server"], {
      tui: async () => 0,
      server: async () => Promise.reject({ secret: "not for display" }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toBe("Mini Lilac command failed");
      expect(result.error.message).not.toContain("secret");
    }
  });

  it("returns help output failures as typed errors", async () => {
    const result = await runMiniLilac(["--help"], testRunners([]), () => {
      throw new Error("stdout closed");
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.command).toBe("cli");
      expect(result.error.message).toBe("stdout closed");
    }
  });

  it("preserves Panic from delegated commands", async () => {
    const panic = new Panic({ message: "runner invariant" });
    const runners: MiniLilacCommandRunners = {
      tui: async () => {
        throw panic;
      },
      server: async () => undefined,
    };

    await expect(runMiniLilac([], runners)).rejects.toBe(panic);
  });

  it("maps typed command failures to the existing process contract", async () => {
    let stderr = "";
    let exitCode: number | undefined;

    await runMiniLilacMain(
      ["server"],
      {
        tui: async () => 0,
        server: async () => {
          throw new Error("configuration missing");
        },
      },
      () => undefined,
      (text) => void (stderr += text),
      (code) => void (exitCode = code),
    );

    expect(stderr).toBe("configuration missing\n");
    expect(exitCode).toBe(1);
  });
});
