import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createDictation, dictationMaxBytes, validateDictationEndpoint } from "../src/dictation";

const config = {
  endpoint: "https://asr.example.test/v1/audio/transcriptions",
  model: "whisper-1",
  token: "synthetic-test-token",
};
const original = Object.getOwnPropertyDescriptors(globalThis);
let stopped = 0;
let bytes = 12;
let failStart = false;
let mp4 = false;
const stream = { getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream;
class FakeRecorder {
  state = "inactive";
  mimeType: string;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  static isTypeSupported(type: string) {
    return mp4 ? type === "audio/mp4" : type === "audio/webm;codecs=opus";
  }
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }
  start() {
    if (failStart) throw new Error("synthetic start failure");
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}
beforeEach(() => {
  stopped = 0;
  bytes = 12;
  failStart = false;
  mp4 = false;
  Object.defineProperties(globalThis, {
    isSecureContext: { configurable: true, value: true },
    navigator: {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => stream } },
    },
    MediaRecorder: { configurable: true, value: FakeRecorder },
  });
});
afterEach(() => {
  for (const key of ["navigator", "MediaRecorder", "isSecureContext", "fetch"]) {
    const descriptor = original[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function harness() {
  const terminal = Promise.withResolvers<void>();
  const states: string[] = [],
    texts: string[] = [],
    errors: string[] = [];
  const take = createDictation({
    state: (state) => states.push(state),
    text: (text) => {
      texts.push(text);
      terminal.resolve();
    },
    error: (error) => {
      errors.push(error);
      terminal.resolve();
    },
  });
  return { take, states, texts, errors, terminal: terminal.promise };
}
test("rejects unsafe destinations before requesting a microphone", async () => {
  for (const endpoint of [
    "/v1/audio/transcriptions",
    "file:///test",
    "https://user:pass@example.test/asr",
    "https://example.test/asr?token=secret",
    "https://example.test/asr#key",
  ])
    expect(validateDictationEndpoint(endpoint)).toBeDefined();
  expect(
    validateDictationEndpoint("http://localhost:8000/v1/audio/transcriptions"),
  ).toBeUndefined();
  const h = harness();
  await h.take.start({ ...config, endpoint: "file:///test" });
  expect(h.errors).toHaveLength(1);
  expect(h.states).toEqual([]);
});
test.each([
  "http://asr.example.test/v1/audio/transcriptions",
  "http://localhost.example.test/asr",
  "http://127.0.0.1.example.test/asr",
  "http://127.0.0.2/asr",
  "http://[::ffff:127.0.0.1]/asr",
])("rejects non-loopback HTTP credentials before permission or upload: %s", async (endpoint) => {
  const microphone = mock(async () => stream);
  const fetcher = mock(async () => Response.json({ text: "Synthetic speech" }));
  navigator.mediaDevices.getUserMedia = microphone;
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const h = harness();
  await h.take.start({ ...config, endpoint });
  expect(microphone).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.states).toEqual([]);
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0]).toContain("HTTPS");
  expect(h.errors[0]).not.toContain(config.token);
});
test.each([
  { endpoint: "https://asr.example.test/v1/audio/transcriptions", token: config.token },
  { endpoint: "http://localhost:6017/v1/audio/transcriptions", token: config.token },
  { endpoint: "http://127.0.0.1:6017/v1/audio/transcriptions", token: config.token },
  { endpoint: "http://[::1]:6017/v1/audio/transcriptions", token: config.token },
  { endpoint: "http://asr.example.test/v1/audio/transcriptions", token: "" },
])("preserves permitted credential and tokenless transports: %s", async ({ endpoint, token }) => {
  const microphone = mock(async () => stream);
  const fetcher = mock(async (url: string, options: RequestInit) => {
    expect(url).toBe(endpoint);
    expect(options.headers).toEqual(token ? { Authorization: `Bearer ${token}` } : {});
    expect(options.redirect).toBe("error");
    return Response.json({ text: "Synthetic speech" });
  });
  navigator.mediaDevices.getUserMedia = microphone;
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const h = harness();
  await h.take.start({ ...config, endpoint, token });
  expect(microphone).toHaveBeenCalledTimes(1);
  h.take.stop();
  await h.terminal;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(h.texts).toEqual(["Synthetic speech"]);
  expect(h.errors).toEqual([]);
});
test.each([false, true])(
  "uploads typed multipart without cookies, redirects, or Core headers (mp4=%s)",
  async (useMp4) => {
    mp4 = useMp4;
    let request: RequestInit | undefined;
    const fetcher = mock(async (url: string, options: RequestInit) => {
      expect(url).toBe(config.endpoint);
      request = options;
      return Response.json({ text: " Synthetic speech. ", otherProviderField: true });
    });
    globalThis.fetch = fetcher as unknown as typeof fetch;
    const h = harness();
    await h.take.start(config);
    expect(h.states).toEqual(["requesting", "recording"]);
    h.take.stop();
    await h.terminal;
    expect(h.texts).toEqual(["Synthetic speech."]);
    expect(stopped).toBeGreaterThan(0);
    expect(request).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${config.token}` },
    });
    const body = request!.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("response_format")).toBe("json");
    const file = body.get("file") as File;
    expect(file.size).toBe(12);
    expect(file.name).toBe(useMp4 ? "dictation.mp4" : "dictation.webm");
    expect(file.type).toBe(useMp4 ? "audio/mp4" : "audio/webm;codecs=opus");
  },
);
test("cancels late permission without recording or uploading", async () => {
  const permission = Promise.withResolvers<MediaStream>();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  const h = harness();
  const pending = h.take.start(config);
  h.take.cancel();
  permission.resolve(stream);
  await pending;
  expect(stopped).toBe(1);
  expect(h.states).toEqual(["requesting", "idle"]);
  expect(h.texts).toEqual([]);
});
test("captures the destination and personal token before microphone permission resolves", async () => {
  const permission = Promise.withResolvers<MediaStream>();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  const mutable = { ...config };
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    expect(url).toBe(config.endpoint);
    expect(options.headers).toEqual({ Authorization: `Bearer ${config.token}` });
    return Response.json({ text: "Synthetic speech" });
  }) as unknown as typeof fetch;
  const h = harness();
  const starting = h.take.start(mutable);
  mutable.endpoint = "https://different.example.test/asr";
  mutable.token = "different-synthetic-token";
  permission.resolve(stream);
  await starting;
  h.take.stop();
  await h.terminal;
  expect(h.texts).toEqual(["Synthetic speech"]);
});
test("aborts an in-flight request and ignores its late transcript", async () => {
  const response = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<AbortSignal>();
  globalThis.fetch = (async (_url: string, options: RequestInit) => {
    requested.resolve(options.signal!);
    return response.promise;
  }) as unknown as typeof fetch;
  const h = harness();
  await h.take.start(config);
  h.take.stop();
  const signal = await requested.promise;
  h.take.cancel();
  expect(signal.aborted).toBe(true);
  response.resolve(Response.json({ text: "Late synthetic speech" }));
  await response.promise;
  await Promise.resolve();
  expect(h.texts).toEqual([]);
  expect(h.errors).toEqual([]);
});
test.each([
  Response.json({ text: "" }),
  Response.json({ text: 42 }),
  new Response("invalid"),
  new Response("private provider detail", { status: 401 }),
])("handles invalid or failed transcription without echoing provider bodies", async (response) => {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  const h = harness();
  await h.take.start({ ...config, token: "" });
  h.take.stop();
  await h.terminal;
  expect(h.texts).toEqual([]);
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0]).not.toContain("private provider detail");
  expect(h.states.at(-1)).toBe("idle");
});
test("cleans up when recording fails, is empty, or exceeds the byte cap", async () => {
  for (const mode of ["start", "empty", "oversize"]) {
    failStart = mode === "start";
    bytes = mode === "empty" ? 0 : dictationMaxBytes + 1;
    const h = harness();
    await h.take.start(config);
    if (!failStart) h.take.stop();
    await h.terminal;
    expect(h.errors).toHaveLength(1);
    expect(h.texts).toEqual([]);
    expect(stopped).toBeGreaterThan(0);
  }
});
test("microphone denial and missing browser support are actionable", async () => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("synthetic denial"));
  const h = harness();
  await h.take.start(config);
  expect(h.errors[0]).toContain("Allow access");
  Object.defineProperty(globalThis, "isSecureContext", { value: false });
  await h.take.start(config);
  expect(h.errors[1]).toContain("HTTPS");
});
