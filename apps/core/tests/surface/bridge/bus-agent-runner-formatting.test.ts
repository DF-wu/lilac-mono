import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";

import { debugJsonStringify } from "../../../src/surface/bridge/bus-agent-runner/formatting";

describe("bus agent runner debug formatting", () => {
  it("redacts hydrated managed bytes and base64 media from context dumps", () => {
    const managedBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const bufferBytes = Buffer.from("buffer-secret");
    const fileBase64 = Buffer.from("file-secret").toString("base64");
    const imageBase64 = Buffer.from("image-secret").toString("base64");
    const nestedFileBase64 = Buffer.from("nested-file-secret").toString("base64");
    const fileDataBase64 = Buffer.from("file-data-secret").toString("base64");
    const imageDataBase64 = Buffer.from("image-data-secret").toString("base64");
    const reasoningFileBase64 = Buffer.from("reasoning-file-secret").toString("base64");
    const fileDataUrl = `data:application/pdf;base64,${Buffer.from("file-url-secret").toString("base64")}`;
    const imageDataUrl = `data:image/png;base64,${Buffer.from("image-url-secret").toString("base64")}`;
    const percentEncodedDataUrl = "data:text/plain,url-percent-secret";

    const serialized = debugJsonStringify({
      transcript: [
        { type: "file", data: managedBytes, mediaType: "application/octet-stream" },
        { type: "file", data: bufferBytes, mediaType: "application/octet-stream" },
        { type: "file", data: fileBase64, mediaType: "application/octet-stream" },
        { type: "image", image: imageBase64, mediaType: "image/png" },
        {
          type: "file",
          data: { type: "data", data: nestedFileBase64 },
          mediaType: "application/pdf",
        },
        { type: "file-data", data: fileDataBase64, mediaType: "application/pdf" },
        { type: "image-data", data: imageDataBase64, mediaType: "image/png" },
        {
          type: "reasoning-file",
          data: { type: "data", data: reasoningFileBase64 },
          mediaType: "application/json",
        },
        {
          type: "reasoning-file",
          data: reasoningFileBase64,
          mediaType: "application/json",
        },
        {
          type: "file",
          data: { type: "url", url: fileDataUrl },
          mediaType: "application/pdf",
        },
        { type: "file-url", url: fileDataUrl, mediaType: "application/pdf" },
        { type: "image-url", url: new URL(imageDataUrl), mediaType: "image/png" },
        { type: "text", text: percentEncodedDataUrl },
        { type: "file-url", url: "https://example.test/public.pdf" },
      ],
      ref: {
        version: 1,
        objectId: "obj_123",
        sha256: "abc123",
        byteLength: managedBytes.byteLength,
        expiresAt: 123,
      },
    });

    expect(serialized).not.toContain(Buffer.from(managedBytes).toString("base64"));
    expect(serialized).not.toContain("buffer-secret");
    expect(serialized).not.toContain(bufferBytes.toString("base64"));
    expect(serialized).not.toContain(fileBase64);
    expect(serialized).not.toContain(imageBase64);
    expect(serialized).not.toContain(nestedFileBase64);
    expect(serialized).not.toContain(fileDataBase64);
    expect(serialized).not.toContain(imageDataBase64);
    expect(serialized).not.toContain(reasoningFileBase64);
    expect(serialized).not.toContain(fileDataUrl);
    expect(serialized).not.toContain(imageDataUrl);
    expect(serialized).not.toContain(percentEncodedDataUrl);
    expect(serialized).toContain('"redacted": true');
    expect(serialized).toContain('"byteLength": 6');
    expect(serialized).toContain('"objectId": "obj_123"');
    expect(serialized).toContain("https://example.test/public.pdf");
  });
});
