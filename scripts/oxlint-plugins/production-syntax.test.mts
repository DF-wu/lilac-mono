import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import type { ArchitectureManifest, ExceptionAdapter } from "../architecture/manifest.ts";
import {
  findExceptionFlowViolations,
  findInlineAsyncResultCallbackViolations,
  findLocalRecordGuardViolations,
} from "./production-syntax.mts";
import { type SyntacticPolicy, SYNTACTIC_POLICY } from "./syntax-policy.mts";

function policyWith(overrides: Partial<SyntacticPolicy> = {}): SyntacticPolicy {
  return { ...SYNTACTIC_POLICY, ...overrides };
}

function manifestWithAdapters(adapters: readonly ExceptionAdapter[]): ArchitectureManifest {
  return {
    version: 1,
    workspaces: [
      {
        name: "apps/example",
        packageName: "@example/app",
        root: "apps/example",
        tsconfig: "apps/example/tsconfig.json",
        status: "inventory",
        ruleZones: {},
        boundaryDecoders: [],
        opaqueUnknown: [],
        capabilityPredicates: [],
        exceptionAdapters: adapters,
        openProtocolAdapters: [],
        panicSites: [],
        compatibilityOutputs: [],
        structuredLoggers: [],
        taggedErrorFormatters: [],
        operationalResultApis: [],
        zeroBaselineScopes: [],
        eventCodecRegistries: [],
        rawEventMessageBoundaries: [],
        eventDeliveryApis: [],
        eventDeliveryConsumers: [],
        eventFamilyMigrations: [],
        baselines: { boundaryValidation: "unused", failureFlow: "unused" },
      },
    ],
  };
}

function adapter(exportName: string, direction: ExceptionAdapter["direction"]): ExceptionAdapter {
  return {
    identity: { module: "src/adapter.ts", exportName },
    category: direction === "signal-host" ? "result-to-framework" : "external-to-result",
    externalApi: { package: "example-host", exportName: "operation" },
    direction,
    reason: "Test exact adapter registration",
  };
}

