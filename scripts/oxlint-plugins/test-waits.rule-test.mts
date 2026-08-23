import { RuleTester } from "oxlint/plugins-dev";

import { noFixedTestWaitRule } from "./test-waits.mts";
import {
  noExceptionFlowRule,
  noElseAfterTerminalRule,
  noInlineAsyncResultCallbackRule,
  noLocalIsRecordRule,
  preferSwitchTrueChainRule,
} from "./production-syntax.mts";

const ruleTester = new RuleTester({
  languageOptions: { sourceType: "module" },
});

ruleTester.run("lilac/no-fixed-test-wait", noFixedTestWaitRule, {
  valid: [
    "await operation;",
    "// test-wait-justification: verifies the real debounce deadline\nawait Bun.sleep(5);",
  ],
  invalid: [
    {
      code: "await Bun.sleep(5);",
      errors: [{ message: /fixed Bun\.sleep progression delay/u, line: 1, column: 6 }],
    },
  ],
});

const productionFile = "apps/example/src/example.ts";

ruleTester.run("lilac/no-exception-flow", noExceptionFlowRule, {
  valid: [
    {
      code: "Result.try({ try: () => operation(), catch: (cause) => mapCause(cause) });",
      filename: productionFile,
    },
  ],
  invalid: [
    {
      code: "function run() { throw new Error('bad'); }",
      filename: productionFile,
      errors: [{ message: /Return a typed Result error/u, line: 1, column: 17 }],
    },
    {
      code: "try { operation(); } finally { cleanup(); }",
      filename: productionFile,
      errors: [{ message: /production try statements are forbidden/u, line: 1, column: 0 }],
    },
  ],
});

ruleTester.run("lilac/no-local-is-record", noLocalIsRecordRule, {
  valid: [
    {
      code: 'export function isRecord(value: unknown) { return typeof value === "object" && value !== null && !Array.isArray(value); }',
      filename: "packages/utils/runtime-utils.ts",
    },
  ],
  invalid: [
    {
      code: 'function asRecord(value: unknown) { return typeof value === "object" && value !== null && !Array.isArray(value); }',
      filename: productionFile,
      errors: [{ message: /Import the canonical isRecord utility/u, line: 1, column: 0 }],
    },
  ],
});

ruleTester.run("lilac/no-inline-async-result-callback", noInlineAsyncResultCallbackRule, {
  valid: [{ code: "values.map(async (value) => value);", filename: productionFile }],
  invalid: [
    {
      code: 'import { Result } from "better-result"; Result.andThenAsync(async (value) => Result.ok(value));',
      filename: productionFile,
      errors: [{ message: /named Result-returning adapter/u, line: 1, column: 60 }],
    },
  ],
});

ruleTester.run("lilac/prefer-switch-true-chain", preferSwitchTrueChainRule, {
  valid: [
    {
      code: "if (a || b) first(); else fallback();",
      filename: productionFile,
    },
  ],
  invalid: [
    {
      code: "if (a || b) first(); else if (c || d) second(); else if (e) third(); else fallback();",
      filename: productionFile,
      errors: [{ message: /Use switch \(true\)/u, line: 1, column: 0 }],
    },
  ],
});

ruleTester.run("lilac/no-else-after-terminal", noElseAfterTerminalRule, {
  valid: [
    {
      code: "if (ready) returnValue(); else fallback();",
      filename: productionFile,
    },
  ],
  invalid: [
    {
      code: "function run() { if (ready) return value; else return fallback; }",
      filename: productionFile,
      errors: [{ message: /Remove this else/u, line: 1, column: 47 }],
    },
  ],
});
