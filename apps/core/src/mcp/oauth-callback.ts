import { errorMessage } from "@stanley2058/lilac-utils";

import { MCP_OAUTH_CALLBACK_URL, type McpOAuthProviderService } from "./oauth-provider";

const callbackUrl = new URL(MCP_OAUTH_CALLBACK_URL);

export type McpOAuthCallbackListenerStatus =
  | {
      readonly status: "listening";
      readonly hostname: string;
      readonly port: number;
    }
  | {
      readonly status: "unavailable";
      readonly hostname: string;
      readonly port: number;
      readonly error: string;
    };

export type McpOAuthCallbackControl = {
  start(): McpOAuthCallbackListenerStatus;
  getStatus(): McpOAuthCallbackListenerStatus;
};

export type McpOAuthCallbackServerFactory = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}) => {
  readonly port?: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
};

export class McpOAuthCallbackService {
  private readonly providers: McpOAuthProviderService;
  private readonly hostname: string;
  private readonly port: number;
  private readonly serverFactory: McpOAuthCallbackServerFactory;
  private server?: ReturnType<McpOAuthCallbackServerFactory>;
  private listenerStatus: McpOAuthCallbackListenerStatus;

  constructor(options: {
    readonly providers: McpOAuthProviderService;
    readonly hostname?: string;
    readonly port?: number;
    readonly serverFactory?: McpOAuthCallbackServerFactory;
  }) {
    this.providers = options.providers;
    this.hostname = options.hostname ?? callbackUrl.hostname;
    this.port = options.port ?? Number(callbackUrl.port);
    this.serverFactory = options.serverFactory ?? ((serveOptions) => Bun.serve(serveOptions));
    this.listenerStatus = {
      status: "unavailable",
      hostname: this.hostname,
      port: this.port,
      error: "OAuth callback listener has not started",
    };
  }

  start(): McpOAuthCallbackListenerStatus {
    if (this.server) return this.listenerStatus;

    try {
      this.server = this.serverFactory({
        hostname: this.hostname,
        port: this.port,
        fetch: (request) => this.handleRequest(request),
      });
      this.listenerStatus = {
        status: "listening",
        hostname: this.hostname,
        port: this.server.port ?? this.port,
      };
    } catch (error) {
      this.server = undefined;
      this.listenerStatus = {
        status: "unavailable",
        hostname: this.hostname,
        port: this.port,
        error: errorMessage(error),
      };
    }

    return this.listenerStatus;
  }

  getStatus(): McpOAuthCallbackListenerStatus {
    return this.listenerStatus;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    try {
      if (server) await server.stop(true);
    } finally {
      this.listenerStatus = {
        status: "unavailable",
        hostname: this.hostname,
        port: this.port,
        error: "OAuth callback listener is stopped",
      };
    }
  }

  async handleRequest(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed.\n", {
        status: 405,
        headers: { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== callbackUrl.pathname) return new Response("Not found.\n", { status: 404 });

    const codes = url.searchParams.getAll("code");
    const states = url.searchParams.getAll("state");
    if (
      url.searchParams.has("error") ||
      codes.length !== 1 ||
      states.length !== 1 ||
      !codes[0] ||
      !states[0]
    ) {
      return invalidCallbackResponse();
    }

    const provider = this.providers.getProviderForState(states[0]);
    if (!provider) return invalidCallbackResponse();

    const completed = await provider.completeAuthorizationResult(codes[0], states[0]);
    return completed.match({
      ok: () =>
        new Response("OAuth authorization completed.\n", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      err: () =>
        new Response("OAuth authorization failed.\n", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    });
  }
}

function invalidCallbackResponse(): Response {
  return new Response("Invalid OAuth callback.\n", {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