describe("production exception syntax", () => {
  it("detects only syntactically proven Promise rejection channels and aliases", () => {
    const violations = findExceptionFlowViolations(
      `
        const P = globalThis.Promise;
        const rejectPromise = P.reject;
        const direct = Promise.resolve(1);
        let assigned;
        assigned = P.resolve(2);
        async function load() { return 1; }
        Promise.reject(error);
        globalThis.Promise.reject(error);
        rejectPromise(error);
        direct.catch(handleRejected);
        assigned.then(useValue, handleRejected);
        load().then(useValue, handleRejected);
        new P((resolve, reject) => reject(error));
        new Promise((resolve, reject) => { const fail = reject; fail(error); });
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-reject",
      "promise-reject",
      "promise-reject",
      "promise-catch",
      "rejection-callback",
      "rejection-callback",
      "rejection-callback",
      "rejection-callback",
    ]);
  });

  it("detects global fetch, promise-only standard imports, local async calls, and wrapped reject", () => {
    const violations = findExceptionFlowViolations(
      `
        import fsp from "node:fs/promises";
        import { readFile as read } from "fs/promises";
        import * as dns from "node:dns/promises";
        import { pipeline } from "stream/promises";
        import { setTimeout as delay } from "node:timers/promises";
        beforeDeclaration().catch(handleRejected);
        async function beforeDeclaration() { return 1; }
        const local = (async () => 2);
        fetch(url).catch(handleRejected);
        globalThis.fetch(url).then(useValue, handleRejected);
        fsp.readFile(path).catch(handleRejected);
        read(path).catch(handleRejected);
        dns.lookup(host).catch(handleRejected);
        pipeline(source, destination).catch(handleRejected);
        delay(1).catch(handleRejected);
        (local)().catch(handleRejected);
        (Promise.reject)(error);
        (Promise.reject as typeof Promise.reject)(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "promise-catch",
      "rejection-callback",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-reject",
      "promise-reject",
    ]);
  });

  it("treats every catch method and non-nullish then rejection callback as exception flow", () => {
    const violations = findExceptionFlowViolations(
      `
        cache.catch(handleMiss);
        query.then(useValue, handleRejected);
        query.then(useValue, null);
        Promise.resolve(1).then(useValue, null);
        Promise.resolve(1).then(useValue, undefined);
        new Promise((resolve, reject) => resolve(1));
        logger.error("reported");
        controller.error(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "rejection-callback",
    ]);
  });

  it("detects spread arguments that can occupy the then rejection callback slot", () => {
    const violations = findExceptionFlowViolations(
      `
        task.then(...callbacks);
        task.then(useValue, ...rejectionCallbacks);
        task.then(useValue);
        task.then(useValue, null, ...laterCallbacks);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "rejection-callback",
      "rejection-callback",
    ]);
  });

  it("does not require Promise provenance for catch methods", () => {
    const violations = findExceptionFlowViolations(
      `
        import { readFile } from "node:fs";
        import { createInterface } from "node:readline/promises";
        function local() { return cache; }
        function withFetch(fetch: () => { catch(handler: unknown): void }) {
          fetch().catch(handleRejected);
        }
        client.fetch(url).catch(handleRejected);
        readFile(path, callback).catch(handleRejected);
        createInterface(options).catch(handleRejected);
        local().catch(handleRejected);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
      "promise-catch",
    ]);
  });

  it("detects throws, catches, and explicit host stream/error signals", () => {
    const violations = findExceptionFlowViolations(
      `
        function run() { try { throw new Error("bad"); } catch (error) { return error; } }
        new ReadableStream({ start(controller) { controller.error(error); } });
        emitter.emit("error", error);
        socket.destroy(error);
      `,
      "apps/example/src/service.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "throw",
      "catch-clause",
      "stream-error-signal",
      "stream-error-signal",
      "stream-error-signal",
    ]);
  });

  it("owns Stage 1 TaggedError throws, broad catches, and rejected Result promises", () => {
    const violations = findExceptionFlowViolations(
      `
        import { TaggedError, type Result } from "better-result";
        class Failure extends TaggedError("Failure") {}
        export function throwsTaggedError(): Result<string, Failure> {
          throw new Failure();
        }
        export function broadCatch(): Result<string, Failure> {
          try { return operation(); } catch (cause) { return mapCause(cause); }
        }
        export function rejectsResultPromise(): Promise<Result<string, Failure>> {
          return Promise.reject(new Failure());
        }
      `,
      "apps/example/src/stage1.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      "throw",
      "catch-clause",
      "promise-reject",
    ]);
    expect(violations.map((violation) => violation.message)).toEqual([
      "Return a typed Result error; throw only in an exactly registered adapter",
      "Capture the external exception in an exactly registered adapter; try/finally remains allowed",
      "Return Result.err instead of Promise.reject",
    ]);
  });

  it("uses exact adapter identities and permissions from the shared architecture manifest", () => {
    const code = `
      export function captureExternal() { try { return operation(); } catch (error) { throw error; } }
      export function signalHost() { throw new Error("host"); }
      export function domainFlow() { throw new Error("domain"); }
    `;
    const manifest = manifestWithAdapters([
      adapter("captureExternal", "capture-external"),
      adapter("signalHost", "signal-host"),
    ]);

    expect(
      findExceptionFlowViolations(code, "apps/example/src/adapter.ts", policyWith(), manifest).map(
        (violation) => [violation.symbol, violation.kind],
      ),
    ).toEqual([
      ["captureExternal", "throw"],
      ["domainFlow", "throw"],
    ]);
  });

  it("builds exact class and property-arrow symbol paths", () => {
    const violations = findExceptionFlowViolations(
      `
        class Runner {
          capture = () => { throw new Error("capture"); };
          handlers = { fail: () => { throw new Error("handler"); } };
        }
        const Controller = class { fail = () => { throw new Error("class expression"); }; };
        const handlers = { fail: () => { throw new Error("object"); } };
        function outer() { values.map(() => { throw new Error("callback"); }); }
      `,
      "apps/example/src/symbols.ts",
      policyWith(),
    );

    expect(violations.map((violation) => violation.symbol)).toEqual([
      "Runner.capture",
      "Runner.handlers.fail",
      "Controller.fail",
      "handlers.fail",
      "outer",
    ]);
    expect(violations.every((violation) => violation.digest.length === 64)).toBe(true);
  });

  it("uses exact test/generated exclusions without excluding arbitrary fixture directories", () => {
    const code = `throw new Error("fixture");`;
    expect(
      findExceptionFlowViolations(code, "apps/example/src/fixtures/production.ts", policyWith()),
    ).toHaveLength(1);
    expect(
      findExceptionFlowViolations(code, "apps/example/tests/support.ts", policyWith()),
    ).toEqual([]);
    expect(findExceptionFlowViolations(code, "apps/example/test/support.ts", policyWith())).toEqual(
      [],
    );
    expect(
      findExceptionFlowViolations(code, "apps/example/__tests__/support.ts", policyWith()),
    ).toEqual([]);
    expect(findExceptionFlowViolations(code, "apps/example/dist/output.js", policyWith())).toEqual(
      [],
    );
    expect(
      findExceptionFlowViolations(code, "apps/example/generated/output.js", policyWith()),
    ).toEqual([]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/core/src/ssh/remote-js/remote-runner.cjs",
        policyWith(),
      ),
    ).toEqual([]);
    expect(
      findExceptionFlowViolations(
        code,
        "apps/core/src/ssh/remote-js/remote-runner-entry.ts",
        policyWith(),
      ),
    ).toHaveLength(1);
  });
});

describe("Result callback syntax", () => {
  it("tracks imports, namespaces, aliases, assignments, and typed Result values", () => {
    const violations = findInlineAsyncResultCallbackViolations(
      `
        import { Result as R, ok as makeOk } from "better-result";
        import * as Better from "better-result";
        R.map(async (value) => value);
        const banana = R.ok(1);
        const copied = banana;
        copied.andThenAsync(async (value) => R.ok(value));
        const made = makeOk(1);
        made.tapAsync(async (value) => observe(value));
        let assigned;
        assigned = Better.Result.err(error);
        assigned.tryRecoverAsync(async () => makeOk(1));
        Better.Result.tapBothAsync({
          ok: async (value) => observe(value),
          err: async (cause) => observe(cause),
        });
        function typed(typedValue: R<number, Error>) {
          return typedValue.tapErrorAsync(async (cause) => observe(cause));
        }
      `,
      "apps/example/src/result-flow.ts",
      policyWith(),
    );

    expect(violations).toHaveLength(7);
  });

  it("does not infer Result provenance from variable names or unrelated methods", () => {
    const violations = findInlineAsyncResultCallbackViolations(
      `
        import { Result as R } from "better-result";
        values.map(async (value) => value);
        userResult.andThenAsync(async (value) => value);
        pipeline.tapAsync(async (value) => value);
        let later;
        later.map(async (value) => value);
        later = R.ok(1);
      `,
      "apps/example/src/result-flow.ts",
      policyWith(),
    );

    expect(violations).toEqual([]);
  });
});

describe("local record guard syntax", () => {
  it("detects canonical record guards regardless of name except the canonical utility", () => {
    const policy = policyWith();
    const code = `
      function asRecord(value: unknown) {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }
      const objectLike = (candidate: unknown) =>
        !Array.isArray(candidate) && candidate !== null && typeof candidate === "object";
    `;
    expect(findLocalRecordGuardViolations(code, "apps/example/src/guards.ts", policy)).toHaveLength(
      2,
    );
    expect(
      findLocalRecordGuardViolations(
        `export function isRecord(value: unknown) {
          return typeof value === "object" && value !== null && !Array.isArray(value);
        }`,
        "packages/utils/runtime-utils.ts",
        policy,
      ),
    ).toEqual([]);
  });

  it("detects multi-return guards in functions, class fields, and object properties", () => {
    const code = `
      function asRecord(value: unknown): Record<string, unknown> | undefined {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
        return value as Record<string, unknown>;
      }
      class GuardSet {
        asRecord = function (candidate: unknown): Record<string, unknown> | undefined {
          if (typeof candidate !== "object" || candidate === null) return undefined;
          if (Array.isArray(candidate)) return undefined;
          return candidate as Record<string, unknown>;
        };
      }
      const guards = {
        objectRecord: (input: unknown): Record<string, unknown> | undefined => {
          if (Array.isArray(input) || input === null || typeof input !== "object") return undefined;
          return input as Record<string, unknown>;
        },
      };
    `;
    expect(
      findLocalRecordGuardViolations(code, "apps/example/src/multi-return-guards.ts", policyWith()),
    ).toHaveLength(3);
  });

  it("allows complete decoders, capability checks, and wrappers around canonical isRecord", () => {
    const code = `
      import { isRecord } from "@stanley2058/lilac-utils";
      function decodeService(value: unknown): value is { id: string } {
        return typeof value === "object" && value !== null && !Array.isArray(value)
          && "id" in value && typeof value.id === "string";
      }
      function hasRunCapability(value: unknown): value is { run(): void } {
        return isRecord(value) && typeof value.run === "function";
      }
      function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
        return isRecord(value) ? value : undefined;
      }
      function decodeNamed(value: unknown): { id: string } | undefined {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
        if (!("id" in value) || typeof value.id !== "string") return undefined;
        return value as { id: string };
      }
      const capabilities = {
        runnable: (value: unknown): { run(): void } | undefined => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
          if (!("run" in value) || typeof value.run !== "function") return undefined;
          return value as { run(): void };
        },
      };
    `;
    expect(
      findLocalRecordGuardViolations(code, "apps/example/src/decoders.ts", policyWith()),
    ).toEqual([]);
  });
});

describe("Oxlint production syntax activation", () => {
  it("enables production-only syntax rules and preserves generated exclusions", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../.oxlintrc.json", import.meta.url), "utf8"),
    );
    expect(config).toMatchObject({
      ignorePatterns: [
        "ref/**",
        "node_modules/**",
        "data/**",
        "**/dist/**",
        "**/generated/**",
        "apps/core/src/ssh/remote-js/remote-runner.cjs",
      ],
      overrides: [
        {
          files: ["apps/**/*.{js,jsx,cjs,mjs,ts,tsx}", "packages/**/*.{js,jsx,cjs,mjs,ts,tsx}"],
          rules: {
            "no-nested-ternary": "error",
            "lilac/no-local-is-record": "error",
          },
        },
        {
          files: [
            "**/*.test.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
            "**/*.spec.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
            "**/test/**/*.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
            "**/tests/**/*.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
            "**/__tests__/**/*.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
          ],
          rules: {
            "no-nested-ternary": "off",
            "lilac/no-local-is-record": "off",
          },
        },
      ],
    });
  });
});
