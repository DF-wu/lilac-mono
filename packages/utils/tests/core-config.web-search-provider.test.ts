import { describe, expect, it } from "bun:test";

import {
  coreConfigSchema,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2ToUniversal,
} from "../core-config";

describe("coreConfigSchema tools.web.extract.providers", () => {
  it("defaults to tavily", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.web.extract.providers).toEqual(["tavily"]);
  });

  it("accepts ordered providers", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["tavily", "exa", "firecrawl"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["tavily", "exa", "firecrawl"]);
  });

  it("accepts legacy singular provider inside extract", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa"]);
  });

  it("accepts legacy search.provider as an alias", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          search: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa"]);
  });

  it("accepts legacy search.providers as an alias", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          search: {
            providers: ["exa", "tavily"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa", "tavily"]);
  });

  it("deduplicates providers while preserving order", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["tavily", "exa", "tavily"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["tavily", "exa"]);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      coreConfigSchema.parse({
        tools: {
          web: {
            extract: {
              provider: "duckduckgo",
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("coreConfigSchema tools.web.fetch.mode", () => {
  it("accepts explicit fetch modes", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          fetch: {
            mode: "provider-only",
          },
        },
      },
    });

    expect(parsed.tools.web.fetch.mode).toBe("provider-only");
  });

  it("accepts firecrawl as a provider", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["firecrawl"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["firecrawl"]);
  });
});

describe("core config tools.web.firecrawl", () => {
  it("leaves Firecrawl concurrency disabled when the v2 block is absent", () => {
    const parsed = parseCoreConfigV2ToUniversal({ configVersion: 2 });

    expect(parsed.tools.web.firecrawl).toBeUndefined();
  });

  it("defaults and parses the opt-in v2 Firecrawl concurrency policy", () => {
    const defaults = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      tools: { web: { firecrawl: {} } },
    });
    expect(defaults.tools.web.firecrawl).toEqual({
      maxConcurrency: 2,
      queueTtlMs: 3_000,
    });

    const configured = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      tools: {
        web: {
          firecrawl: {
            maxConcurrency: 4,
            queueTtl: "1500ms",
          },
        },
      },
    });
    expect(configured.tools.web.firecrawl).toEqual({
      maxConcurrency: 4,
      queueTtlMs: 1_500,
    });
  });

  it("rejects invalid v2 Firecrawl concurrency values", () => {
    for (const firecrawl of [
      { maxConcurrency: 0, queueTtl: "3s" },
      { maxConcurrency: 1.5, queueTtl: "3s" },
      { maxConcurrency: 2, queueTtl: 0 },
    ]) {
      expect(() =>
        parseCoreConfigV2ToUniversal({
          configVersion: 2,
          tools: { web: { firecrawl } },
        }),
      ).toThrow();
    }
  });

  it("keeps Firecrawl concurrency out of the frozen v1 input shape", () => {
    const unknownKeys: string[][] = [];
    const parsed = parseCoreConfigV1ToUniversal(
      {
        configVersion: 1,
        tools: {
          web: {
            firecrawl: {
              maxConcurrency: 2,
              queueTtl: "3s",
            },
          },
        },
      },
      {
        onUnknownKey(path) {
          unknownKeys.push([...path] as string[]);
        },
      },
    );

    expect(unknownKeys).toEqual([["tools", "web", "firecrawl"]]);
    expect(parsed.tools.web.firecrawl).toBeUndefined();
  });
});

describe("coreConfigSchema tools.experimental_hashline_edit", () => {
  it("defaults to false", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.experimental_hashline_edit).toBe(false);
  });

  it("accepts true", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        experimental_hashline_edit: true,
      },
    });
    expect(parsed.tools.experimental_hashline_edit).toBe(true);
  });
});
