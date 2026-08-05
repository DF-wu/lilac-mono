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
  if (spawned.status === "error") return Promise.resolve(Result.err(spawned.error));
  const child = spawned.value;
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
  if (opened.status === "error") return Result.err(opened.error);
  const handle = opened.value;
  let readResult: ResultType<Uint8Array, ClipboardReadError>;
  const stat = await statClipboardFile(handle);
  if (stat.status === "error") {
    readResult = Result.err(stat.error);
  } else if (stat.value.size > maxBytes) {
    readResult = Result.err(new ClipboardImageTooLargeError(maxBytes));
  } else {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    readResult = Result.ok(new Uint8Array());
    for (;;) {
      const read = await readClipboardFile(handle, buffer);
      if (read.status === "error") {
        readResult = Result.err(read.error);
        break;
      }
      if (read.value.bytesRead === 0) {
        readResult = Result.ok(Buffer.concat(chunks, totalBytes));
        break;
      }
      totalBytes += read.value.bytesRead;
      if (totalBytes > maxBytes) {
        readResult = Result.err(new ClipboardImageTooLargeError(maxBytes));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, read.value.bytesRead)));
    }
  }
  const closed = await closeClipboardFile(handle);
  if (closed.status === "ok") return readResult;
  if (readResult.status === "error") {
    return Result.err(
      new ClipboardReadAndCleanupFailed({
        read: readResult.error,
        cleanup: closed.error,
        message: `${readResult.error.message}; ${closed.error.message}`,
      }),
    );
  }
  return Result.err(closed.error);
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
  if (result.status === "ok")
    return Result.ok(result.value.length === 0 ? undefined : result.value);
  return ClipboardImageTooLargeError.is(result.error)
    ? Result.err(result.error)
    : Result.ok(undefined);
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
    if (scripted.status === "ok") {
      const read = await readBoundedFile(file, MAX_CLIPBOARD_IMAGE_BYTES);
      readResult =
        read.status === "ok"
          ? Result.ok(read.value.length === 0 ? undefined : read.value)
          : Result.err(read.error);
    }
    const removed = await removeClipboardFile(file);
    if (removed.status === "error") {
      if (readResult.status === "error" && !ClipboardCleanupFailed.is(readResult.error)) {
        const primary = ClipboardReadAndCleanupFailed.is(readResult.error)
          ? readResult.error.read
          : readResult.error;
        return Result.err(
          new ClipboardReadAndCleanupFailed({
            read: primary,
            cleanup: removed.error,
            message: `${primary.message}; ${removed.error.message}`,
          }),
        );
      }
      return Result.err(removed.error);
    }
    if (readResult.status === "error") return Result.err(readResult.error);
    return Result.ok(
      readResult.value === undefined
        ? undefined
        : { bytes: readResult.value, mediaType: "image/png" },
    );
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $stdout = [Console]::OpenStandardOutput(); $img.Save($stdout, [System.Drawing.Imaging.ImageFormat]::Png); $stdout.Flush() }";
    const bytes = optionalClipboardBytes(
      await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script]),
    );
    if (bytes.status === "error") return Result.err(bytes.error);
    return Result.ok(
      bytes.value === undefined ? undefined : { bytes: bytes.value, mediaType: "image/png" },
    );
  }

  if (platform() === "linux") {
    const wayland = optionalClipboardBytes(await command("wl-paste", ["-t", "image/png"]));
    if (wayland.status === "error") return Result.err(wayland.error);
    if (wayland.value !== undefined)
      return Result.ok({ bytes: wayland.value, mediaType: "image/png" });
    const x11 = optionalClipboardBytes(
      await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    );
    if (x11.status === "error") return Result.err(x11.error);
    if (x11.value !== undefined) return Result.ok({ bytes: x11.value, mediaType: "image/png" });
  }

  return Result.ok(undefined);
}

export const __clipboardInternals = { command, readBoundedFile };
