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
  const prepared = await captureBuildOperation("prepare the output directory", async () => {
    await fs.rm("./dist", { recursive: true, force: true });
    await fs.mkdir("./dist", { recursive: true });
  });
  if (prepared.status === "error") return Result.err(prepared.error);

  const openTui = await captureBuildOperation("read @opentui/core", async () => {
    const entry = fileURLToPath(import.meta.resolve("@opentui/core"));
    return { entry, source: await fs.readFile(entry, "utf8") };
  });
  if (openTui.status === "error") return Result.err(openTui.error);
  if (!openTui.value.source.includes('forceTableRefresh && block.token.type === "table"')) {
    return Result.err(
      new MiniLilacBuildPatchMissing({
        message: "The required @opentui/core Markdown patch is not installed",
      }),
    );
  }

  const bundled = await captureBuildOperation("bundle the executable", () =>
    Bun.build({
      entrypoints: ["./src/main.ts"],
      outdir: "./dist",
      target: "bun",
      plugins: [solidPlugin],
      external: ["@opentui/core-darwin-*", "@opentui/core-linux-*", "@opentui/core-win32-*"],
      banner: "#!/usr/bin/env bun",
    }),
  );
  if (bundled.status === "error") return Result.err(bundled.error);
  if (!bundled.value.success) {
    console.error("mini-lilac build failed:");
    for (const log of bundled.value.logs) console.error(log);
    return Result.err(new MiniLilacBundlingFailed({ message: "Bun.build failed" }));
  }

  const scanned = await captureBuildOperation("inspect bundled imports", async () => {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    return (
      await Promise.all(
        bundled.value.outputs
          .filter((output) => output.path.endsWith(".js"))
          .map(async (output) =>
            transpiler.scanImports((await output.text()).replace(/^#![^\n]*\n/u, "")),
          ),
      )
    ).flat();
  });
  if (scanned.status === "error") return Result.err(scanned.error);
  if (hasOpenTuiCoreImport(scanned.value.map((importRecord) => importRecord.path))) {
    return Result.err(
      new MiniLilacBuildRetainedDependency({
        message: "The published bundle still imports unpatched @opentui/core JavaScript",
      }),
    );
  }

  const sourcePackageFile = await captureBuildOperation("read package.json", () =>
    Bun.file("./package.json").json(),
  );
  if (sourcePackageFile.status === "error") return Result.err(sourcePackageFile.error);
  const sourcePackage = decodeSourcePackage(sourcePackageFile.value);
  if (sourcePackage.status === "error") return Result.err(sourcePackage.error);

  const publishedPackage = {
    ...sourcePackage.value,
    type: "module",
    bin: { "mini-lilac": "main.js" },
    files: ["main.js", "parser.worker.js", "*.scm", "*.wasm", "README.md", "LICENSE"],
  };
  const staged = await captureBuildOperation("stage publication files", () =>
    Promise.all([
      fs.writeFile("./dist/package.json", `${JSON.stringify(publishedPackage, null, 2)}\n`),
      fs.copyFile(
        path.join(path.dirname(openTui.value.entry), "parser.worker.js"),
        "./dist/parser.worker.js",
      ),
      fs.copyFile("./README.md", "./dist/README.md"),
      fs.copyFile("./LICENSE", "./dist/LICENSE"),
    ]).then(() => undefined),
  );
  if (staged.status === "error") return Result.err(staged.error);
  return Result.ok(undefined);
}

export function signalBuildFailure(error: MiniLilacBuildError): never {
  const options =
    error._tag === "MiniLilacBuildOperationFailed" ? { cause: error.cause } : undefined;
  throw new Error(error.message, options);
}

if (import.meta.main) {
  const result = await buildMiniLilac();
  if (result.status === "error") signalBuildFailure(result.error);
}
