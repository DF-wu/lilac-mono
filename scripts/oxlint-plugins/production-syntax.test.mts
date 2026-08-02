import { describe, expect, it } from "bun:test";

import type { ArchitectureManifest, ExceptionAdapter } from "../architecture/manifest.ts";
import {
  findExceptionFlowViolations,
  findInlineAsyncResultCallbackViolations,
  findLocalRecordGuardViolations,
  findNestedTernaryViolations,
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
        panicSites: [],
        compatibilityOutputs: [],
        operationalResultApis: [],
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

  it("does not hard-fail ambiguous catch/then methods or unused reject parameters", () => {
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

    expect(violations).toEqual([]);
  });

  it("does not infer promises from shadowed fetch or non-promise module and local calls", () => {
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

    expect(violations).toEqual([]);
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
    expect(findExceptionFlowViolations(code, "apps/example/dist/output.js", policyWith())).toEqual(
      [],
    );
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

describe("dormant Stage 2 syntax", () => {
  it("detects configured local record guards except the canonical utility", () => {
    const policy = policyWith({
      recordGuardNames: ["isObjectRecord", "isPlainObject", "isRecord"],
    });
    const code = `
      function isRecord(value: unknown) { return typeof value === "object"; }
      const isPlainObject = (value: unknown) => value !== null;
      function isObjectRecord(value: unknown) { return !!value; }
    `;
    expect(findLocalRecordGuardViolations(code, "apps/example/src/guards.ts", policy)).toHaveLength(
      3,
    );
    expect(
      findLocalRecordGuardViolations(
        `export function isRecord(value: unknown) { return value !== null; }`,
        "packages/utils/runtime-utils.ts",
        policy,
      ),
    ).toEqual([]);
  });

  it("detects nested ternaries but permits a single binary ternary", () => {
    expect(
      findNestedTernaryViolations(
        `const value = first ? (second ? "a" : "b") : "c";`,
        "apps/example/src/render.ts",
        policyWith(),
      ),
    ).toHaveLength(1);
    expect(
      findNestedTernaryViolations(
        `const value = first ? "a" : "b";`,
        "apps/example/src/render.ts",
        policyWith(),
      ),
    ).toEqual([]);
  });
});
