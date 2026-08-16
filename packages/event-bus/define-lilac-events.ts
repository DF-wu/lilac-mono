import { z } from "zod";

export type FixedLilacTopic<TTopic extends string> = {
  readonly kind: "fixed";
  readonly topic: TTopic;
  readonly topicSchema: z.ZodType<TTopic>;
  readonly resolveTopic: () => TTopic;
};

export type RequestOutputLilacTopic<TTopic extends string> = {
  readonly kind: "request-output";
  readonly topic: "out.req";
  readonly topicSchema: z.ZodType<TTopic>;
  readonly resolveTopic: (requestId: string) => TTopic;
};

export type LilacTopicDefinition<TTopic extends string = string> =
  | FixedLilacTopic<TTopic>
  | RequestOutputLilacTopic<TTopic>;

export type LilacDataKey<TKey extends string = string> = {
  readonly kind: "data";
  readonly source: TKey;
};

export type LilacRequestIdKey = {
  readonly kind: "header";
  readonly source: "request_id";
};

export type LilacKeyDefinition = LilacDataKey | LilacRequestIdKey;

export type LilacEventDefinition = {
  readonly type: string;
  readonly family: string;
  readonly topic: LilacTopicDefinition;
  readonly key: LilacKeyDefinition;
  readonly data: z.ZodType;
};

export type LilacEventDefinitions = Readonly<Record<string, LilacEventDefinition>>;

type ValidateDataKey<TDefinition extends LilacEventDefinition> =
  TDefinition["key"] extends LilacDataKey<infer TKey>
    ? TKey extends keyof z.output<TDefinition["data"]>
      ? z.output<TDefinition["data"]>[TKey] extends string
        ? unknown
        : { readonly __dataKeyMustReferenceRequiredString: never }
      : { readonly __dataKeyMustExistInPayload: never }
    : unknown;

type ValidateRequestOutputTopic<TDefinition extends LilacEventDefinition> =
  TDefinition["topic"] extends RequestOutputLilacTopic<string>
    ? TDefinition["key"] extends LilacRequestIdKey
      ? unknown
      : { readonly __requestOutputTopicRequiresRequestIdKey: never }
    : unknown;

type ValidateEventDefinitions<TDefinitions extends LilacEventDefinitions> = {
  readonly [TName in keyof TDefinitions]: ValidateDataKey<TDefinitions[TName]> &
    ValidateRequestOutputTopic<TDefinitions[TName]>;
};

type ValidateCatalogNames<TDefinitions extends LilacEventDefinitions> =
  "__proto__" extends keyof TDefinitions
    ? { readonly __protoIsNotAValidCatalogName: never }
    : unknown;

export function fixedTopic<const TTopic extends string>(topic: TTopic): FixedLilacTopic<TTopic> {
  return {
    kind: "fixed",
    topic,
    topicSchema: z.literal(topic),
    resolveTopic: () => topic,
  };
}

export function requestOutputTopic<TTopic extends string>(options: {
  readonly schema: z.ZodType<TTopic>;
  readonly resolve: (requestId: string) => TTopic;
}): RequestOutputLilacTopic<TTopic> {
  return {
    kind: "request-output",
    topic: "out.req",
    topicSchema: options.schema,
    resolveTopic: options.resolve,
  };
}

export function dataKey<const TKey extends string>(source: TKey): LilacDataKey<TKey> {
  return { kind: "data", source };
}

export function headerKey(source: "request_id"): LilacRequestIdKey {
  return { kind: "header", source };
}

/** Define the canonical event catalog while preserving every schema and literal type. */
export function defineLilacEvents<const TDefinitions extends LilacEventDefinitions>(
  definitions: TDefinitions &
    ValidateEventDefinitions<TDefinitions> &
    ValidateCatalogNames<TDefinitions>,
): TDefinitions {
  return definitions;
}

export type LilacEventTypeFromCatalog<TCatalog extends LilacEventDefinitions> =
  TCatalog[keyof TCatalog]["type"];

