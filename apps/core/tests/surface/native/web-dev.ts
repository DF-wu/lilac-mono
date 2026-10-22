import path from "node:path";
import { parseArgs } from "node:util";
import { browserFixtureParticipant, startNativeBrowserFixture } from "./browser-fixture";
import { startNativeClerkBrowserFixture } from "./clerk-browser-fixture";

const DEFAULT_WEB_PORT = 5173;
const DEFAULT_BACKEND_PORT = 8789;
const SIGN_IN_TICKET_SECONDS = 600;
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const webRoot = path.join(repoRoot, "apps/web");

const usage = `Usage: bun run dev:web [--replace] [--clerk] [--clerk-owner <user_id>]

Starts the deterministic native fixture and the web dev server, then prints the URL and login.

  --replace       Stop the dev servers on ports ${DEFAULT_WEB_PORT} and ${DEFAULT_BACKEND_PORT} and start there.
                  Without it, both servers start on free ports.
  --clerk         Use Clerk authentication. Reads the Clerk keys from apps/web/.env.local and prints a
                  single-use sign-in link.
  --clerk-owner   Clerk user ID of the owner. Defaults to TEST_NATIVE_CLERK_OWNER_ID, then to the
                  instance's only user.`;

const { values: flags } = parseArgs({
  options: {
    replace: { type: "boolean", default: false },
    clerk: { type: "boolean", default: false },
    "clerk-owner": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (flags.help) {
  console.info(usage);
  process.exit(0);
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

function listeners(port: number): number[] {
  const result = Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return result.stdout.toString().split("\n").filter(Boolean).map(Number);
}

function commandLine(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
    .stdout.toString()
    .trim();
}

function workingDirectory(pid: number): string {
  const output = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).stdout;
  return (
    output
      .toString()
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1) ?? ""
  );
}

function isRepoDevServer(pid: number): boolean {
  const command = commandLine(pid);
  if (!/vite|fixture|web-dev/.test(command)) return false;
  return command.includes(repoRoot) || workingDirectory(pid).startsWith(repoRoot);
}

function signal(pids: number[], name: "SIGTERM" | "SIGKILL") {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // The process already exited.
    }
  }
}

async function portsReleased(ports: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ports.some((port) => listeners(port).length > 0)) {
    if (Date.now() > deadline) return false;
    // test-wait-justification: the replaced servers are not child processes, so poll their ports.
    await Bun.sleep(100);
  }
  return true;
}

async function stopDevServers(ports: number[]) {
  const pids = [...new Set(ports.flatMap(listeners))];
  const foreign = pids.find((pid) => !isRepoDevServer(pid));
  if (foreign !== undefined)
    throw new Error(
      `Port held by a process that is not this repo's dev server (${foreign}: ${commandLine(foreign)}); not replacing it`,
    );
  signal(pids, "SIGTERM");
  if (await portsReleased(ports, 5000)) return;
  signal(pids, "SIGKILL");
  if (!(await portsReleased(ports, 2000)))
    throw new Error(`Ports ${ports.join(", ")} are still in use after stopping the dev servers`);
}

async function resolveClerkOwner(secretKey: string): Promise<string> {
  const configured = flags["clerk-owner"] ?? process.env.TEST_NATIVE_CLERK_OWNER_ID;
  if (configured) return configured;
  const response = await fetch("https://api.clerk.com/v1/users?limit=2", {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) throw new Error(`Clerk user lookup failed: ${response.status}`);
  const users = (await response.json()) as { id: string }[];
  if (users.length !== 1)
    throw new Error("The Clerk instance has several users; pass --clerk-owner <user_id>");
  return users[0]!.id;
}

async function clerkSignInTicket(secretKey: string, userId: string): Promise<string> {
  const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: SIGN_IN_TICKET_SECONDS }),
  });
  if (!response.ok) throw new Error(`Clerk sign-in ticket failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

async function startVite(port: number, backendUrl: string) {
  const vite = Bun.spawn(
    ["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: webRoot,
      env: { ...process.env, LILAC_WEB_BACKEND_URL: backendUrl },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const decoder = new TextDecoder();
  let output = "";
  const reader = vite.stdout.getReader();
  // Strip color codes so FORCE_COLOR output still matches.
  while (!Bun.stripANSI(output).includes("Local:")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Vite exited before it was ready:\n${output}`);
    output += decoder.decode(chunk.value);
  }
  void (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      process.stdout.write(chunk.value);
  })();
  return vite;
}

async function startBackend(port: number, webOrigins: string[]) {
  if (!flags.clerk) {
    const fixture = await startNativeBrowserFixture(undefined, { port, webOrigins });
    return {
      fixture,
      login: `${fixture.username} / ${fixture.password}; ${browserFixtureParticipant.username} / ${browserFixtureParticipant.password}`,
    };
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("Clerk mode needs CLERK_SECRET_KEY in apps/web/.env.local");
  // Create the ticket first so a Clerk API failure does not leave a running fixture behind.
  const ownerProviderUserId = await resolveClerkOwner(secretKey);
  const ticket = await clerkSignInTicket(secretKey, ownerProviderUserId);
  const fixture = await startNativeClerkBrowserFixture({ port, webOrigins, ownerProviderUserId });
  return {
    fixture,
    login: `open the sign-in link below (single use, expires in ${SIGN_IN_TICKET_SECONDS / 60} minutes)`,
    ticket,
  };
}

if (flags.replace) await stopDevServers([DEFAULT_WEB_PORT, DEFAULT_BACKEND_PORT]);
const webPort = flags.replace ? DEFAULT_WEB_PORT : freePort();
const backendPort = flags.replace ? DEFAULT_BACKEND_PORT : freePort();
// Clerk development instances expect the localhost host name.
const webUrl = `http://${flags.clerk ? "localhost" : "127.0.0.1"}:${webPort}/`;
const backend = await startBackend(backendPort, [
  `http://127.0.0.1:${webPort}`,
  `http://localhost:${webPort}`,
]);
const vite = await startVite(webPort, `http://127.0.0.1:${backendPort}`).catch(async (error) => {
  await backend.fixture.close();
  throw error;
});

let closing = false;
async function close(code: number) {
  if (closing) return;
  closing = true;
  vite.kill();
  await backend.fixture.close();
  process.exit(code);
}
process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
void vite.exited.then((code) => close(code || 1));

const threadLinks = Object.entries(backend.fixture.threads).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);
const lines = [
  "",
  `Lilac web dev server ready (${flags.clerk ? "Clerk" : "local"} auth)`,
  `  Web:      ${webUrl}`,
  `  Backend:  http://127.0.0.1:${backendPort}/`,
  `  Login:    ${backend.login}`,
  ...("ticket" in backend ? [`  Sign in:  ${webUrl}?__clerk_ticket=${backend.ticket}`] : []),
  ...threadLinks.map(
    ([name, id], index) =>
      `  ${index === 0 ? "Threads: " : "         "} ${name.padEnd(10)} ${webUrl}?thread=${encodeURIComponent(id)}`,
  ),
  `  Stop:     Ctrl-C or kill ${process.pid}`,
  "",
];
console.info(lines.join("\n"));
