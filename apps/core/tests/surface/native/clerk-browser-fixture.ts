import { createNativeIntegrationFixture } from "./integration-fixture";

export async function startNativeClerkBrowserFixture() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY;
  const ownerProviderUserId = process.env.TEST_NATIVE_CLERK_OWNER_ID;
  if (!secretKey || !publishableKey || !ownerProviderUserId) {
    throw new Error("Clerk fixture requires runtime Clerk keys and TEST_NATIVE_CLERK_OWNER_ID");
  }
  const frontendHost = Buffer.from(publishableKey.split("_").slice(2).join("_"), "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(frontendHost))
    throw new Error("Clerk fixture publishable key is invalid");
  const port = Number(process.env.TEST_NATIVE_CLERK_PORT ?? 8789);
  let threadId = "";
  const fixture = await createNativeIntegrationFixture({
    port,
    allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    installationSecrets: { clerkSecretKey: secretKey, clerkPublishableKey: publishableKey },
    publishableKey,
    prepare: async ({ config }) => {
      config.surface.native.installationId = "native-clerk-browser-fixture";
      config.surface.native.publicUrl = `http://localhost:${port}`;
      config.surface.native.auth = {
        provider: "clerk",
        ownerId: "owner",
        ownerProviderUserId,
        clerkIssuer: `https://${frontendHost}`,
        ...(process.env.TEST_NATIVE_CLERK_OAUTH_CLIENT_ID
          ? { clerkOAuthClientId: process.env.TEST_NATIVE_CLERK_OAUTH_CLIENT_ID }
          : {}),
      };
    },
    seed: (store) => {
      threadId = store
        .createThread("owner", { commandId: "clerk-browser-thread", title: "Clerk session check" })
        .unwrap().id;
    },
  });
  return {
    ...fixture,
    browserUrl: `http://localhost:${port}/?thread=${encodeURIComponent(threadId)}`,
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
