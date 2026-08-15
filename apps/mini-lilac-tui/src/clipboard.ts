import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { open, rm, type FileHandle } from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureTuiOperation, captureTuiOperationAsync } from "./failure-adapter";

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 3_000;
const FORCE_KILL_DELAY_MS = 100;
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

export class ClipboardImageTooLargeError extends TaggedError("ClipboardImageTooLargeError")<{
  readonly maxBytes: number;
  readonly message: string;
}> {
  constructor(maxBytes: number) {
    super({ maxBytes, message: `Clipboard image exceeds ${maxBytes} bytes` });
  }
}

export class ClipboardOperationFailed extends TaggedError("ClipboardOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClipboardCleanupFailed extends TaggedError("ClipboardCleanupFailed")<{
  readonly operation: "close" | "remove";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClipboardReadAndCleanupFailed extends TaggedError("ClipboardReadAndCleanupFailed")<{
  readonly read: ClipboardReadError;
  readonly cleanup: ClipboardCleanupFailed;
  readonly message: string;
}> {}

export type ClipboardReadError = ClipboardImageTooLargeError | ClipboardOperationFailed;
export type ClipboardError =
  | ClipboardReadError
  | ClipboardCleanupFailed
  | ClipboardReadAndCleanupFailed;

export interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png";
}

type ClipboardProcess = ChildProcessByStdio<null, Readable, null>;

function spawnClipboardCommand(
  name: string,
  args: readonly string[],
): ResultType<ClipboardProcess, ClipboardOperationFailed> {
  return captureTuiOperation(
    () => spawn(name, [...args], { stdio: ["ignore", "pipe", "ignore"] as const }),
    (cause) =>
      new ClipboardOperationFailed({
        operation: name,
        cause,
        message: `${name} could not start`,
      }),
  );
}

function command(
  name: string,
  args: readonly string[],
  options: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
): Promise<ResultType<Uint8Array, ClipboardReadError>> {
  const spawned = spawnClipboardCommand(name, args);
  const child = spawned.match<ClipboardProcess | ClipboardOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ClipboardOperationFailed.is(child)) return Promise.resolve(Result.err(child));
  return new Promise((resolve) => {
    const maxBytes = options.maxBytes ?? MAX_CLIPBOARD_IMAGE_BYTES;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;
    let childExited = false;
    let terminationError: ClipboardReadError | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ResultType<Uint8Array, ClipboardReadError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      resolve(result);
    };
    const terminate = (error: ClipboardReadError) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.stdout.pause();
      if (childExited) {
        child.stdout.destroy();
        finish(Result.err(error));
        return;
      }
      child.kill();
      forceKill = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
    };
    const timeout = setTimeout(() => {
      terminate(
        new ClipboardOperationFailed({
          operation: name,
          cause: undefined,
          message: `${name} timed out`,
        }),
      );
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.on("error", (cause: Error) => {
      finish(
        Result.err(
          new ClipboardOperationFailed({
            operation: name,
            cause,
            message: `${name} failed: ${cause.message}`,
          }),
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminationError !== undefined) return;
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        chunks.length = 0;
        terminate(new ClipboardImageTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    child.on("exit", () => {
      childExited = true;
      if (terminationError !== undefined) {
        child.stdout.destroy();
        finish(Result.err(terminationError));
      }
    });
    child.on("close", (code) => {
      if (terminationError !== undefined) {
        finish(Result.err(terminationError));
      } else if (code === 0) {
        finish(Result.ok(Buffer.concat(chunks, bytesRead)));
      } else {
        finish(
          Result.err(
            new ClipboardOperationFailed({
              operation: name,
              cause: undefined,
              message: `${name} exited with code ${code}`,
            }),
          ),
        );
      }
    });
  });
}

async function openClipboardFile(
  file: string,
): Promise<ResultType<FileHandle, ClipboardOperationFailed>> {
  return captureTuiOperationAsync(
    () => open(file, "r"),
    (cause) =>
      new ClipboardOperationFailed({
        operation: "open",
        cause,
        message: "Clipboard file open failed",
      }),
  );
}

async function statClipboardFile(
  handle: FileHandle,
): Promise<ResultType<Awaited<ReturnType<FileHandle["stat"]>>, ClipboardOperationFailed>> {
  return captureTuiOperationAsync(
    () => handle.stat(),
    (cause) =>
      new ClipboardOperationFailed({
        operation: "stat",
        cause,
        message: "Clipboard file stat failed",
      }),
  );
}

async function readClipboardFile(
  handle: FileHandle,
  buffer: Buffer,
): Promise<ResultType<{ readonly bytesRead: number }, ClipboardOperationFailed>> {
  return captureTuiOperationAsync(
    async () => {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      return { bytesRead };
    },
    (cause) =>
      new ClipboardOperationFailed({
        operation: "read",
        cause,
        message: "Clipboard file read failed",
      }),
  );
}

async function closeClipboardFile(
  handle: FileHandle,
): Promise<ResultType<void, ClipboardCleanupFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await handle.close();
    },
    (cause) =>
      new ClipboardCleanupFailed({
        operation: "close",
        cause,
        message: "Clipboard file close failed",
      }),
  );
}