export type LilacEventDefinitionForType<
  TCatalog extends LilacEventDefinitions,
  TType extends LilacEventTypeFromCatalog<TCatalog>,
> = Extract<TCatalog[keyof TCatalog], { readonly type: TType }>;

export type LilacTopicForDefinition<TDefinition extends LilacEventDefinition> = z.output<
  TDefinition["topic"]["topicSchema"]
>;

export type LilacEventSpecFromCatalog<TCatalog extends LilacEventDefinitions> = {
  [TType in LilacEventTypeFromCatalog<TCatalog>]: {
    topic: LilacTopicForDefinition<LilacEventDefinitionForType<TCatalog, TType>>;
    key: string;
    data: z.output<LilacEventDefinitionForType<TCatalog, TType>["data"]>;
  };
};

export type LilacEventTypesFromCatalog<TCatalog extends LilacEventDefinitions> = {
  readonly [TName in keyof TCatalog]: TCatalog[TName]["type"];
};

/** Project the ergonomic name-to-wire-type constants from the canonical catalog. */
export function createLilacEventTypes<const TCatalog extends LilacEventDefinitions>(
  catalog: TCatalog,
): LilacEventTypesFromCatalog<TCatalog> {
  const eventTypes: Record<string, string> = {};
  for (const name of Object.keys(catalog)) {
    const definition = catalog[name];
    if (definition !== undefined) {
      Object.defineProperty(eventTypes, name, {
        value: definition.type,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  // The loop copies each catalog key to the same key with exactly its literal type value.
  return eventTypes as LilacEventTypesFromCatalog<TCatalog>;
}

type CodecTopicFields<TDefinition extends LilacEventDefinition> =
  TDefinition["topic"] extends RequestOutputLilacTopic<infer TTopic>
    ? {
        readonly topic: "out.req";
        readonly topicSchema: z.ZodType<TTopic>;
        readonly resolveTopic: (requestId: string) => TTopic;
        readonly requiresRequestId: true;
      }
    : TDefinition["topic"] extends FixedLilacTopic<infer TTopic>
      ? {
          readonly topic: TTopic;
          readonly topicSchema: z.ZodType<TTopic>;
          readonly resolveTopic: () => TTopic;
          readonly requiresRequestId: TDefinition["key"] extends LilacRequestIdKey ? true : false;
        }
      : never;

export type LilacEventCodecFromDefinition<TDefinition extends LilacEventDefinition> = {
  readonly type: TDefinition["type"];
  readonly keySource: TDefinition["key"]["source"];
  readonly dataSchema: TDefinition["data"];
} & CodecTopicFields<TDefinition>;

export type LilacEventCodecRegistryFromCatalog<TCatalog extends LilacEventDefinitions> = {
  readonly [TType in LilacEventTypeFromCatalog<TCatalog>]: LilacEventCodecFromDefinition<
    LilacEventDefinitionForType<TCatalog, TType>
  >;
};

/** Derive the public wire-type keyed codec registry from the canonical catalog. */
export function createLilacEventCodecRegistry<const TCatalog extends LilacEventDefinitions>(
  catalog: TCatalog,
): LilacEventCodecRegistryFromCatalog<TCatalog> {
  const codecs: Partial<LilacEventCodecRegistryFromCatalog<TCatalog>> = {};
  for (const definition of Object.values(catalog)) {
    Object.defineProperty(codecs, definition.type, {
      value: {
        type: definition.type,
        topic: definition.topic.topic,
        topicSchema: definition.topic.topicSchema,
        resolveTopic: definition.topic.resolveTopic,
        requiresRequestId:
          definition.topic.kind === "request-output" || definition.key.kind === "header",
        keySource: definition.key.source,
        dataSchema: definition.data,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  // Every codec key and field above is copied from the corresponding typed catalog entry.
  return codecs as LilacEventCodecRegistryFromCatalog<TCatalog>;
}
