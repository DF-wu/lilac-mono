import { afterEach, describe, expect, it } from "bun:test";

import { parseEnv } from "../env";

const providerBaseUrls = [
  ["OPENAI_BASE_URL", "openai"],
  ["OPENAI_COMPATIBLE_BASE_URL", "openaiCompatible"],
  ["XAI_BASE_URL", "xai"],
  ["ANTHROPIC_BASE_URL", "anthropic"],
  ["OPENROUTER_BASE_URL", "openrouter"],
  ["GROQ_BASE_URL", "groq"],
  ["GEMINI_BASE_URL", "google"],
  ["GOOGLE_BASE_URL", "google"],
  ["AI_GATEWAY_BASE_URL", "vercel"],
  ["TYPESAFE_AI_BASE_URL", "typesafe"],
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ["CEREBRAS_API_KEY", "DATA_DIR", "SQLITE_URL", ...providerBaseUrls.map(([key]) => key)].map(
    (key) => [key, process.env[key]],
  ),
);

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
});

describe("parseEnv", () => {
  for (const value of ["", " \t\n ", undefined]) {
    it(`treats ${JSON.stringify(value)} provider base URLs as absent`, () => {
      for (const [key] of providerBaseUrls) {
        if (value === undefined) {
          delete process.env[key];
          continue;
        }
        process.env[key] = value;
      }

      const env = parseEnv();

      for (const [key, provider] of providerBaseUrls) {
        expect(env.providers[provider].baseUrl).toBeUndefined();
        expect(process.env[key]).toBeUndefined();
      }
    });
  }

  it("preserves configured provider base URLs", () => {
    for (const [key] of providerBaseUrls) process.env[key] = "https://provider.example.test/v1/";

    const env = parseEnv();

    for (const [key, provider] of providerBaseUrls) {
      expect(env.providers[provider].baseUrl).toBe("https://provider.example.test/v1/");
      expect(process.env[key]).toBe("https://provider.example.test/v1/");
    }
  });

  it("uses GOOGLE_BASE_URL when GEMINI_BASE_URL is blank", () => {
    process.env.GEMINI_BASE_URL = " ";
    process.env.GOOGLE_BASE_URL = "https://google.example.test/v1beta";

    expect(parseEnv().providers.google.baseUrl).toBe("https://google.example.test/v1beta");
  });
  it("derives the default sqlite path from DATA_DIR", () => {
    process.env.DATA_DIR = "/tmp/lilac-data";
    delete process.env.SQLITE_URL;

    const env = parseEnv();

    expect(env.dataDir).toBe("/tmp/lilac-data");
    expect(env.sqliteUrl).toBe("/tmp/lilac-data/data.sqlite3");
  });

  it("prefers SQLITE_URL when it is set", () => {
    process.env.DATA_DIR = "/tmp/lilac-data";
    process.env.SQLITE_URL = "/tmp/custom/workflows.sqlite3";

    const env = parseEnv();

    expect(env.sqliteUrl).toBe("/tmp/custom/workflows.sqlite3");
  });

  it("loads Cerebras credentials", () => {
    process.env.CEREBRAS_API_KEY = "test-cerebras-key";

    expect(parseEnv().providers.cerebras.apiKey).toBe("test-cerebras-key");
  });
});

describe("provider initialization", () => {
  for (const modulePath of ["../model-provider.ts", "../index.ts"]) {
    for (const value of ["", " \t "]) {
      it(`imports ${modulePath} with ${JSON.stringify(value)} base URLs`, async () => {
        const moduleUrl = new URL(modulePath, import.meta.url).href;
        const source = `
          const { providers } = await import(${JSON.stringify(moduleUrl)});
          if (!providers.anthropic || !providers.openai) throw new Error("Expected default providers");
          if (providers["openai-compatible"] !== null) throw new Error("Blank compatible URL must disable the provider");
        `;
        const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
          cwd: new URL("..", import.meta.url).pathname,
          env: {
            ...process.env,
            ...Object.fromEntries(providerBaseUrls.map(([key]) => [key, value])),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      });
    }
  }
});
