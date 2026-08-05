import { describe, expect, it } from "bun:test";

import { decodeNpmPackOutput, NpmPackFailed, signalLocalInstallFailure } from "./install-local";

describe("mini-lilac local install boundaries", () => {
  it("decodes npm pack output as a Result", async () => {
    expect(await decodeNpmPackOutput('[{"filename":"mini-lilac.tgz"}]')).toMatchObject({
      status: "ok",
      value: "mini-lilac.tgz",
    });
  });

  it("distinguishes malformed JSON from invalid npm output", async () => {
    const malformed = await decodeNpmPackOutput("{");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("LocalInstallOperationFailed");
    }

    const invalid = await decodeNpmPackOutput("[]");
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") {
      expect(invalid.error._tag).toBe("NpmPackOutputInvalid");
    }
  });

  it("signals a typed install failure through the Bun script host contract", () => {
    const error = new NpmPackFailed({ exitCode: 1, message: "npm pack failed" });
    expect(() => signalLocalInstallFailure(error)).toThrow("npm pack failed");
  });
});
