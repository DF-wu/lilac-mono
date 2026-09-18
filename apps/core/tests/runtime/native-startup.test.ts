import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function docker(args: string[]): Promise<string> {
  const command = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (exit !== 0) throw new Error(`Isolated Redis fixture failed: ${stderr}`);
  return stdout.trim();
}

function reservePort(): number {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = listener.port;
  listener.stop(true);
  if (!port) throw new Error("Failed to reserve native listener port");
  return port;
}

test("full Core graph starts native-only with isolated Redis, authenticates, and closes every handle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-core-startup-"));
  const containerName = `lilac-native-smoke-${crypto.randomUUID()}`;
  let containerStarted = false;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await docker([
      "run",
      "--detach",
      "--rm",
      "--pull",
      "never",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::6379",
      "redis:7-alpine",
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
    containerStarted = true;
    const endpoint = await docker(["port", containerName, "6379/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Unexpected isolated Redis endpoint");
    const dataDir = path.join(directory, "data");
    const homeDir = path.join(directory, "home");
    const workspace = path.join(directory, "workspace");
    await Promise.all([mkdir(dataDir), mkdir(homeDir), mkdir(workspace)]);
    const port = reservePort();
    const origin = `http://127.0.0.1:${port}`;
    await writeFile(
      path.join(dataDir, "core-config.yaml"),
      JSON.stringify({
        configVersion: 2,
        models: {
          def: { smoke: { model: "openai/smoke" } },
          main: { model: "smoke" },
          fast: { model: "smoke" },
        },
        surface: {
          native: {
            enabled: true,
            installationId: "native-startup-smoke",
            host: "127.0.0.1",
            port,
            publicUrl: origin,
            allowedOrigins: [origin],
            auth: { provider: "local", ownerId: "owner" },
          },
        },
      }),
    );
    await writeFile(path.join(dataDir, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
    const passwordHash = await Bun.password.hash("startup-fixture-password", {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    });
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "fixtures/native-startup-child.ts"),
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: homeDir,
          TMPDIR: directory,
          DATA_DIR: dataDir,
          REDIS_URL: `redis://${endpoint}`,
          LILAC_WORKSPACE_DIR: workspace,
          LILAC_NATIVE_LOCAL_USERNAME: "owner",
          LILAC_NATIVE_LOCAL_PASSWORD_HASH: passwordHash,
          LILAC_NATIVE_SESSION_SECRET: "native-startup-test-session-key-of-at-least-32-bytes",
          NATIVE_SMOKE_ORIGIN: origin,
          LOG_LEVEL: "error",
          CLERK_TELEMETRY_DISABLED: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child?.kill(), 30_000);
    let stdout: string;
    let stderr: string;
    let exit: number;
    try {
      [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (exit !== 0) throw new Error(`Core startup smoke exited ${exit}: ${stderr}`);
    expect(exit).toBe(0);
    expect(stdout).toContain('"nativeSmoke":"complete"');
    expect(stdout).toContain('"discordCredentials":false');
    expect(stdout).toContain('"stopped":true');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    if (containerStarted) await docker(["rm", "--force", containerName]);
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
