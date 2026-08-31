import { expect, test } from "bun:test";

import {
  BENCHMARK_IMAGE_BYTES,
  generateBenchmarkBmp,
  parseBlobStorageBenchmarkArgs,
} from "../scripts/bench-blob-storage";

test("blob storage benchmark parses bounded CLI options", () => {
  const parsed = parseBlobStorageBenchmarkArgs([
    "--config",
    "config.yaml",
    "--data-dir",
    "data",
    "--warmups",
    "3",
    "--runs",
    "12",
    "--target-ms",
    "95.5",
  ]);

  expect(parsed).toMatchObject({
    status: "ok",
    value: {
      warmups: 3,
      runs: 12,
      targetMs: 95.5,
    },
  });
  expect(parseBlobStorageBenchmarkArgs(["--help"])).toMatchObject({
    status: "ok",
    value: "help",
  });
  expect(parseBlobStorageBenchmarkArgs(["--config", "config.yaml"]).status).toBe("error");
  expect(
    parseBlobStorageBenchmarkArgs(["--config", "config.yaml", "--data-dir", "data", "--runs", "0"])
      .status,
  ).toBe("error");
});

test("blob storage benchmark generates a deterministic one-mebibyte-class BMP", () => {
  const first = generateBenchmarkBmp();
  const second = generateBenchmarkBmp();
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);

  expect(first).toEqual(second);
  expect(first.byteLength).toBe(BENCHMARK_IMAGE_BYTES);
  expect(first.byteLength).toBeGreaterThanOrEqual(1_000_000);
  expect(first.byteLength).toBeLessThanOrEqual(1_048_576);
  expect(new TextDecoder().decode(first.subarray(0, 2))).toBe("BM");
  expect(view.getUint32(2, true)).toBe(first.byteLength);
  expect(view.getUint32(10, true)).toBe(54);
  expect(view.getInt32(18, true)).toBe(592);
  expect(view.getInt32(22, true)).toBe(590);
  expect(view.getUint16(28, true)).toBe(24);
});
