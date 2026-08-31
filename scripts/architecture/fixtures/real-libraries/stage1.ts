import { Panic, Result, TaggedError, type UnhandledException } from "better-result";
import type { Logger } from "@stanley2058/simple-module-logger";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

class SecretFailure extends TaggedError("SecretFailure")<{
  readonly cause: unknown;
  readonly secret: string;
}> {}

export type UnhandledAlias = Result<string, UnhandledException>;

export interface UnhandledService {
  load(): Promise<Result<string, UnhandledException>>;
}

export interface UnhandledCallableService {
  (): Result<string, UnhandledException>;
}

export type UnhandledHandler = () => Promise<Result<string, UnhandledException>>;

function laterExportedContract(): Result<string, UnhandledException> {
  return Result.try(() => "value");
}

export { laterExportedContract };

function structuredLog(fields: unknown): void {
  void fields;
}

export function genericCaptureContract() {
  return Result.try(() => JSON.parse("{}"));
}

export function explicitUnhandledContract(): Result<string, UnhandledException> {
  return Result.try(() => "value");
}

export function mappedCaptureContract(): Result<string, SecretFailure> {
  return Result.try({
    try: () => "value",
    catch: (cause) => new SecretFailure({ cause, secret: "redacted" }),
  });
}

export function unknownExpectedErrorContract(): Result<string, unknown> {
  return Result.err("unknown");
}

export function panicExpectedErrorContract(): Result<string, Panic> {
  return Result.err(new Panic({ message: "not expected" }));
}

export async function rejectingFallibleApi(): Promise<string> {
  return "value";
}

export async function resultFallibleApi(): Promise<Result<string, SecretFailure>> {
  return Result.ok("value");
}

export function directResultFallibleApi(): Result<string, SecretFailure> {
  return Result.ok("value");
}

export async function* resultFallibleStream(): AsyncIterable<Result<string, SecretFailure>> {
  yield Result.ok("value");
}

export async function* inferredResultFallibleStream() {
  yield Result.ok("value") as Result<string, SecretFailure>;
}

export async function* wrongResultFallibleStream() {
  yield "not a Result";
}

export function serializeResult(result: Result<string, string>): void {
  JSON.stringify(result);
  const envelope = { result };
  const stringify = JSON.stringify;
  stringify(envelope);
  JSON.stringify({ status: "plain", value: "safe" });
}

export function exposeTaggedError(failure: SecretFailure, logger: Logger): void {
  JSON.stringify(failure);
  const stringify = JSON.stringify;
  stringify({ failure });
  failure.toJSON();
  structuredLog({ failure });
  logger.error("failed", { failure });
}

export function manuallyProjectTaggedError(failure: SecretFailure): void {
  const safe = { tag: failure._tag, message: failure.message };
  JSON.stringify(safe);
  structuredLog(safe);
}

export function aliasTaggedErrorMessage(failure: SecretFailure, logger: Logger): void {
  const message = failure.message;
  logger.error("failed", { message });
  JSON.stringify({ message });
}

export function destructureTaggedErrorMessage(failure: SecretFailure, logger: Logger): void {
  const { message: objectMessage } = failure;
  const [arrayMessage] = [failure.message];
  logger.error("failed", { objectMessage });
  JSON.stringify({ arrayMessage });
}

export function assignTaggedErrorMessage(failure: SecretFailure, logger: Logger): void {
  let loggerMessage = "pending";
  loggerMessage = failure.message;
  let jsonMessage = "pending";
  jsonMessage = failure.message;
  logger.error("failed", { loggerMessage });
  JSON.stringify({ jsonMessage });
}

export function redactTaggedError(failure: SecretFailure, logger: Logger): void {
  const safe = formatTaggedErrorForLog(failure);
  JSON.stringify(safe);
  structuredLog(safe);
  logger.error("failed", safe);
}

export function serializePlainValues(error: Error, failure: SecretFailure, logger: Logger): void {
  const plain = { message: error.message, status: "plain" };
  const source = { plain: "safe", failure };
  const { plain: destructuredPlain } = source;
  const [arrayValue] = ["safe"];
  let assigned = "pending";
  assigned = error.message;
  let overwritten = failure.message;
  overwritten = "safe";
  JSON.stringify(plain);
  JSON.stringify({ arrayValue });
  logger.error("failed", { ...plain, destructuredPlain, assigned, overwritten });
}

export function unrelatedSerialization(
  JSON: { stringify(value: unknown): string },
  value: { toJSON(): object },
): void {
  JSON.stringify(value);
  value.toJSON();
}
