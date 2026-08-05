interface DecodedMember {
  readonly id: string;
}

export function readUnknownMember(value: Record<string, unknown>): string | undefined {
  const id = value.id;
  return typeof id === "string" ? id : undefined;
}

export function destructureUnknownMember(value: Record<string, unknown>): string | undefined {
  const { id } = value;
  return typeof id === "string" ? id : undefined;
}

export function decodeCustomMember(value: Record<string, unknown>): DecodedMember | undefined {
  const id = value.id;
  return typeof id === "string" ? { id } : undefined;
}

export function registeredCustomMember(value: Record<string, unknown>): DecodedMember | undefined {
  const id = value.id;
  return typeof id === "string" ? { id } : undefined;
}

export function iterateUnknown(values: readonly unknown[]): void {
  for (const value of values) void value;
}

export function spreadUnknown(values: readonly unknown[]): unknown[] {
  return [...values];
}

export function objectValuesUnknown(value: Record<string, unknown>): unknown[] {
  return Object.values(value);
}

export function objectEntriesUnknown(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value);
}

export function objectSpreadUnknown(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

export function collectStrings(values: readonly unknown[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === "string") strings.push(value);
  }
  return strings;
}

export function registeredCollectStrings(values: readonly unknown[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === "string") strings.push(value);
  }
  return strings;
}

export function collectTypedStrings(values: readonly string[]): string[] {
  return [...values];
}

export function collectAliased(value: Record<string, unknown>): readonly string[] {
  const values = Object.values;
  const entries = Object.entries;
  return [
    ...values(value).map((item) => String(item)),
    ...entries(value).map(([key, item]) => `${key}:${String(item)}`),
  ];
}

export function collectReflect(value: Record<string, unknown>): {
  readonly id: string;
  readonly count: number;
  readonly active: boolean;
  readonly hasLabel: boolean;
} {
  const get = Reflect.get;
  const has = Reflect.has;
  return {
    id: String(get(value, "id")),
    count: Number(get(value, "count")),
    active: Boolean(get(value, "active")),
    hasLabel: has(value, "label"),
  };
}

export function collectBound(value: Record<string, unknown>): readonly string[] {
  const values = Object.values.bind(Object);
  const entries = Object.entries.bind(Object);
  const stringify = String.bind(undefined);
  return [
    ...values(value).map((item) => stringify(item)),
    ...entries(value).map(([key, item]) => `${key}:${stringify(item)}`),
  ];
}

export function collectObjectCallApply(value: Record<string, unknown>): readonly string[] {
  const values = Object.values;
  const entries = Object.entries;
  return [
    ...values.call(Object, value).map((item) => String(item)),
    ...values.apply(Object, [value]).map((item) => String(item)),
    ...entries.call(Object, value).map(([key, item]) => `${key}:${String(item)}`),
    ...entries.apply(Object, [value]).map(([key, item]) => `${key}:${String(item)}`),
  ];
}

export function collectReflectCall(value: Record<string, unknown>): {
  readonly id: string;
  readonly count: number;
  readonly active: boolean;
  readonly hasLabel: boolean;
  readonly hasName: boolean;
} {
  const get = Reflect.get;
  const has = Reflect.has;
  const reflectedId = get.call(Reflect, value, "id");
  const reflectedCount = get.apply(Reflect, [value, "count"]);
  return {
    id: String.call(undefined, reflectedId),
    count: Number.call(undefined, reflectedCount),
    active: Boolean.call(undefined, get.call(Reflect, value, "active")),
    hasLabel: has.apply(Reflect, [value, "label"]),
    hasName: has.call(Reflect, value, "name"),
  };
}

export function collectReflectBound(value: Record<string, unknown>): {
  readonly id: string;
  readonly hasLabel: boolean;
} {
  const get = Reflect.get.bind(Reflect);
  const has = Reflect.has.bind(Reflect);
  return {
    id: String(get(value, "id")),
    hasLabel: has(value, "label"),
  };
}

export function collectCoercerApply(value: Record<string, unknown>): {
  readonly id: string;
  readonly count: number;
  readonly active: boolean;
} {
  return {
    id: String.apply(undefined, [Reflect.get(value, "id")]),
    count: Number.apply(undefined, [Reflect.get(value, "count")]),
    active: Boolean.apply(undefined, [Reflect.get(value, "active")]),
  };
}

export function collectCoercerBound(value: Record<string, unknown>): {
  readonly id: string;
  readonly count: number;
  readonly active: boolean;
} {
  const stringify = String.bind(undefined);
  const toNumber = Number.bind(undefined);
  const toBoolean = Boolean.bind(undefined);
  return {
    id: stringify(Reflect.get(value, "id")),
    count: toNumber(Reflect.get(value, "count")),
    active: toBoolean(Reflect.get(value, "active")),
  };
}

export function registeredCollectReflect(value: Record<string, unknown>): {
  readonly id: string | undefined;
} {
  const reflected = Reflect.get(value, "id");
  return { id: typeof reflected === "string" ? reflected : undefined };
}

export function collectTypedEntries(value: Record<string, string>): readonly string[] {
  return Object.entries(value).map(([key, item]) => `${key}:${item}`);
}

export function collectTypedCoercions(values: readonly number[]): readonly string[] {
  return values.map(String);
}

export function collectTypedWrapperMatrix(value: Record<string, string>): readonly string[] {
  const values = Object.values;
  const entries = Object.entries;
  const get = Reflect.get.bind(Reflect);
  const has = Reflect.has.bind(Reflect);
  const stringify = String.bind(undefined);
  return [
    ...values.call(Object, value),
    ...values.apply(Object, [value]),
    ...entries.call(Object, value).map(([key, item]) => `${key}:${item}`),
    ...entries.apply(Object, [value]).map(([key, item]) => `${key}:${item}`),
    stringify(get(value, "id")),
    String.apply(undefined, [get(value, "name")]),
    String(has(value, "label")),
  ];
}

export function unrelatedExceptionBoundary(): void {}

export function signalExceptionBoundary(): never {
  throw new Error("fixture host signal");
}

export class ClassFieldExceptionBoundary {
  readonly signal = (): never => {
    throw new Error("fixture class-field host signal");
  };
}
