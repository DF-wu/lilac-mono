import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Result, TaggedError } from "better-result";
import { decodeCoreConfigYaml, parseCoreConfigResult } from "@stanley2058/lilac-utils/core-config";
import { errorCode } from "@stanley2058/lilac-utils/runtime-utils";
import { withMcpConfigMutationLock } from "../../mcp/config-file";
import { captureError } from "../../shared/error-capture";
import { parseMcpConfigYaml } from "../../mcp/config";
import type { McpRegistryApi, McpReloadOutcome } from "../../mcp/registry-types";

export type NativeConfigDocument = { kind: "core" | "mcp"; revision: string; text: string };
export class NativeConfigError extends TaggedError("NativeConfigError")<{
  code: "forbidden" | "invalid" | "conflict" | "io" | "reload";
  message: string;
  currentRevision?: string;
}> {}

function failure(
  code: NativeConfigError["code"],
  message: string,
  currentRevision?: string,
): NativeConfigError {
  return new NativeConfigError({
    code,
    message,
    ...(currentRevision ? { currentRevision } : {}),
  });
}

function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validateDocument(
  kind: NativeConfigDocument["kind"],
  text: string,
): Result<void, NativeConfigError> {
  if (text.length > 1_048_576) return Result.err(failure("invalid", "Configuration exceeds 1 MiB"));
  if (kind === "mcp") {
    const parsed = parseMcpConfigYaml(text);
    if (!parsed.ok) return Result.err(failure("invalid", parsed.issues.join("\n")));
    return Result.ok();
  }
  return Result.gen(function* () {
    const raw = yield* decodeCoreConfigYaml(text).mapError((error) =>
      failure("invalid", error.message),
    );
    yield* parseCoreConfigResult(raw).mapError((error) => {
      if (error._tag !== "CoreConfigV1Invalid" && error._tag !== "CoreConfigV2Invalid")
        return failure("invalid", error.message);
      return failure(
        "invalid",
        error.cause.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
      );
    });
    return Result.ok();
  });
}

type StreamingMode = "paragraph" | "complete";
type StreamingSettings = { mode: StreamingMode; revision: string };
const streamingDocumentSchema = z
  .object({
    configVersion: z.literal(2),
    surface: z
      .object({
        native: z
          .object({ outputStreaming: z.enum(["paragraph", "complete"]).optional() })
          .catchall(z.json())
          .optional(),
      })
      .catchall(z.json())
      .optional(),
  })
  .catchall(z.json());

function streamingDocument(text: string) {
  return Result.gen(function* () {
    const raw = yield* decodeCoreConfigYaml(text).mapError((error) =>
      failure("invalid", error.message),
    );
    const parsed = streamingDocumentSchema.safeParse(raw);
    if (!parsed.success)
      return Result.err(
        failure("invalid", "Streaming settings require a valid version 2 Core configuration"),
      );
    return Result.ok(parsed.data);
  });
}

