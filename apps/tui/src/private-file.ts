import { mkdir, chmod, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Result, TaggedError } from "better-result";
export class TuiFileError extends TaggedError("TuiFileError")<{ message: string }> {}
export function readPrivateFile(
  path: string,
  maxBytes: number,
): Promise<Result<string | undefined, TuiFileError>> {
  return Result.tryPromise({
    try: async () => {
      const exists = await Bun.file(path).exists();
      if (!exists) return undefined;
      const info = await stat(path);
      if (info.size > maxBytes) return undefined;
      return readFile(path, "utf8");
    },
    catch: () => new TuiFileError({ message: "Could not read private TUI state" }),
  });
}
export async function writePrivateFile(
  path: string,
  data: string,
): Promise<Result<void, TuiFileError>> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const result = await Result.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    },
    catch: () => new TuiFileError({ message: "Could not save private TUI state" }),
  });
  await Result.tryPromise({ try: () => rm(temporary, { force: true }), catch: () => undefined });
  return result;
}
export function removePrivateFile(path: string): Promise<Result<void, TuiFileError>> {
  return Result.tryPromise({
    try: () => rm(path, { force: true }),
    catch: () => new TuiFileError({ message: "Could not clear private TUI state" }),
  });
}
