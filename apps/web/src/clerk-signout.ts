import { Result } from "better-result";

let registration: { signOut: () => Promise<void>; completed: boolean } | undefined;

export function registerClerkSignOut(signOut: () => Promise<void>): void {
  // Private UI unmounts on local or cross-tab logout. Retain this operation for retries until a new provider registers.
  registration = { signOut, completed: false };
}

export async function signOutActiveClerk(): Promise<Result<void, Error>> {
  const current = registration;
  if (!current)
    return Result.err(new Error("Account controls are unavailable. Reload to finish signing out."));
  if (current.completed) return Result.ok();
  const result = await Result.tryPromise({
    try: current.signOut,
    catch: () => new Error("Could not sign out of Clerk. Try again."),
  });
  current.completed = result.match({ ok: () => true, err: () => false });
  return result;
}