export class NativeConfigService {
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      dataDir: string;
      ownerId: string;
      registry: Pick<McpRegistryApi, "reload">;
    },
  ) {}

  async read(
    userId: string,
    kind: NativeConfigDocument["kind"],
  ): Promise<Result<NativeConfigDocument, NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can read configuration"));
    const file = path.join(this.options.dataDir, `${kind}-config.yaml`);
    const read = await Result.tryPromise({
      try: () => fs.readFile(file, "utf8"),
      catch: captureError,
    });
    return read.match<Result<NativeConfigDocument, NativeConfigError>>({
      ok: (text) => Result.ok({ kind, text, revision: revisionOf(text) }),
      err: ({ cause: error }) => {
        const missing = kind === "mcp" && errorCode(error) === "ENOENT";
        if (!missing) return Result.err(failure("io", error.message));
        const text = "configVersion: 1\nservers: {}\n";
        return Result.ok({ kind, text, revision: revisionOf(text) });
      },
    });
  }

  save(
    userId: string,
    input: { kind: NativeConfigDocument["kind"]; text: string; expectedRevision: string },
  ): Promise<Result<NativeConfigDocument, NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Promise.resolve(
        Result.err(failure("forbidden", "Only the owner can change configuration")),
      );
    if (input.kind === "mcp")
      return withMcpConfigMutationLock(path.join(this.options.dataDir, "mcp-config.yaml"), () =>
        this.saveSerialized(userId, input),
      );
    const result = this.mutation.then(() => this.saveSerialized(userId, input));
    const settled = Result.tryPromise({
      try: () => result,
      catch: () => failure("io", "Configuration operation rejected"),
    });
    this.mutation = settled.then(() => undefined);
    return result;
  }

  private async saveSerialized(
    userId: string,
    input: { kind: NativeConfigDocument["kind"]; text: string; expectedRevision: string },
  ): Promise<Result<NativeConfigDocument, NativeConfigError>> {
    return Result.gen(async function* () {
      yield* validateDocument(input.kind, input.text);
      const current = yield* Result.await(this.read(userId, input.kind));
      if (current.revision !== input.expectedRevision)
        return Result.err(
          failure("conflict", "Configuration changed since it was loaded", current.revision),
        );
      if (current.text === input.text) return Result.ok(current);
      const file = path.join(this.options.dataDir, `${input.kind}-config.yaml`);
      yield* Result.await(writeAtomic(file, input.text));
      return Result.ok({ kind: input.kind, text: input.text, revision: revisionOf(input.text) });
    }, this);
  }

  async readStreaming(userId: string): Promise<Result<StreamingSettings, NativeConfigError>> {
    return Result.gen(async function* () {
      const document = yield* Result.await(this.read(userId, "core"));
      const source = yield* streamingDocument(document.text);
      return Result.ok({
        mode: source.surface?.native?.outputStreaming ?? "paragraph",
        revision: document.revision,
      });
    }, this);
  }

  async setStreaming(
    userId: string,
    input: { mode: StreamingMode; expectedRevision: string },
  ): Promise<Result<StreamingSettings, NativeConfigError>> {
    return Result.gen(async function* () {
      const document = yield* Result.await(this.read(userId, "core"));
      if (document.revision !== input.expectedRevision)
        return Result.err(
          failure("conflict", "Configuration changed since it was loaded", document.revision),
        );
      const source = yield* streamingDocument(document.text);
      if ((source.surface?.native?.outputStreaming ?? "paragraph") === input.mode)
        return Result.ok({ mode: input.mode, revision: document.revision });
      const updated = {
        ...source,
        surface: {
          ...source.surface,
          native: { ...source.surface?.native, outputStreaming: input.mode },
        },
      };
      const text = yield* Result.try({
        try: () => `${Bun.YAML.stringify(updated, null, 2)}\n`,
        catch: () => failure("invalid", "Cannot serialize Core configuration"),
      });
      const saved = yield* Result.await(
        this.save(userId, { kind: "core", expectedRevision: input.expectedRevision, text }),
      );
      return Result.ok({ mode: input.mode, revision: saved.revision });
    }, this);
  }

  async reloadMcp(userId: string): Promise<Result<readonly McpReloadOutcome[], NativeConfigError>> {
    if (userId !== this.options.ownerId)
      return Result.err(failure("forbidden", "Only the owner can reload MCP configuration"));
    const result = await this.options.registry.reload();
    return result.mapError((error) => failure("reload", error.message));
  }
}

async function writeAtomic(file: string, text: string): Promise<Result<void, NativeConfigError>> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const written = await Result.gen(async function* () {
    const handle = yield* Result.await(
      Result.tryPromise({
        try: () => fs.open(temporary, "wx", 0o600),
        catch: () => failure("io", "Cannot create temporary configuration"),
      }),
    );
    const content = await Result.tryPromise({
      try: async () => {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      },
      catch: () => failure("io", "Cannot write temporary configuration"),
    });
    const closed = await Result.tryPromise({
      try: () => handle.close(),
      catch: () => failure("io", "Cannot close temporary configuration"),
    });
    yield* Result.all([content, closed]);
    yield* Result.await(
      Result.tryPromise({
        try: () => fs.rename(temporary, file),
        catch: () => failure("io", "Cannot replace configuration"),
      }),
    );
    return Result.ok();
  });
  const cleanup = await Result.tryPromise({
    try: () => fs.rm(temporary, { force: true }),
    catch: () => failure("io", "Cannot remove temporary configuration"),
  });
  return Result.all([written, cleanup]).map(() => undefined);
}
