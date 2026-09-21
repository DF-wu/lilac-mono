import { Result, TaggedError } from "better-result";

export type NativePrincipal = {
  userId: string;
  providerUserId: string;
  provider: "local" | "clerk" | "operator";
  expiresAt: number;
  sessionId: string;
};

export class NativeAuthError extends TaggedError("NativeAuthError")<{
  code: "unauthorized" | "forbidden" | "expired" | "handshake" | "unavailable" | "rate_limited";
  message: string;
}> {}

export type NativeAuthContext = { socket?: boolean; mutation?: boolean };
export type NativeLogin = { principal: NativePrincipal; token: string; setCookie: string };

export interface NativeAuthenticator {
  checkSession(principal: NativePrincipal): Result<void, NativeAuthError>;
  authenticate(
    request: Request,
    context?: NativeAuthContext,
  ): Promise<Result<NativePrincipal, NativeAuthError>>;
  reauthenticate(
    current: NativePrincipal,
    request: Request,
  ): Promise<Result<NativePrincipal, NativeAuthError>>;
  logout(request: Request): Promise<Result<{ setCookie: string }, NativeAuthError>>;
}

export function authFailure(code: NativeAuthError["code"], message: string): NativeAuthError {
  return new NativeAuthError({ code, message });
}

export function checkNativeRequestOrigin(
  request: Request,
  allowedOrigins: readonly string[],
  context: NativeAuthContext = {},
): Result<void, NativeAuthError> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.includes(origin)) {
    return Result.err(authFailure("forbidden", "Request origin is not allowed"));
  }
  const headerCredential = request.headers.has("authorization");
  if ((context.socket || context.mutation) && !headerCredential && origin === null) {
    return Result.err(authFailure("forbidden", "Cookie requests require an allowed origin"));
  }
  return Result.ok();
}

export function sameNativePrincipal(
  current: NativePrincipal,
  fresh: NativePrincipal,
): Result<NativePrincipal, NativeAuthError> {
  if (
    current.userId !== fresh.userId ||
    current.providerUserId !== fresh.providerUserId ||
    current.provider !== fresh.provider
  ) {
    return Result.err(
      authFailure("forbidden", "Reauthentication cannot change connection identity"),
    );
  }
  return Result.ok(fresh);
}

export function nativeCookie(request: Request, name: string): string | undefined {
  const parts = request.headers.get("cookie")?.split(";") ?? [];
  return parts
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function nativeBearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice(7);
}

export function nativeSessionCookie(token: string, secure: boolean, maxAge: number): string {
  return `lilac_native_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
