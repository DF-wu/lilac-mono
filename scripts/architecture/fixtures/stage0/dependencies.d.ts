declare module "zod" {
  export interface ZodType<Output = unknown, Input = unknown> {
    readonly _input: Input;
    readonly _output: Output;
    parse(value: unknown): Output;
    parseAsync(value: unknown): Promise<Output>;
    safeParse(value: unknown): { success: true; data: Output } | { success: false };
    safeParseAsync(value: unknown): Promise<{ success: true; data: Output } | { success: false }>;
  }

  export namespace z {
    type input<T extends ZodType> = T["_input"];
    type output<T extends ZodType> = T["_output"];
  }
}

declare module "better-result" {
  export class Ok<A, E = never> {
    readonly status: "ok";
    readonly value: A;
    mapError<F>(mapper: (error: E) => F): Result<A, F>;
    match<B>(handlers: { ok: (value: A) => B; err: (error: E) => B }): B;
    unwrap(): A;
  }

  export class Err<A, E> {
    readonly status: "err";
    readonly error: E;
    mapError<F>(mapper: (error: E) => F): Result<A, F>;
    match<B>(handlers: { ok: (value: A) => B; err: (error: E) => B }): B;
    unwrap(): never;
  }

  export type Result<A, E> = Ok<A, E> | Err<A, E>;

  export const Result: {
    ok<A>(value: A): Ok<A>;
    err<E>(error: E): Err<never, E>;
    unwrap<A, E>(result: Result<A, E>): A;
    try<A, E>(options: { try: () => A; catch: (cause: unknown) => E }): Result<A, E>;
    try<A>(thunk: () => A): Result<A, UnhandledException>;
    tryPromise<A, E>(options: {
      try: () => Promise<A>;
      catch: (cause: unknown) => E;
    }): Promise<Result<A, E>>;
    tryPromise<A>(thunk: () => Promise<A>): Promise<Result<A, UnhandledException>>;
    codec(): {
      serializeUnsafe<A, E>(result: Result<A, E>): unknown;
      deserializeUnsafe(value: unknown): Result<unknown, unknown>;
    };
  };

  export class UnhandledException extends Error {
    readonly _tag: "UnhandledException";
  }

  export class Panic extends Error {
    static is(value: unknown): value is Panic;
  }

  export class TaggedErrorBase extends Error {
    readonly _tag: string;
    match(): void;
  }

  export function panic(message: string): never;
}

declare module "wire-api" {
  export function send(value: unknown): void;
}

declare module "unresolved-result-helper" {
  export function unresolvedMapper(cause: unknown): Error;
}

declare module "third-party-closed" {
  export type ExternalState = "external-idle" | "external-running" | "external-done";
}

declare module "open-protocol-sdk" {
  export interface ProtocolEvent {
    readonly kind: string;
    readonly payload?: string;
  }

  export interface GenericProtocolEvent<T> {
    readonly kind: string;
    readonly payload?: T;
  }

  export type GenericProtocolVariant<T> =
    | { readonly kind: "created"; readonly payload?: T }
    | { readonly kind: "updated"; readonly payload?: T };
}
