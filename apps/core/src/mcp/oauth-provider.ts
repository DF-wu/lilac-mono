import { randomBytes } from "node:crypto";

import {
  auth,
  UnauthorizedError,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";

import {
  readMcpOAuthCredentialFile,
  updateMcpOAuthCredentialFile,
  type McpOAuthCredential,
} from "./credential-file";
import {
  type McpAuthorizationCodeAuth,
  type McpServerDefinition,
  type UniversalMcpConfig,
} from "./config-types";
import { resolveMcpValueSource, type McpValueResolutionContext } from "./value-source";

export const MCP_OAUTH_CALLBACK_URL = "http://localhost:1456/mcp/oauth/callback";
const MAX_PENDING_AUTHORIZATIONS = 32;
const PENDING_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

type OAuthFetchFunction = NonNullable<Parameters<typeof auth>[1]["fetchFn"]>;

type PendingAuthorization = {
  readonly state: string;
  readonly createdAt: number;
  status: "starting" | "pending" | "completing";
  codeVerifier?: string;
  authorizationUrl?: string;
};

export type McpOAuthStartResult =
  | { readonly status: "authorized" }
  | {
      readonly status: "authorization_required";
      readonly authorizationUrl: string;
      readonly callbackUrl: string;
    };

export class McpOAuthProviderError extends Error {
  constructor(
    readonly serverId: string,
    operation: "start" | "complete" | "credentials",
  ) {
    const action =
      operation === "start"
        ? "start MCP OAuth authorization"
        : operation === "complete"
          ? "complete MCP OAuth authorization"
          : "load MCP OAuth client credentials";
    super(`Could not ${action} for server ${JSON.stringify(serverId)}`);
    this.name = "McpOAuthProviderError";
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;

  private readonly authConfig: McpAuthorizationCodeAuth;
  private readonly dataDir: string;
  private readonly valueContext: McpValueResolutionContext;
  private readonly fetchFn?: OAuthFetchFunction;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(options: {
    readonly serverId: string;
    readonly serverUrl: string;
    readonly authConfig: McpAuthorizationCodeAuth;
    readonly dataDir: string;
    readonly valueContext: McpValueResolutionContext;
    readonly fetchFn?: OAuthFetchFunction;
    readonly now?: () => number;
  }) {
    this.serverId = options.serverId;
    this.serverUrl = options.serverUrl;
    this.authConfig = options.authConfig;
    this.dataDir = options.dataDir;
    this.valueContext = options.valueContext;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
    this.redirectUrl = MCP_OAUTH_CALLBACK_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Lilac Core",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        this.authConfig.client.type === "static" && this.authConfig.client.clientSecret
          ? "client_secret_post"
          : "none",
      ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readCredential())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updateCredential((credential) => ({ ...credential, tokens }));
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "verifier") return;
    await this.updateCredential((credential) => this.invalidateCredential(credential, scope));
  }

  redirectToAuthorization(_authorizationUrl: URL): void {
    this.rejectImplicitAuthorization();
  }

  saveCodeVerifier(_codeVerifier: string): void {
    this.rejectImplicitAuthorization();
  }

  codeVerifier(): string {
    return this.rejectImplicitAuthorization();
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const information = await this.clientInformationForAuthorization();
    if (this.authConfig.client.type === "dynamic" && information === undefined) {
      throw new UnauthorizedError("Interactive MCP authorization requires explicit mcp.auth");
    }
    return information;
  }

  async saveClientInformation(_clientInformation: OAuthClientInformation): Promise<void> {
    this.rejectImplicitAuthorization();
  }

  private async clientInformationForAuthorization(): Promise<OAuthClientInformation | undefined> {
    if (this.authConfig.client.type === "dynamic") {
      const information = (await this.readCredential())?.clientInformation;
      if (
        information?.client_secret_expires_at !== undefined &&
        information.client_secret_expires_at !== 0 &&
        information.client_secret_expires_at <= this.now() / 1000
      ) {
        return undefined;
      }
      return information;
    }

    const clientId = await resolveMcpValueSource(
      this.authConfig.client.clientId,
      this.valueContext,
    );
    if (!clientId.ok) throw new McpOAuthProviderError(this.serverId, "credentials");
    if (this.authConfig.client.clientSecret === undefined) return { client_id: clientId.value };

    const clientSecret = await resolveMcpValueSource(
      this.authConfig.client.clientSecret,
      this.valueContext,
    );
    if (!clientSecret.ok) throw new McpOAuthProviderError(this.serverId, "credentials");
    return { client_id: clientId.value, client_secret: clientSecret.value };
  }

  async authorizationServerInformation(): Promise<OAuthAuthorizationServerInformation | undefined> {
    return (await this.readCredential())?.authorizationServerInformation;
  }

  async saveAuthorizationServerInformation(
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    await this.updateCredential((credential) => ({
      ...credential,
      authorizationServerInformation,
    }));
  }

  state(): string {
    return this.rejectImplicitAuthorization();
  }

  saveState(_state: string): void {
    this.rejectImplicitAuthorization();
  }

  storedState(): string | undefined {
    return undefined;
  }

  hasPendingState(state: string): boolean {
    this.pruneExpiredPending();
    return this.pending.has(state);
  }

  discardPendingAuthorizations(): void {
    this.pending.clear();
  }

  async startAuthorization(): Promise<McpOAuthStartResult> {
    const pending = this.createPendingAuthorization();
    try {
      const result = await auth(this.providerForAttempt(pending), {
        serverUrl: this.serverUrl,
        ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      if (result === "AUTHORIZED") {
        this.deletePending(pending);
        return { status: "authorized" };
      }

      const authorizationUrl = pending.authorizationUrl;
      if (!authorizationUrl || !pending.codeVerifier || !this.isActive(pending)) {
        throw new McpOAuthProviderError(this.serverId, "start");
      }
      pending.authorizationUrl = undefined;
      pending.status = "pending";
      return {
        status: "authorization_required",
        authorizationUrl,
        callbackUrl: this.redirectUrl,
      };
    } catch {
      this.deletePending(pending);
      throw new McpOAuthProviderError(this.serverId, "start");
    }
  }

  async completeAuthorization(authorizationCode: string, callbackState: string): Promise<void> {
    this.pruneExpiredPending();
    const pending = this.pending.get(callbackState);
    if (!pending || pending.status !== "pending" || authorizationCode.length === 0) {
      throw new McpOAuthProviderError(this.serverId, "complete");
    }

    pending.status = "completing";
    try {
      const result = await auth(this.providerForAttempt(pending), {
        serverUrl: this.serverUrl,
        authorizationCode,
        callbackState,
        ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      if (result !== "AUTHORIZED") throw new McpOAuthProviderError(this.serverId, "complete");
      this.deletePending(pending);
    } catch {
      if (this.isActive(pending)) pending.status = "pending";
      throw new McpOAuthProviderError(this.serverId, "complete");
    }
  }

  private createPendingAuthorization(): PendingAuthorization {
    this.pruneExpiredPending();
    if (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      for (const [state, pending] of this.pending) {
        if (pending.status !== "pending") continue;
        this.pending.delete(state);
        break;
      }
    }
    if (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      throw new McpOAuthProviderError(this.serverId, "start");
    }

    let state: string;
    do {
      state = randomBytes(32).toString("hex");
    } while (this.pending.has(state));
    const pending: PendingAuthorization = { state, createdAt: this.now(), status: "starting" };
    this.pending.set(state, pending);
    return pending;
  }

  private providerForAttempt(pending: PendingAuthorization): OAuthClientProvider {
    const attemptProvider = {
      redirectUrl: this.redirectUrl,
      clientMetadata: this.clientMetadata,
      tokens: () => this.tokens(),
      saveTokens: async (tokens: OAuthTokens) => {
        this.assertActive(pending, "complete");
        await this.updateCredentialForAttempt(pending, "complete", (credential) => ({
          ...credential,
          tokens,
        }));
      },
      invalidateCredentials: async (scope: "all" | "client" | "tokens" | "verifier") => {
        this.assertActive(pending, "complete");
        if (scope === "verifier") return;
        await this.updateCredentialForAttempt(pending, "complete", (credential) =>
          this.invalidateCredential(credential, scope),
        );
      },
      redirectToAuthorization: (authorizationUrl: URL) => {
        this.assertActive(pending, "start");
        if (
          pending.authorizationUrl !== undefined ||
          authorizationUrl.searchParams.get("state") !== pending.state
        ) {
          throw new McpOAuthProviderError(this.serverId, "start");
        }
        pending.authorizationUrl = authorizationUrl.href;
      },
      saveCodeVerifier: (codeVerifier: string) => {
        this.assertActive(pending, "start");
        pending.codeVerifier = codeVerifier;
      },
      codeVerifier: () => {
        this.assertActive(pending, "complete");
        if (!pending.codeVerifier) {
          throw new McpOAuthProviderError(this.serverId, "complete");
        }
        return pending.codeVerifier;
      },
      clientInformation: () => this.clientInformationForAuthorization(),
      saveClientInformation: async (clientInformation: OAuthClientInformation) => {
        this.assertActive(pending, "start");
        await this.updateCredentialForAttempt(pending, "start", (credential) => ({
          ...credential,
          clientInformation,
        }));
      },
      authorizationServerInformation: () => this.authorizationServerInformation(),
      saveAuthorizationServerInformation: async (
        authorizationServerInformation: OAuthAuthorizationServerInformation,
      ) => {
        this.assertActive(pending, "start");
        await this.updateCredentialForAttempt(pending, "start", (credential) => ({
          ...credential,
          authorizationServerInformation,
        }));
      },
      state: () => pending.state,
      saveState: (state: string) => {
        this.assertActive(pending, "start");
        if (state !== pending.state) {
          throw new McpOAuthProviderError(this.serverId, "start");
        }
      },
      storedState: () => pending.state,
    };
    return attemptProvider;
  }

  private isActive(pending: PendingAuthorization): boolean {
    if (this.pending.get(pending.state) !== pending) return false;
    if (pending.createdAt + PENDING_AUTHORIZATION_TTL_MS > this.now()) return true;
    this.pending.delete(pending.state);
    return false;
  }

  private assertActive(pending: PendingAuthorization, operation: "start" | "complete"): void {
    if (!this.isActive(pending)) throw new McpOAuthProviderError(this.serverId, operation);
  }

  private deletePending(pending: PendingAuthorization): void {
    if (this.isActive(pending)) this.pending.delete(pending.state);
  }

  private pruneExpiredPending(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.createdAt + PENDING_AUTHORIZATION_TTL_MS <= now) this.pending.delete(state);
    }
  }

  private rejectImplicitAuthorization(): never {
    throw new UnauthorizedError("Interactive MCP authorization requires explicit mcp.auth");
  }

  private async readCredential(): Promise<McpOAuthCredential | undefined> {
    const credential = await readMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
    });
    return credential?.serverUrl === this.serverUrl ? credential : undefined;
  }

  private async updateCredential(
    update: (credential: McpOAuthCredential) => McpOAuthCredential,
  ): Promise<void> {
    await updateMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
      serverUrl: this.serverUrl,
      update,
    });
  }

  private async updateCredentialForAttempt(
    pending: PendingAuthorization,
    operation: "start" | "complete",
    update: (credential: McpOAuthCredential) => McpOAuthCredential,
  ): Promise<void> {
    await updateMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
      serverUrl: this.serverUrl,
      update: (credential) => {
        this.assertActive(pending, operation);
        return update(credential);
      },
    });
  }

  private invalidateCredential(
    credential: McpOAuthCredential,
    scope: "all" | "client" | "tokens",
  ): McpOAuthCredential {
    const { clientInformation, tokens, ...retained } = credential;
    if (scope === "tokens") {
      return clientInformation ? { ...retained, clientInformation } : retained;
    }
    if (scope === "client") return tokens ? { ...retained, tokens } : retained;
    return retained;
  }
}

