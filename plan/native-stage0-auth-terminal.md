# Native Stage 0: authentication and terminal evidence

Date: 2026-09-19. Companion to `native-surface.md`. This records implementation choices and proof limits without changing the approved product scope. No provider account was created, no real user was authenticated, and no dependencies were added during this research.

## Result

Clerk supports the required browser and terminal identity flows. Use its browser SDK and Backend SDK for the SPA, and Authorization Code with PKCE plus a loopback callback for the TUI. The fixed local owner can use Bun's password verifier and a finite authenticated session. OpenTUI/Solid supports the selected runtime and local image clipboard input. Neither Clerk's normal loopback flow nor host clipboard reads automatically cross an SSH connection.

## Verified package inputs

The npm registry returned these versions and peer requirements on the research date. Pin selected direct versions when their implementation stage installs them; this table is evidence, not a dependency change.

| Package | Version | Use or constraint |
| --- | --- | --- |
| `@clerk/backend` | `3.18.1` | Core request/token verification and provider user lookup. |
| `@clerk/react` | `6.16.1` | Web sign-in and browser session maintenance. React 19 peers include `~19.2.3`. |
| `@opentui/core` | `0.5.11` | Terminal renderer and clipboard. Bun minimum is 1.3.0. |
| `@opentui/solid` | `0.5.11` | Terminal components and Bun preload. |
| `solid-js` | `1.9.12` | Exact OpenTUI peer, not the newer `1.9.15` latest release. |
| `web-tree-sitter` | `0.25.10` | Exact Core peer, even though MVP output does not use rich rendering. |
| `oauth4webapi` | `3.8.8` | Candidate maintained standards client for TUI PKCE/refresh. Not yet selected or exercised. |
| `jose` | `6.2.12` | Candidate maintained local session-token primitive. Not yet selected or exercised. |

Registry evidence used the public `/latest` endpoints for each package. Clerk's React quickstart uses `@clerk/react`; do not copy the previous `@clerk/clerk-react` package name from older examples. [React quickstart](https://clerk.com/docs/react/getting-started/quickstart).

## Clerk browser and gateway

Use `createClerkClient` from `@clerk/backend` in the native authentication adapter. Verify the incoming `Request` directly using `authenticateRequest`, with the configured publishable key, installation issuer/key material, and allowed browser origins. The same-origin SPA can send the existing `__session` cookie with bootstrap and WebSocket upgrade. Cached keys or configured `jwtKey` avoid a provider network request for each valid JWT. [Manual verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification).

Accept only session tokens and the installation's configured public OAuth application's user access tokens. Do not accept arbitrary API keys or service machine tokens as native people. OAuth access tokens need the explicit `oauth_token` path; the Backend SDK defaults to session tokens. Never authorize API requests with an OIDC ID token. [OAuth verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens).

Resolve the verified provider identity to the native user. Check the configured public OAuth client identity when normalizing TUI tokens. Do not infer the owner from the first successful authentication, email matching, or a client-supplied native user ID. Clerk's OAuth auth object differs from its browser-session auth object; normalize these variants inside the adapter before passing a native principal to the gateway. [Auth object](https://clerk.com/docs/reference/backend/types/auth-object).

The SDK can return `signed-in`, `signed-out`, or `handshake`. Preserve that distinction in the adapter. A handshake requires Clerk's refresh flow; a provider/network failure is not evidence of logout. Bootstrap may return data immediately with a valid token, but cannot promise this after every idle period. Do not give private data to an expired credential while refresh runs. The refresh/login view can load Clerk UI separately from the cached application shell. [Request authentication](https://clerk.com/docs/reference/backend/authenticate-request).

Clerk documents a one-minute session token lifetime. Browser session maintenance therefore remains necessary while a socket stays open. This is the existing plan's authentication-refresh exception to the no-waterfall target, not a reason to put normal list/thread loading behind the Clerk UI bundle. [Session object](https://clerk.com/docs/js-frontend/reference/objects/session).

For no registration, configure the installation's Clerk access mode as Invite-only, whose API value is `restricted`, and provision existing users administratively. Lilac renders sign-in only and adds no invitation, signup, or onboarding workflow. Owner sharing selects existing provider/native identities. Do not enable organization enrollment or required profile-completion tasks as part of installation. [Clerk access modes](https://clerk.com/docs/guides/secure/restricting-access).

## Clerk TUI login

Clerk's official Bun-compatible reference proves a public OAuth application can use `S256` PKCE and a one-shot loopback callback. Register `http://127.0.0.1/callback`, with public-client and required-PKCE enabled. Bind only loopback on an ephemeral port, generate state and verifier for that attempt, open the authorize URL, validate callback state, and exchange the code with the same redirect URI and verifier. There is no embedded client secret. The reference is inspectable example code, not a supported `@clerk/cli-auth` product dependency. [Clerk CLI reference](https://github.com/clerk/cli-auth-example).

Store refresh credentials separately from conversation cache, preferably in the OS credential store. Refresh access tokens before expiry, serialize refresh attempts, and replace returned credentials atomically. Logout clears local credentials/cache and uses the provider's revocation operation where supported. Do not copy the example's limitation of local-only logout without documenting it. Access tokens and refresh credentials never appear in URLs, debug output, app-shell caches, or transcript state.

For MVP, use JWT access tokens to keep ordinary verification local. Verification alone does not provide immediate upstream revocation before JWT expiry. Native membership and tool-mode revocations still apply immediately because the gateway rechecks native authority. Provider token lifetimes and refresh behavior come from the token response, not constants. Clerk also supports opaque tokens, which need remote verification; do not silently change to them and retain a networkless-performance claim. [Clerk OAuth behavior](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).

