import { randomBytes } from "node:crypto";

import {
  auth,
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

type OAuthFetchFunction = NonNullable<Parameters<typeof auth>[1]["fetchFn"]>;

type PendingAuthorization = {
  readonly state: string;
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
  private readonly pending = new Map<string, PendingAuthorization>();
  private implicitPending?: PendingAuthorization;

  constructor(options: {
    readonly serverId: string;
    readonly serverUrl: string;
    readonly authConfig: McpAuthorizationCodeAuth;
    readonly dataDir: string;
    readonly valueContext: McpValueResolutionContext;
    readonly fetchFn?: OAuthFetchFunction;
  }) {
    this.serverId = options.serverId;
    this.serverUrl = options.serverUrl;
    this.authConfig = options.authConfig;
    this.dataDir = options.dataDir;
    this.valueContext = options.valueContext;
    this.fetchFn = options.fetchFn;
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

  redirectToAuthorization(authorizationUrl: URL): void {
    const state = authorizationUrl.searchParams.get("state");
    const pending = state ? this.pending.get(state) : undefined;
    if (!pending || pending.authorizationUrl !== undefined) {
      throw new McpOAuthProviderError(this.serverId, "start");
    }
    pending.authorizationUrl = authorizationUrl.href;
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (!this.implicitPending || !this.isActive(this.implicitPending)) {
      throw new McpOAuthProviderError(this.serverId, "start");
    }
    this.implicitPending.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.implicitPending?.codeVerifier || !this.isActive(this.implicitPending)) {
      throw new McpOAuthProviderError(this.serverId, "complete");
    }
    return this.implicitPending.codeVerifier;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.authConfig.client.type === "dynamic") {
      const information = (await this.readCredential())?.clientInformation;
      if (
        information?.client_secret_expires_at !== undefined &&
        information.client_secret_expires_at <= Date.now() / 1000
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

  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    await this.updateCredential((credential) => ({ ...credential, clientInformation }));
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
    const pending = this.createPendingAuthorization();
    this.implicitPending = pending;
    return pending.state;
  }

  saveState(state: string): void {
    const pending = this.pending.get(state);
    if (!pending) {
      throw new McpOAuthProviderError(this.serverId, "start");
    }
    this.implicitPending = pending;
  }

  storedState(): string | undefined {
    return this.implicitPending && this.isActive(this.implicitPending)
      ? this.implicitPending.state
      : undefined;
  }

  hasPendingState(state: string): boolean {
    return this.pending.has(state);
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
    if (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      for (const [state, pending] of this.pending) {
        if (pending.status !== "pending") continue;
        this.pending.delete(state);
        if (this.implicitPending === pending) this.implicitPending = undefined;
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
    const pending: PendingAuthorization = { state, status: "starting" };
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
        await this.saveTokens(tokens);
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
      clientInformation: () => this.clientInformation(),
      saveClientInformation: (clientInformation: OAuthClientInformation) =>
        this.saveClientInformation(clientInformation),
      authorizationServerInformation: () => this.authorizationServerInformation(),
      saveAuthorizationServerInformation: (
        authorizationServerInformation: OAuthAuthorizationServerInformation,
      ) => this.saveAuthorizationServerInformation(authorizationServerInformation),
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
    return this.pending.get(pending.state) === pending;
  }

  private assertActive(pending: PendingAuthorization, operation: "start" | "complete"): void {
    if (!this.isActive(pending)) throw new McpOAuthProviderError(this.serverId, operation);
  }

  private deletePending(pending: PendingAuthorization): void {
    if (this.isActive(pending)) this.pending.delete(pending.state);
    if (this.implicitPending === pending) this.implicitPending = undefined;
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
}

type ProviderEntry = {
  readonly fingerprint: string;
  readonly provider: McpOAuthProvider;
};

export class McpOAuthProviderService {
  private readonly dataDir: string;
  private readonly valueContext: McpValueResolutionContext;
  private readonly fetchFn?: OAuthFetchFunction;
  private readonly providers = new Map<string, ProviderEntry>();

  constructor(options: {
    readonly dataDir: string;
    readonly configBaseDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetchFn?: OAuthFetchFunction;
  }) {
    this.dataDir = options.dataDir;
    this.valueContext = {
      baseDir: options.configBaseDir ?? options.dataDir,
      env: options.env ?? process.env,
    };
    this.fetchFn = options.fetchFn;
  }

  reconcile(config: UniversalMcpConfig): void {
    const configured = new Set<string>();
    for (const definition of Object.values(config.servers)) {
      const oauth = authorizationCodeOAuthOptions(definition);
      if (!oauth) continue;
      configured.add(definition.id);
      const fingerprint = JSON.stringify([oauth.serverUrl, oauth.authConfig]);
      if (this.providers.get(definition.id)?.fingerprint === fingerprint) continue;

      this.providers.set(definition.id, {
        fingerprint,
        provider: new McpOAuthProvider({
          serverId: definition.id,
          serverUrl: oauth.serverUrl,
          authConfig: oauth.authConfig,
          dataDir: this.dataDir,
          valueContext: this.valueContext,
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        }),
      });
    }

    for (const serverId of this.providers.keys()) {
      if (!configured.has(serverId)) this.providers.delete(serverId);
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
