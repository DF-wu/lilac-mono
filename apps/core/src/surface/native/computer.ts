import { captureError } from "../../shared/error-capture";
import { rethrowPanic } from "../../mcp/error-format";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { z } from "zod";
import type { McpRegistryApi } from "../../mcp/registry-types";
import { bindMcpToolToSession } from "../../mcp/session-context";
import { nativeFailure } from "./errors";
import type { NativeStore } from "./store";

const viewerSchema = z.object({
  isError: z.literal(false).optional(),
  structuredContent: z.discriminatedUnion("status", [
    z.object({ status: z.literal("absent") }),
    z.object({
      status: z.literal("ready"),
      generation: z.string().min(1).max(128),
      viewer_url: z
        .url()
        .max(8192)
        .refine((value) => /^https?:\/\//.test(value)),
      viewer_password: z.string().min(1).max(256),
      expires_at: z.iso.datetime(),
    }),
  ]),
});

export function decodeComputerViewer(
  value: unknown,
): Result<NativeRpcOutputs["computer"]["read"], Error> {
  const parsed = viewerSchema.safeParse(value);
  if (!parsed.success)
    return Result.err(nativeFailure("invalid", "Invalid computer viewer response"));
  const info = parsed.data.structuredContent;
  if (info.status === "absent") return Result.ok({ desktop: null });
  const url = new URL(info.viewer_url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/lilac-viewer.html"
  )
    return Result.err(nativeFailure("invalid", "Invalid computer viewer URL"));
  return Result.ok({
    desktop: {
      generation: info.generation,
      url: url.href,
      password: info.viewer_password,
      expiresAt: info.expires_at,
    },
  });
}

export class NativeComputer {
  constructor(
    private readonly store: Pick<NativeStore, "authorizeThread">,
    private readonly registry: Pick<McpRegistryApi, "getCatalogServers" | "getTools">,
  ) {}

  read(actorId: string, input: { threadId: string }, signal?: AbortSignal) {
    return Result.gen(async function* (this: NativeComputer) {
      // VNC credentials grant input access, so read-only thread grants cannot receive them.
      yield* this.store.authorizeThread(actorId, input.threadId, true);
      const server = this.registry
        .getCatalogServers()
        .find((item) => item.serverInfo.name === "lilac-computer-use");
      if (!server) return Result.ok({ desktop: null });
      const tool = this.registry
        .getTools()
        .find((item) => item.serverId === server.serverId && item.rawName === "viewer");
      if (!tool) return Result.ok({ desktop: null });
      const execute = bindMcpToolToSession(tool.tool, `native:${input.threadId}`).execute;
      if (!execute) return Result.ok({ desktop: null });
      const output = await Result.tryPromise({
        try: () =>
          Promise.resolve(
            execute(
              {},
              {
                toolCallId: "native-computer-viewer",
                messages: [],
                context: undefined,
                abortSignal: AbortSignal.any([
                  AbortSignal.timeout(5000),
                  ...(signal ? [signal] : []),
                ]),
              },
            ),
          ),
        catch: captureError,
      });
      if (output.isErr()) {
        rethrowPanic(output.error.cause);
        return Result.err(new Error("Computer viewer is unavailable"));
      }
      return decodeComputerViewer(output.value);
    }, this);
  }
}
