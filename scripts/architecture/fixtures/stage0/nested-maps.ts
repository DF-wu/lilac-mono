import type { ImportedState } from "./union-types.ts";

type StateMap = {
  readonly [State in ImportedState]: string;
};

const nestedAssertions = {
  record: {
    idle: "idle",
  } as Record<ImportedState, string>,
  partial: {
    idle: "idle",
  } as Partial<Record<ImportedState, string>>,
  mapped: {
    idle: "idle",
  } as StateMap,
  exhaustive: {
    idle: "idle",
    running: "running",
    done: "done",
  } satisfies Record<ImportedState, string>,
};

const nestedAnnotations: {
  readonly partial: Partial<Record<ImportedState, string>>;
  readonly exhaustive: Record<ImportedState, string>;
  readonly mapped: StateMap;
} = {
  partial: {
    idle: "idle",
  },
  exhaustive: {
    idle: "idle",
    running: "running",
    done: "done",
  },
  mapped: {
    idle: "idle",
    running: "running",
    done: "done",
  },
};

const rootSatisfies = {
  partial: {
    idle: "idle",
  },
  exhaustive: {
    idle: "idle",
    running: "running",
    done: "done",
  },
} satisfies {
  readonly partial: Partial<Record<ImportedState, string>>;
  readonly exhaustive: Record<ImportedState, string>;
};

const rootAssertion = {
  partial: {
    idle: "idle",
  },
  record: {
    idle: "idle",
    running: "running",
    done: "done",
  },
} as {
  readonly partial: Partial<Record<ImportedState, string>>;
  readonly record: Record<ImportedState, string>;
};

export const nestedMapFixture = {
  nestedAnnotations,
  nestedAssertions,
  rootAssertion,
  rootSatisfies,
};