async function readBoundedFile(
  file: string,
  maxBytes: number,
): Promise<
  ResultType<
    Uint8Array,
    ClipboardReadError | ClipboardCleanupFailed | ClipboardReadAndCleanupFailed
  >
> {
  const opened = await openClipboardFile(file);
  const handle = opened.match<FileHandle | ClipboardOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ClipboardOperationFailed.is(handle)) return Result.err(handle);
  let readResult: ResultType<Uint8Array, ClipboardReadError>;
  const stat = await statClipboardFile(handle);
  const fileStat = stat.match<Awaited<ReturnType<FileHandle["stat"]>> | ClipboardOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ClipboardOperationFailed.is(fileStat)) {
    readResult = Result.err(fileStat);
  } else if (fileStat.size > maxBytes) {
    readResult = Result.err(new ClipboardImageTooLargeError(maxBytes));
  } else {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    readResult = Result.ok(new Uint8Array());
    for (;;) {
      const read = await readClipboardFile(handle, buffer);
      const readValue = read.match<{ readonly bytesRead: number } | ClipboardOperationFailed>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (ClipboardOperationFailed.is(readValue)) {
        readResult = Result.err(readValue);
        break;
      }
      if (readValue.bytesRead === 0) {
        readResult = Result.ok(Buffer.concat(chunks, totalBytes));
        break;
      }
      totalBytes += readValue.bytesRead;
      if (totalBytes > maxBytes) {
        readResult = Result.err(new ClipboardImageTooLargeError(maxBytes));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, readValue.bytesRead)));
    }
  }
  const closed = await closeClipboardFile(handle);
  return closed.match<
    ResultType<
      Uint8Array,
      ClipboardReadError | ClipboardCleanupFailed | ClipboardReadAndCleanupFailed
    >
  >({
    ok: () => readResult,
    err: (cleanup) =>
      readResult.match<
        ResultType<Uint8Array, ClipboardCleanupFailed | ClipboardReadAndCleanupFailed>
      >({
        ok: () => Result.err(cleanup),
        err: (read) =>
          Result.err(
            new ClipboardReadAndCleanupFailed({
              read,
              cleanup,
              message: `${read.message}; ${cleanup.message}`,
            }),
          ),
      }),
  });
}

async function runAppleScript(
  args: readonly string[],
): Promise<ResultType<void, ClipboardOperationFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await exec("osascript", [...args], { timeout: COMMAND_TIMEOUT_MS });
    },
    (cause) =>
      new ClipboardOperationFailed({
        operation: "osascript",
        cause,
        message: "Clipboard image unavailable",
      }),
  );
}

async function removeClipboardFile(
  file: string,
): Promise<ResultType<void, ClipboardCleanupFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await rm(file, { force: true });
    },
    (cause) =>
      new ClipboardCleanupFailed({
        operation: "remove",
        cause,
        message: "Clipboard file removal failed",
      }),
  );
}

