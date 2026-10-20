import { startNativeBrowserFixture } from "./browser-fixture";

export async function startNativeClerkBrowserFixture(
  options: { port?: number; webOrigins?: string[]; ownerProviderUserId?: string } = {},
) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY;
  const ownerProviderUserId = options.ownerProviderUserId ?? process.env.TEST_NATIVE_CLERK_OWNER_ID;
  if (!secretKey || !publishableKey || !ownerProviderUserId) {
    throw new Error("Clerk fixture requires runtime Clerk keys and TEST_NATIVE_CLERK_OWNER_ID");
  }
  const frontendHost = Buffer.from(publishableKey.split("_").slice(2).join("_"), "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(frontendHost))
    throw new Error("Clerk fixture publishable key is invalid");
  const port = options.port ?? Number(process.env.TEST_NATIVE_CLERK_PORT ?? 8789);
  const fixture = await startNativeBrowserFixture(undefined, {
    port,
    webOrigins: options.webOrigins,
    clerk: {
      secretKey,
      publishableKey,
      issuer: `https://${frontendHost}`,
      ownerProviderUserId,
      oauthClientId: process.env.TEST_NATIVE_CLERK_OAUTH_CLIENT_ID,
    },
  });
  return {
    ...fixture,
    browserUrl: `http://localhost:${port}/?thread=${encodeURIComponent(fixture.threads.rich)}`,
  };
}

if (import.meta.main) {
  const fixture = await startNativeClerkBrowserFixture();
  console.info(
    JSON.stringify({
      kind: "native-clerk-browser-fixture-ready",
      url: fixture.browserUrl,
      provider: "clerk",
    }),
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void fixture.close().then(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