type ProviderEntry = {
  readonly fingerprint: string;
  readonly provider: McpOAuthProvider;
};

export class McpOAuthProviderService {
  private readonly dataDir: string;
  private readonly valueContext: McpValueResolutionContext;
  private readonly fetchFn?: OAuthFetchFunction;
  private readonly now: () => number;
  private readonly providers = new Map<string, ProviderEntry>();

  constructor(options: {
    readonly dataDir: string;
    readonly configBaseDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetchFn?: OAuthFetchFunction;
    readonly now?: () => number;
  }) {
    this.dataDir = options.dataDir;
    this.valueContext = {
      baseDir: options.configBaseDir ?? options.dataDir,
      env: options.env ?? process.env,
    };
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
  }

  reconcile(config: UniversalMcpConfig): void {
    const configured = new Set<string>();
    for (const definition of Object.values(config.servers)) {
      const oauth = authorizationCodeOAuthOptions(definition);
      if (!oauth) continue;
      configured.add(definition.id);
      const fingerprint = JSON.stringify([oauth.serverUrl, oauth.authConfig]);
      const existing = this.providers.get(definition.id);
      if (existing?.fingerprint === fingerprint) continue;
      existing?.provider.discardPendingAuthorizations();

      this.providers.set(definition.id, {
        fingerprint,
        provider: new McpOAuthProvider({
          serverId: definition.id,
          serverUrl: oauth.serverUrl,
          authConfig: oauth.authConfig,
          dataDir: this.dataDir,
          valueContext: this.valueContext,
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
          now: this.now,
        }),
      });
    }

    for (const serverId of this.providers.keys()) {
      if (configured.has(serverId)) continue;
      this.providers.get(serverId)?.provider.discardPendingAuthorizations();
      this.providers.delete(serverId);
    }
  }

  getProvider(serverId: string): OAuthClientProvider | undefined {
    return this.providers.get(serverId)?.provider;
  }

  getProviderForState(state: string): McpOAuthProvider | undefined {
    for (const entry of this.providers.values()) {
      if (entry.provider.hasPendingState(state)) return entry.provider;
    }
    return undefined;
  }

  async startAuthorization(serverId: string): Promise<McpOAuthStartResult> {
    const provider = this.providers.get(serverId)?.provider;
    if (!provider) throw new McpOAuthProviderError(serverId, "start");
    return await provider.startAuthorization();
  }
}

function authorizationCodeOAuthOptions(definition: McpServerDefinition):
  | {
      readonly serverUrl: string;
      readonly authConfig: McpAuthorizationCodeAuth;
    }
  | undefined {
  const transport = definition.transportConfig;
  if (transport.transport !== "http" || transport.auth?.grant !== "authorization_code") {
    return undefined;
  }
  return { serverUrl: transport.url, authConfig: transport.auth };
}
