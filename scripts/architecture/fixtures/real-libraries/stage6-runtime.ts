import type { Result as ResultType } from "better-result";

import {
  decodeFixtureAboutness,
  decodeFixtureImportance,
  decodeFixtureStringArray,
  fixtureAboutnessCases,
  fixtureImportanceCases,
  fixtureStringArrayCases,
} from "./stage6-persistence.ts";
import {
  createFixtureDatabase,
  fixturePanic,
  fixtureRowCount,
  goodFixtureTransactionConsumer,
  runFixtureSqliteTransaction,
} from "./stage6-transactions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyCatalog<T>(
  decode: (
    input: string | null,
  ) => ResultType<{ readonly value: T; readonly provenance: string }, unknown>,
  catalog: Readonly<
    Record<
      string,
      {
        readonly input: string | null;
        readonly outcome: "ok" | "error";
        readonly provenance?: string;
      }
    >
  >,
): void {
  for (const [name, fixture] of Object.entries(catalog)) {
    const result = decode(fixture.input);
    assert(result.status === fixture.outcome, `${name} produced ${result.status}`);
    if (result.status === "ok" && fixture.outcome === "ok") {
      assert(result.value.provenance === fixture.provenance, `${name} provenance drifted`);
    }
  }
}

verifyCatalog(decodeFixtureStringArray, fixtureStringArrayCases);
verifyCatalog(decodeFixtureImportance, fixtureImportanceCases);
verifyCatalog(decodeFixtureAboutness, fixtureAboutnessCases);

const database = createFixtureDatabase();
try {
  const committed = goodFixtureTransactionConsumer(database, false);
  assert(committed.status === "ok", "successful operation did not commit");
  assert(fixtureRowCount(database) === 1, "successful operation did not write exactly once");

  const rolledBack = goodFixtureTransactionConsumer(database, true);
  assert(rolledBack.status === "error", "logical failure did not return Err");
  assert(fixtureRowCount(database) === 1, "logical failure did not roll back its write");

  const driverFailure = runFixtureSqliteTransaction(database, () => {
    throw new Error("SQLITE_BUSY fixture");
  });
  assert(driverFailure.status === "error", "recognized driver failure was not mapped to Err");

  const panic = fixturePanic();
  let observed: unknown;
  try {
    runFixtureSqliteTransaction(database, () => {
      throw panic;
    });
  } catch (cause) {
    observed = cause;
  }
  assert(observed === panic, "Panic identity was not preserved");
} finally {
  database.close();
}
