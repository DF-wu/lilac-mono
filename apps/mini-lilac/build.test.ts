import { describe, expect, it } from "bun:test";

import {
  decodeSourcePackage,
  hasOpenTuiCoreImport,
  MiniLilacBuildPatchMissing,
  signalBuildFailure,
} from "./build";

const validSourcePackage = {
  name: "@stanley2058/mini-lilac",
  version: "0.0.1",
  description: "Mini Lilac",
  keywords: ["agent"],
  license: "MIT",
  repository: {
    type: "git",
    url: "https://example.test/repository.git",
    directory: "apps/mini-lilac",
  },
  homepage: "https://example.test/mini-lilac",
  publishConfig: { access: "public" },
  engines: { bun: ">=1.3.14" },
  dependencies: { "@opentui/core": "0.4.3", "better-result": "catalog:" },
};

describe("mini-lilac build boundaries", () => {
  it("decodes source package metadata as a Result", () => {
    const valid = decodeSourcePackage(validSourcePackage);
    expect(valid.status).toBe("ok");
    if (valid.status === "ok") {
      expect(valid.value.dependencies).toEqual({ "@opentui/core": "0.4.3" });
    }

    const invalid = decodeSourcePackage({
      ...validSourcePackage,
      publishConfig: { access: "private" },
    });
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") {
      expect(invalid.error._tag).toBe("MiniLilacSourcePackageInvalid");
    }
  });

  it("recognizes only retained @opentui/core JavaScript imports", () => {
    expect(hasOpenTuiCoreImport(["node:path", "@opentui/core"])).toBe(true);
    expect(hasOpenTuiCoreImport(["@opentui/core/render", undefined])).toBe(true);
    expect(hasOpenTuiCoreImport(["@opentui/solid", "@opentui/core-linux-x64"])).toBe(false);
  });

  it("signals a typed build failure through the Bun script host contract", () => {
    const error = new MiniLilacBuildPatchMissing({ message: "patch missing" });
    expect(() => signalBuildFailure(error)).toThrow(error);
  });
});
