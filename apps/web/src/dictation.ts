import { Result } from "better-result";
import { z } from "zod";

export type DictationConfig = { endpoint: string; model: string; token: string };
export type DictationState = "idle" | "requesting" | "recording" | "transcribing";
export const dictationMaxBytes = 10 * 1024 * 1024;
const transcriptSchema = z.object({ text: z.string().trim().min(1).max(32_000) });

export function decodeDictationText(value: unknown): Result<string, string> {
  const decoded = transcriptSchema.safeParse(value);
  if (!decoded.success)
    return Result.err("The service returned empty or invalid transcription text.");
  return Result.ok(decoded.data.text);
}

export function validateDictationEndpoint(value: string, token = ""): string | undefined {
  const parsed = Result.try({ try: () => new URL(value), catch: () => "Invalid URL" });
  if (parsed.isErr()) return "Enter a full HTTP(S) transcription URL.";
  const url = parsed.value;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    return "Use an HTTP(S) URL without credentials, query, or fragment.";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (token && url.protocol === "http:" && !loopback)
    return "Service API tokens require HTTPS outside localhost, 127.0.0.1, or [::1].";
  return undefined;
}

export function dictationSupport(): string | undefined {
  if (!globalThis.isSecureContext) return "Microphone access needs HTTPS or localhost.";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return "This browser does not support microphone recording.";
  return undefined;
}

function recordingFormat() {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

async function transcribe(
  audio: Blob,
  config: DictationConfig,
  signal: AbortSignal,
): Promise<Result<string, string>> {
  const body = new FormData();
  const extension = audio.type.startsWith("audio/mp4") ? "mp4" : "webm";
  body.append("file", audio, `dictation.${extension}`);
  body.append("model", config.model.trim() || "whisper-1");
  body.append("response_format", "json");
  const response = await Result.tryPromise({
    try: () =>
      fetch(config.endpoint, {
        method: "POST",
        body,
        signal,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      }),
    catch: () =>
      "Transcription failed. Check the service URL, CORS, and browser network permissions.",
  });
  if (response.isErr()) return response;
  if (!response.value.ok)
    return Result.err(
      `Transcription failed (HTTP ${response.value.status}). Check the service and token.`,
    );
  const json = await Result.tryPromise({
    try: () => response.value.json(),
    catch: () => "The service returned invalid JSON.",
  });
  if (json.isErr()) return json;
  return decodeDictationText(json.value);
}

/** One composer take. Cancellation invalidates even late permission and response callbacks. */
export function createDictation(callbacks: {
  state: (state: DictationState) => void;
  text: (text: string) => void;
  error: (message: string) => void;
}) {
  type Take = {
    stream?: MediaStream;
    recorder?: MediaRecorder;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    chunks: Blob[];
    bytes: number;
  };
  let take: Take | undefined;

  function release(current: Take) {
    clearTimeout(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
  }
  function cancel() {
    const current = take;
    take = undefined;
    if (!current) return;
    current.controller.abort();
    release(current);
    if (current.recorder?.state === "recording") current.recorder.stop();
    current.chunks.length = 0;
    callbacks.state("idle");
  }
  function fail(message: string) {
    cancel();
    callbacks.error(message);
  }
  async function start(config: DictationConfig) {
    if (take) return;
    const invalid = validateDictationEndpoint(config.endpoint, config.token) ?? dictationSupport();
    if (invalid) {
      callbacks.error(invalid);
      return;
    }
    // Copy the destination and personal token before requesting permission.
    const destination = { ...config };
    const current: Take = { controller: new AbortController(), chunks: [], bytes: 0 };
    take = current;
    callbacks.state("requesting");
    const permission = await Result.tryPromise({
      try: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      catch: () => "Microphone unavailable. Allow access in browser site settings and try again.",
    });
    if (permission.isErr()) {
      if (take === current) fail(permission.error);
      return;
    }
    current.stream = permission.value;
    if (take !== current) {
      release(current);
      return;
    }
    const recorderResult = Result.try({
      try: () => {
        const mimeType = recordingFormat();
        return new MediaRecorder(permission.value, mimeType ? { mimeType } : undefined);
      },
      catch: () => "Cannot record audio in this browser. Try another browser.",
    });
    function recordingFailed(message: string) {
      fail(message);
      return undefined;
    }
    const recorder = recorderResult.match({ ok: (value) => value, err: recordingFailed });
    if (!recorder) return;
    const mimeType = recorder.mimeType;
    current.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (take !== current) return;
      current.bytes += event.data.size;
      if (current.bytes > dictationMaxBytes) {
        fail("Recording is too large. Try a shorter take.");
        return;
      }
      if (event.data.size) current.chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (take === current) fail("Recording failed. Try again.");
    };
    recorder.onstop = () => {
      void finish();
    };
    async function finish() {
      release(current);
      if (take !== current) return;
      const audio = new Blob(current.chunks, { type: mimeType });
      current.chunks.length = 0;
      if (!audio.size) {
        fail("No audio recorded. Try again.");
        return;
      }
      callbacks.state("transcribing");
      current.timer = setTimeout(() => {
        if (take === current) fail("Transcription timed out. Try a shorter take.");
      }, 30_000);
      const result = await transcribe(audio, destination, current.controller.signal);
      if (take !== current) return;
      clearTimeout(current.timer);
      take = undefined;
      callbacks.state("idle");
      result.match({ ok: callbacks.text, err: callbacks.error });
    }
    const started = Result.try({
      try: () => recorder.start(1000),
      catch: () => "Cannot start recording. Try again.",
    });
    if (started.isErr()) {
      fail(started.error);
      return;
    }
    callbacks.state("recording");
    current.timer = setTimeout(stop, 120_000);
  }
  function stop() {
    const current = take;
    if (!current?.recorder || current.recorder.state !== "recording") return;
    clearTimeout(current.timer);
    current.recorder.stop();
    release(current);
    callbacks.state("transcribing");
  }
  return { start, stop, cancel };
}
