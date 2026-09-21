import { createCoreRuntime } from "../../../src/runtime/create-core-runtime";
import { bootstrapReplySchema } from "@stanley2058/lilac-client-protocol";

const fatalErrors: Error[] = [];
const created = await createCoreRuntime({
  cwd: process.env.LILAC_WORKSPACE_DIR,
  toolServerPort: 0,
  subscriptionPrefix: `native-smoke-${crypto.randomUUID()}`,
  logLevel: "error",
  reportFatalError: (error) => fatalErrors.push(error),
});
if (created.kind === "panic") throw created.panic;
const runtime = created.result.unwrap();
try {
  const started = await runtime.start();
  if (started.kind === "panic") throw started.panic;
  started.result.unwrap();
  const origin = process.env.NATIVE_SMOKE_ORIGIN!;
  const unauthenticated = await fetch(`${origin}/api/bootstrap`);
  if (unauthenticated.status !== 401) throw new Error("Native bootstrap accepted anonymous access");
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa("owner:startup-fixture-password")}` },
  });
  if (!login.ok) throw new Error(`Native local login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Native local login did not issue a session cookie");
  const response = await fetch(`${origin}/api/bootstrap`, { headers: { cookie } });
  if (!response.ok) throw new Error(`Authenticated native bootstrap failed: ${response.status}`);
  const bootstrap = bootstrapReplySchema.parse(await response.json());
  if (bootstrap.viewer.role !== "owner") throw new Error("Native owner was not seeded");
  if (bootstrap.installationId !== "native-startup-smoke")
    throw new Error("Wrong native installation");
  if (
    bootstrap.catalog.kind !== "catalog" ||
    !bootstrap.catalog.catalog.models.some((model) => model.id === "smoke")
  )
    throw new Error("Native model catalog was not composed");
  if (!runtime.getBlobStore()) throw new Error("Core blob store was not started");
  if (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN)
    throw new Error("Discord credentials leaked into isolated smoke");
} finally {
  await runtime.stop();
}
if (fatalErrors.length) throw new AggregateError(fatalErrors, "Core reported a fatal error");
console.info(JSON.stringify({ nativeSmoke: "complete", discordCredentials: false, stopped: true }));
