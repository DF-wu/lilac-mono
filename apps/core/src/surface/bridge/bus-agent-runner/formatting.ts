/* oxlint-disable eslint/no-control-regex */

import { Result } from "better-result";

export function formatInt(n: number): string {
  // Locale-independent grouping.
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(1)}s`;
}

export function sanitizeFilenameToken(raw: string): string {
  // Keep names mostly readable for humans (diff workflows) while preventing
  // directory traversal or weird control chars.
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "_")
    .replace(/[\\/]/g, "_")
    .slice(0, 200);
}

export function debugJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    function redactDebugValue(key, v) {
      const source = key === "" ? value : this[key];
      if (typeof v === "bigint") return v.toString();
      if (source instanceof URL) {
        const serializedUrl = source.toString();
        if (serializedUrl.toLowerCase().startsWith("data:")) {
          return {
            __type: "inline-data-url",
            redacted: true,
            charLength: serializedUrl.length,
          };
        }
        return serializedUrl;
      }
      if (source instanceof Error) {
        return {
          name: source.name,
          message: source.message,
          stack: source.stack,
        };
      }

      // Context dumps are durable operator files. Never copy hydrated managed
      // blob bytes into them, including Buffers whose toJSON() has already run.
      if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        return {
          __type: source.constructor.name,
          redacted: true,
          byteLength: source.byteLength,
        };
      }

      const parentType = typeof this.type === "string" ? this.type : undefined;
      const isBinaryText =
        typeof v === "string" &&
        ((key === "data" &&
          (parentType === "file" ||
            parentType === "reasoning-file" ||
            parentType === "image" ||
            parentType === "file-data" ||
            parentType === "image-data" ||
            parentType === "data" ||
            parentType === "base64")) ||
          (key === "image" && parentType === "image") ||
          v.toLowerCase().startsWith("data:"));
      if (isBinaryText) {
        return {
          __type: v.toLowerCase().startsWith("data:") ? "inline-data-url" : "base64",
          redacted: true,
          charLength: v.length,
        };
      }

      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }

      return v;
    },
    2,
  );
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value === undefined) return "undefined";
  const serialized = Result.try({ try: () => JSON.stringify(value), catch: () => undefined });
  return serialized.match({ ok: (text) => text ?? String(value), err: () => String(value) });
}
