import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import solidPlugin from "@opentui/solid/bun-plugin";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

export class MiniLilacBuildOperationFailed extends TaggedError("MiniLilacBuildOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class MiniLilacBuildPatchMissing extends TaggedError("MiniLilacBuildPatchMissing")<{
  readonly message: string;
}> {}

export class MiniLilacBundlingFailed extends TaggedError("MiniLilacBundlingFailed")<{
  readonly message: string;
}> {}

export class MiniLilacBuildRetainedDependency extends TaggedError(
  "MiniLilacBuildRetainedDependency",
)<{
  readonly message: string;
}> {}

export class MiniLilacSourcePackageInvalid extends TaggedError("MiniLilacSourcePackageInvalid")<{
  readonly message: string;
}> {}

export type MiniLilacBuildError =
  | MiniLilacBuildOperationFailed
  | MiniLilacBuildPatchMissing
  | MiniLilacBundlingFailed
  | MiniLilacBuildRetainedDependency
  | MiniLilacSourcePackageInvalid;

const sourcePackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  license: z.string(),
  repository: z.object({
    type: z.string(),
    url: z.string(),
    directory: z.string(),
  }),
  homepage: z.string(),
  publishConfig: z.object({ access: z.literal("public") }),
  engines: z.object({ bun: z.string() }),
  dependencies: z.object({ "@opentui/core": z.string() }),
});

type SourcePackage = z.output<typeof sourcePackageSchema>;

async function captureBuildOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<ResultType<T, MiniLilacBuildOperationFailed>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MiniLilacBuildOperationFailed({
        operation,
        cause,
        message: `Mini Lilac build failed while attempting to ${operation}`,
      }),
    );
  }
}

export function decodeSourcePackage(
  value: unknown,
): ResultType<SourcePackage, MiniLilacSourcePackageInvalid> {
  const parsed = sourcePackageSchema.safeParse(value);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new MiniLilacSourcePackageInvalid({
      message: `Invalid source package: ${parsed.error.message}`,
    }),
  );
}

export function hasOpenTuiCoreImport(specifiers: readonly (string | undefined)[]): boolean {
  return specifiers.some(
    (specifier) =>
      specifier === "@opentui/core" || specifier?.startsWith("@opentui/core/") === true,
  );
}

export async function buildMiniLilac(): Promise<ResultType<void, MiniLilacBuildError>> {
  return Result.gen(async function* () {
    yield* Result.await(
      captureBuildOperation("prepare the output directory", async () => {
        await fs.rm("./dist", { recursive: true, force: true });
        await fs.mkdir("./dist", { recursive: true });
      }),
    );

    const openTui = yield* Result.await(
      captureBuildOperation("read @opentui/core", async () => {
        const entry = fileURLToPath(import.meta.resolve("@opentui/core"));
        return { entry, source: await fs.readFile(entry, "utf8") };
      }),
    );
    if (!openTui.source.includes('forceTableRefresh && block.token.type === "table"')) {
      return Result.err(
        new MiniLilacBuildPatchMissing({
          message: "The required @opentui/core Markdown patch is not installed",
        }),
      );
    }

    const bundled = yield* Result.await(
      captureBuildOperation("bundle the executable", () =>
        Bun.build({
          entrypoints: ["./src/main.ts"],
          outdir: "./dist",
          target: "bun",
          plugins: [solidPlugin],
          external: ["@opentui/core-darwin-*", "@opentui/core-linux-*", "@opentui/core-win32-*"],
          banner: "#!/usr/bin/env bun",
        }),
      ),
    );
    if (!bundled.success) {
      console.error("mini-lilac build failed:");
      for (const log of bundled.logs) console.error(log);
      return Result.err(new MiniLilacBundlingFailed({ message: "Bun.build failed" }));
    }

    const scanned = yield* Result.await(
      captureBuildOperation("inspect bundled imports", async () => {
        const transpiler = new Bun.Transpiler({ loader: "js" });
        return (
          await Promise.all(
            bundled.outputs
              .filter((output) => output.path.endsWith(".js"))
              .map(async (output) =>
                transpiler.scanImports((await output.text()).replace(/^#![^\n]*\n/u, "")),
              ),
          )
        ).flat();
      }),
    );
    if (hasOpenTuiCoreImport(scanned.map((importRecord) => importRecord.path))) {
      return Result.err(
        new MiniLilacBuildRetainedDependency({
          message: "The published bundle still imports unpatched @opentui/core JavaScript",
        }),
      );
    }

    const sourcePackageFile = yield* Result.await(
      captureBuildOperation("read package.json", () => Bun.file("./package.json").json()),
    );
    const sourcePackage = yield* decodeSourcePackage(sourcePackageFile);

    const publishedPackage = {
      ...sourcePackage,
      type: "module",
      bin: { "mini-lilac": "main.js" },
      files: ["main.js", "parser.worker.js", "*.scm", "*.wasm", "README.md", "LICENSE"],
    };
    yield* Result.await(
      captureBuildOperation("stage publication files", () =>
        Promise.all([
          fs.writeFile("./dist/package.json", `${JSON.stringify(publishedPackage, null, 2)}\n`),
          fs.copyFile(
            path.join(path.dirname(openTui.entry), "parser.worker.js"),
            "./dist/parser.worker.js",
          ),
          fs.copyFile("./README.md", "./dist/README.md"),
          fs.copyFile("./LICENSE", "./dist/LICENSE"),
        ]).then(() => undefined),
      ),
    );
    return Result.ok(undefined);
  });
}

export function signalBuildFailure(error: MiniLilacBuildError): never {
  throw error;
}

if (import.meta.main) {
  const result = await buildMiniLilac();
  result.match({ ok: () => undefined, err: (error) => () => signalBuildFailure(error) })?.();
}
