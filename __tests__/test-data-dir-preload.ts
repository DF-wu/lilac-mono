import { afterAll } from "bun:test";
import { tmpdir } from "node:os";

import {
  createOwnedTestTempRoot,
  reapStaleTestTempRoots,
  removeOwnedTestTempRoot,
  resolveTestTempBaseDirectory,
  TEST_TEMP_ROOT_BASE_ENV,
} from "./test-temp-root";

const baseDirectory = resolveTestTempBaseDirectory(
  process.env[TEST_TEMP_ROOT_BASE_ENV] ?? tmpdir(),
);
process.env[TEST_TEMP_ROOT_BASE_ENV] = baseDirectory;

reapStaleTestTempRoots(baseDirectory);

const testTempRoot = createOwnedTestTempRoot(baseDirectory);
process.env.DATA_DIR = testTempRoot.dataDirectory;
process.env.TMPDIR = testTempRoot.tempDirectory;

const cleanup = () => removeOwnedTestTempRoot(testTempRoot);

afterAll(cleanup);
process.once("exit", cleanup);