function optionalClipboardBytes(
  result: ResultType<Uint8Array, ClipboardReadError>,
): ResultType<Uint8Array | undefined, ClipboardReadError> {
  return result.match<ResultType<Uint8Array | undefined, ClipboardReadError>>({
    ok: (value) => Result.ok(value.length === 0 ? undefined : value),
    err: (error) =>
      ClipboardImageTooLargeError.is(error) ? Result.err(error) : Result.ok(undefined),
  });
}

/** Read an image clipboard using native platform tools, without reading clipboard text. */
export async function readClipboardImage(): Promise<
  ResultType<ClipboardImage | undefined, ClipboardError>
> {
  if (platform() === "darwin") {
    const file = join(tmpdir(), `mini-lilac-clipboard-${process.pid}-${crypto.randomUUID()}.png`);
    const scripted = await runAppleScript([
      "-e",
      'set imageData to the clipboard as "PNGf"',
      "-e",
      `set fileRef to open for access POSIX file "${file}" with write permission`,
      "-e",
      "set eof fileRef to 0",
      "-e",
      "write imageData to fileRef",
      "-e",
      "close access fileRef",
    ]);
    let readResult: ResultType<Uint8Array | undefined, ClipboardError> = Result.ok(undefined);
    const scriptSucceeded = scripted.match({ ok: () => true, err: () => false });
    if (scriptSucceeded) {
      const read = await readBoundedFile(file, MAX_CLIPBOARD_IMAGE_BYTES);
      readResult = read.map((value) => (value.length === 0 ? undefined : value));
    }
    const removed = await removeClipboardFile(file);
    const removeFailure = removed.match<ClipboardCleanupFailed | undefined>({
      ok: () => undefined,
      err: (error) => error,
    });
    if (removeFailure !== undefined) {
      const readFailure = readResult.match<ClipboardError | undefined>({
        ok: () => undefined,
        err: (error) => error,
      });
      if (readFailure !== undefined && !ClipboardCleanupFailed.is(readFailure)) {
        const primary = ClipboardReadAndCleanupFailed.is(readFailure)
          ? readFailure.read
          : readFailure;
        return Result.err(
          new ClipboardReadAndCleanupFailed({
            read: primary,
            cleanup: removeFailure,
            message: `${primary.message}; ${removeFailure.message}`,
          }),
        );
      }
      return Result.err(removeFailure);
    }
    return readResult.map((value) =>
      value === undefined ? undefined : { bytes: value, mediaType: "image/png" as const },
    );
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $stdout = [Console]::OpenStandardOutput(); $img.Save($stdout, [System.Drawing.Imaging.ImageFormat]::Png); $stdout.Flush() }";
    const bytes = optionalClipboardBytes(
      await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script]),
    );
    const byteValue = bytes.match<Uint8Array | undefined | ClipboardReadError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ClipboardImageTooLargeError.is(byteValue) || ClipboardOperationFailed.is(byteValue)) {
      return Result.err(byteValue);
    }
    return Result.ok(
      byteValue === undefined ? undefined : { bytes: byteValue, mediaType: "image/png" },
    );
  }

  if (platform() === "linux") {
    const wayland = optionalClipboardBytes(await command("wl-paste", ["-t", "image/png"]));
    const waylandValue = wayland.match<Uint8Array | undefined | ClipboardReadError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ClipboardImageTooLargeError.is(waylandValue) || ClipboardOperationFailed.is(waylandValue)) {
      return Result.err(waylandValue);
    }
    if (waylandValue !== undefined)
      return Result.ok({ bytes: waylandValue, mediaType: "image/png" });
    const x11 = optionalClipboardBytes(
      await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    );
    const x11Value = x11.match<Uint8Array | undefined | ClipboardReadError>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ClipboardImageTooLargeError.is(x11Value) || ClipboardOperationFailed.is(x11Value)) {
      return Result.err(x11Value);
    }
    if (x11Value !== undefined) return Result.ok({ bytes: x11Value, mediaType: "image/png" });
  }

  return Result.ok(undefined);
}

export const __clipboardInternals = { command, readBoundedFile };