Device Authorization Grant cannot be the universal fallback: Clerk's current main OAuth guide labels it beta requiring account enablement. Use it only when the installation advertises the device endpoint and enables the grant. A headless/SSH user without that feature can run the TUI on the local workstation against the remote backend, use the installation's local provider, or explicitly arrange the loopback callback tunnel. Do not invent an unverified token-paste or browser-to-terminal exchange protocol. [Device grant](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant).

## Local provider and session boundary

The local installation has one configured owner. Keep its username, password hash and session signing material outside the editable Core/MCP documents. `POST` to the local login endpoint carries Basic credentials over HTTPS, with the usual local loopback development exception. Validate the fixed username and use async `Bun.password.verify` against an Argon2id hash. Bound attempts before starting expensive password work. There is no user creation, enrollment, password reset or Clerk startup request.

Bun's verifier runs asynchronously rather than blocking the main event loop. A direct Bun 1.4.2 fixture confirmed the correct password verifies, the wrong password is rejected, and the runtime supplies 32-byte cryptographic randomness. This proves the primitive works in the repository runtime, not the complete HTTP/session implementation. [Bun password API](https://bun.sh/reference/bun/password).

Use a maintained session-token primitive at the auth adapter, with a finite expiry, installation audience and fixed owner subject. A browser receives a host-only `HttpOnly` session cookie, `Secure` on HTTPS and an appropriate `SameSite` policy. A TUI keeps the returned session credential in its credential store and sends it as a header. Define logout/revocation behavior in the auth implementation and tests rather than treating removal of a browser cookie as server-side invalidation. Do not persist the Basic password for routine reconnects.

Local and Clerk paths normalize to the same authenticated principal plus expiry. The gateway never accepts Basic credentials on every RPC or in a WebSocket URL. The local provider must remain functional without importing or contacting Clerk during startup.

## WebSocket, resources and expiry

These are implementation requirements derived from the approved shared transport and authority model:

- Authenticate the initial WebSocket upgrade, then bind its principal. Check browser `Origin` independently from token signature verification. Native non-browser clients use the header-capable Bun WebSocket path; they do not require a credential query parameter.
- Before credential expiry, authenticate a fresh credential through a typed connection-auth procedure, verify it maps to the same principal, and update the deadline. If it expires, stop private output and close the socket. Reconnection uses the committed replay cursor. Credential refresh does not cancel an already admitted run.
- Reject a reauthentication attempt that swaps users on an existing connection. Login/logout changes clear private client state and establish a new connection.
- Enforce current user membership on every native RPC and content stream. Revocation removes subscriptions, including background hydration. Socket authentication is not permanent thread authorization.
- HTTP resources use the same auth adapter and check current origin-thread visibility. Cookies permit browser image/resource elements to work without putting a token in the URL. TUI HTTP requests use the session/access-token header. Do not turn the origin-thread rule into a public bearer resource URL.
- The UI can show pending uploads immediately, but upload completion and URI binding must still be authenticated. A credential expiry during transfer becomes a resumable/retryable attachment error; it never makes unresolved bytes eligible for model input.
- Mutating cookie-authenticated HTTP routes require same-origin/CSRF handling. Authentication failures do not enter service-worker private caches.

## OpenTUI proof and limits

Use Bun, `@opentui/solid/preload`, and a TUI-local TypeScript configuration with preserved JSX and `jsxImportSource: "@opentui/solid"`. `usePaste` handles terminal paste events; the renderer's input components and Solid signals provide the composer/viewport primitives. Keep the shared native client independent of Solid. [Solid bindings](https://opentui.com/docs/bindings/solid/).

OpenTUI publishes native artifacts for the common macOS/Linux/Windows targets. Linux glibc and musl have separate packages; preserve optional native dependencies. Standalone Bun packaging must include the native library and any required runtime assets. A package artifact alone does not prove every platform works. Stage 3 must run the compiled installer/TUI path on supported release targets. [Runtime support](https://opentui.com/docs/getting-started/runtime-support/).

The clipboard API distinguishes host reads from terminal paste. Host reads can obtain image bytes on local macOS, Linux Wayland/X11 and Windows, subject to supported MIME types. OSC52 writes the terminal user's clipboard; it is not an image-read bridge from a remote shell. Over SSH, host clipboard access addresses the remote machine. Pasted terminal text or paths still work when the terminal sends them. Local image clipboard input is feasible; remote image paste is not proven by these APIs. [Clipboard API](https://opentui.com/docs/core-concepts/clipboard/).

## Remaining verification

There is no architectural blocker to starting the backend. These checks remain before their stage can close:

1. Run Backend SDK verification and local session tests with signed fixtures, including wrong issuer/client, expiry, unauthorized origin, handshake, unavailable provider, logout and socket reauthentication.
2. Exercise a real configured Clerk installation for browser sign-in, public-client PKCE, refresh and logout. No Clerk credentials were available to this subtask. Stub tests cannot certify Dashboard configuration or hosted redirect behavior.
3. Confirm the selected OAuth JWT verification exposes the user and configured client identity needed by the native normalization boundary. Keep user tokens distinct from organization or service principals.
4. Run OpenTUI clipboard/input smoke checks in actual Ghostty/Kitty desktop sessions and the packaged executable. This subtask checked documentation and exact peer requirements, not an interactive renderer.
5. Document the supported remote-terminal limits. If seamless Clerk login or local image clipboard reads from an arbitrary SSH session become mandatory, they require a supported provider/device or terminal transport beyond the proven baseline.

## Stage 2 implementation evidence

Backend auth boundary tests and browser Clerk session checks are now recorded in
[native-surface-progress.md](native-surface-progress.md). The live development installation passed
owner sign-in through a single-use ticket, session refresh, authenticated resources and logout.
Public-client PKCE and actual Ghostty/Kitty checks belong to the unstarted TUI stage and remain unverified.
