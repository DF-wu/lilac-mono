import { randomBytes } from "node:crypto";
import { credential, currentString, validatedText, validateHttpUrl } from "./optional-input";
import { setSetupSecret } from "./setup-draft";
import type { Prompt, SetupDraft } from "./types";

function validateOrigin(value: string): string | undefined {
  const invalid = validateHttpUrl(value);
  if (invalid) return invalid;
  const url = new URL(value);
  if (url.origin !== value) return "Enter an origin without a path or trailing slash.";
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "Use HTTPS for a remote installation, or HTTP on localhost.";
  }
  return undefined;
}

async function configureLocal(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const username = await validatedText(
    prompt,
    "Local owner username",
    draft.secrets.LILAC_NATIVE_LOCAL_USERNAME ?? "owner",
    (value) => (value.includes(":") ? "The username cannot contain a colon." : undefined),
  );
  const password = await prompt.text({
    message: "Local owner password",
    secret: true,
    required: true,
  });
  setSetupSecret(draft, "LILAC_NATIVE_LOCAL_USERNAME", username);
  setSetupSecret(
    draft,
    "LILAC_NATIVE_LOCAL_PASSWORD_HASH",
    await Bun.password.hash(password, { algorithm: "argon2id" }),
  );
  setSetupSecret(draft, "LILAC_NATIVE_SESSION_SECRET", randomBytes(32).toString("base64url"));
  prompt.note("Local authentication has one owner. The password is stored as an Argon2id hash.");
}

async function configureClerk(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const owner = await prompt.text({ message: "Clerk owner user ID", required: true });
  const issuer = await validatedText(prompt, "Clerk issuer URL", "", (value) => {
    const invalid = validateOrigin(value);
    if (invalid) return invalid;
    return value.startsWith("https://") ? undefined : "Clerk requires an HTTPS issuer.";
  });
  draft.set(["surface", "native", "auth", "ownerProviderUserId"], owner);
  draft.set(["surface", "native", "auth", "clerkIssuer"], issuer);
  await credential(prompt, draft, "CLERK_SECRET_KEY", "Clerk secret key");
  await credential(prompt, draft, "CLERK_PUBLISHABLE_KEY", "Clerk publishable key");
}

export async function configureNative(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const provider = await prompt.select(
    "Native sign-in",
    [
      { value: "local", label: "Local owner account" },
      { value: "clerk", label: "Clerk" },
    ],
    "local",
  );
  const publicUrl = await validatedText(
    prompt,
    "Native web URL",
    "http://localhost:8789",
    validateOrigin,
  );
  draft.set(["surface", "native", "enabled"], true);
  draft.set(
    ["surface", "native", "installationId"],
    currentString(draft, ["surface", "native", "installationId"], crypto.randomUUID()),
  );
  draft.set(["surface", "native", "host"], "0.0.0.0");
  draft.set(["surface", "native", "port"], 8789);
  draft.set(["surface", "native", "publicUrl"], publicUrl);
  draft.set(["surface", "native", "allowedOrigins"], [publicUrl]);
  draft.set(["surface", "native", "auth", "provider"], provider);
  draft.set(["surface", "native", "auth", "ownerId"], "owner");
  if (provider === "local") await configureLocal(prompt, draft);
  else await configureClerk(prompt, draft);
  prompt.note(
    "The gateway is published on 127.0.0.1:8789. For remote access, forward it through HTTPS or an SSH tunnel.",
  );
}
