import { RuleTester } from "oxlint/plugins-dev";

import { noFixedTestWaitRule } from "./test-waits.mts";

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
