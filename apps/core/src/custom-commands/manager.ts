import { pathToFileURL } from "node:url";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  buildCustomCommandMenuAlias,
  buildCustomCommandTextName,
  CUSTOM_COMMAND_MENU_ALIAS_MAX_LENGTH,
  CUSTOM_COMMAND_TOOL_NAME,
  decodeCustomCommandResult,
  discoverCustomCommands,
  isPanic,
  isRecord,
  opaqueErrorCause,
  opaqueErrorMessage,
  parseCustomCommandToken,
  type CustomCommandArgDef,
  type CustomCommandContext,
  type CustomCommandDiscoveryDependencies,
  type CustomCommandDiscoveryError,
  type CustomCommandResult,
  type CustomCommandToken,
  type DiscoveredCustomCommand,
  type ParseCustomCommandTokenOpts,
} from "@stanley2058/lilac-utils";

type CustomCommandErrorDetails = {
  readonly commandName: string;
  readonly entrypointPath: string;
  readonly message: string;
};

type CustomCommandModule = {
  readonly execute: (args: readonly unknown[], context: CustomCommandContext) => unknown;
};

export class CustomCommandImportError extends TaggedError("CustomCommandImportError")<
  CustomCommandErrorDetails & { readonly cause: unknown }
> {}

export class CustomCommandExecuteMissingError extends TaggedError(
  "CustomCommandExecuteMissingError",
)<CustomCommandErrorDetails> {}

export class CustomCommandExecuteThrownError extends TaggedError("CustomCommandExecuteThrownError")<
  CustomCommandErrorDetails & { readonly cause: unknown }
> {}

export class CustomCommandExecuteRejectedError extends TaggedError(
  "CustomCommandExecuteRejectedError",
)<CustomCommandErrorDetails & { readonly cause: unknown }> {}

export class CustomCommandResultInvalidError extends TaggedError(
  "CustomCommandResultInvalidError",
)<CustomCommandErrorDetails> {}

export type CustomCommandExecutionError =
  | CustomCommandImportError
  | CustomCommandExecuteMissingError
  | CustomCommandExecuteThrownError
  | CustomCommandExecuteRejectedError
  | CustomCommandResultInvalidError;

export class CustomCommandUnknownError extends TaggedError("CustomCommandUnknownError")<{
  readonly commandName: string;
  readonly message: string;
}> {}

export class CustomCommandUnterminatedQuoteError extends TaggedError(
  "CustomCommandUnterminatedQuoteError",
)<{
  readonly quote: "'" | '"';
  readonly message: string;
}> {}

export class CustomCommandNumberArgumentError extends TaggedError(
  "CustomCommandNumberArgumentError",
)<{
  readonly token: string;
  readonly message: string;
}> {}

export class CustomCommandBooleanArgumentError extends TaggedError(
  "CustomCommandBooleanArgumentError",
)<{
  readonly token: string;
  readonly message: string;
}> {}

export class CustomCommandArgumentChoiceError extends TaggedError(
  "CustomCommandArgumentChoiceError",
)<{
  readonly argumentKey: string;
  readonly choices: readonly string[];
  readonly value: string;
  readonly message: string;
}> {}

export class CustomCommandUnknownArgumentError extends TaggedError(
  "CustomCommandUnknownArgumentError",
)<{
  readonly argumentKey: string;
  readonly commandTextName: string;
  readonly message: string;
}> {}

export class CustomCommandRequiredArgumentError extends TaggedError(
  "CustomCommandRequiredArgumentError",
)<{
  readonly argumentKey: string;
  readonly message: string;
}> {}

type CustomCommandArgumentValueError =
  | CustomCommandNumberArgumentError
  | CustomCommandBooleanArgumentError;
export type CustomCommandArgumentValue = string | number | boolean;
type ParsedCustomCommandArgument = CustomCommandArgumentValue | undefined;
export type CustomCommandInvocationError =
  | CustomCommandUnknownError
  | CustomCommandUnterminatedQuoteError
  | CustomCommandArgumentValueError
  | CustomCommandArgumentChoiceError
  | CustomCommandUnknownArgumentError
  | CustomCommandRequiredArgumentError;

export function customCommandInvocationErrorText(error: CustomCommandInvocationError): string {
  switch (error._tag) {
    case "CustomCommandUnknownError":
    case "CustomCommandUnterminatedQuoteError":
    case "CustomCommandNumberArgumentError":
    case "CustomCommandBooleanArgumentError":
    case "CustomCommandArgumentChoiceError":
    case "CustomCommandUnknownArgumentError":
    case "CustomCommandRequiredArgumentError":
      return error.message;
  }
}

function continueInvocation<T, U>(
  result: ResultType<T, CustomCommandInvocationError>,
  onOk: (value: T) => ResultType<U, CustomCommandInvocationError>,
): ResultType<U, CustomCommandInvocationError> {
  const continuation = result.match<() => ResultType<U, CustomCommandInvocationError>>({
    err: (error) => () => Result.err(error),
    ok: (value) => () => onOk(value),
  });
  return continuation();
}

function decodeCustomCommandModule(value: unknown): CustomCommandModule | null {
  if (!isRecord(value) || typeof value["execute"] !== "function") return null;
  const execute = value["execute"];
  return {
    execute: (args, context) => execute.call(value, args, context),
  };
}

async function importCustomCommandModule(params: {
  commandName: string;
  entrypointPath: string;
}): Promise<
  ResultType<CustomCommandModule, CustomCommandImportError | CustomCommandExecuteMissingError>
> {
  try {
    const imported: unknown = await import(pathToFileURL(params.entrypointPath).href);
    const commandModule = decodeCustomCommandModule(imported);
    if (commandModule) return Result.ok(commandModule);
    return Result.err(
      new CustomCommandExecuteMissingError({
        ...params,
        message: `Command '${params.commandName}' must export async execute(args, ctx).`,
      }),
    );
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command import failure");
    return Result.err(
      new CustomCommandImportError({
        ...params,
        cause,
        message: `Failed to import command '${params.commandName}': ${opaqueErrorMessage(cause, "Opaque custom-command import failure")}`,
      }),
    );
  }
}

function invokeCustomCommand(params: {
  commandName: string;
  entrypointPath: string;
  run: () => unknown;
}): ResultType<
  Promise<
    ResultType<
      CustomCommandResult,
      CustomCommandExecuteRejectedError | CustomCommandResultInvalidError
    >
  >,
  CustomCommandExecuteThrownError
> {
  try {
    return Result.ok(
      settleCustomCommand({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        execution: params.run(),
      }),
    );
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command execution failure");
    return Result.err(
      new CustomCommandExecuteThrownError({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        cause,
        message: `Command '${params.commandName}' threw while executing: ${opaqueErrorMessage(cause, "Opaque custom-command execution failure")}`,
      }),
    );
  }
}

async function settleCustomCommand(params: {
  commandName: string;
  entrypointPath: string;
  execution: unknown;
}): Promise<
  ResultType<
    CustomCommandResult,
    CustomCommandExecuteRejectedError | CustomCommandResultInvalidError
  >
> {
  try {
    const value: unknown = await params.execution;
    const decoded = decodeCustomCommandResult(value);
    if (decoded !== null) return Result.ok(decoded);
    return Result.err(
      new CustomCommandResultInvalidError({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        message: `Command '${params.commandName}' returned an invalid tool result payload.`,
      }),
    );
  } catch (caught) {
    if (isPanic(caught)) throw caught;
    const cause = opaqueErrorCause(caught, "Opaque custom-command rejection");
    return Result.err(
      new CustomCommandExecuteRejectedError({
        commandName: params.commandName,
        entrypointPath: params.entrypointPath,
        cause,
        message: `Command '${params.commandName}' rejected while executing: ${opaqueErrorMessage(cause, "Opaque custom-command rejection")}`,
      }),
    );
  }
}

function validateArgChoice(
  arg: CustomCommandArgDef,
  value: CustomCommandArgumentValue,
): ResultType<CustomCommandArgumentValue, CustomCommandArgumentChoiceError> {
  if (arg.type !== "string" || typeof value !== "string" || !arg.choices?.length) {
    return Result.ok(value);
  }
  if (arg.choices.includes(value)) return Result.ok(value);

  return Result.err(
    new CustomCommandArgumentChoiceError({
      argumentKey: arg.key,
      choices: arg.choices,
      value,
      message: `Argument '${arg.key}' must be one of: ${arg.choices.join(", ")}.`,
    }),
  );
}

function parseStringToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function parseNumberToken(token: string): ResultType<number, CustomCommandNumberArgumentError> {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    return Result.err(
      new CustomCommandNumberArgumentError({
        token,
        message: `Expected a number, got '${token}'.`,
      }),
    );
  }
  return Result.ok(value);
}

function parseBooleanToken(token: string): ResultType<boolean, CustomCommandBooleanArgumentError> {
  const value = token.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(value)) return Result.ok(true);
  if (["false", "0", "no", "n", "off"].includes(value)) return Result.ok(false);
  return Result.err(
    new CustomCommandBooleanArgumentError({
      token,
      message: `Expected a boolean, got '${token}'.`,
    }),
  );
}

function parseArgValue(
  type: "string" | "number" | "boolean",
  raw: string,
): ResultType<CustomCommandArgumentValue, CustomCommandArgumentValueError> {
  if (type === "string") return Result.ok(parseStringToken(raw));
  if (type === "number") return parseNumberToken(raw);
  return parseBooleanToken(raw);
}

export type MenuAliasCandidate = {
  readonly name: string;
  readonly dir: string;
  readonly textName: string;
};

export type MenuAliasAssignment = {
  /** Registry name -> published alias, for the commands that got one. */
  readonly aliases: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
};

/**
 * Assign one menu alias per command, dropping the ones that cannot get a
 * unique, representable alias.
 *
 * Kept pure and exported so the collision branch is directly testable. With
 * today's name grammar (`[a-z0-9]+(-[a-z0-9]+)*`, no underscores) the `-` to
 * `_` mapping is injective and a collision cannot actually occur — but that is
 * a property of the schema, not of this function, so the branch stays and is
 * exercised with adversarial input rather than assumed unreachable.
 *
 * Candidates are walked in sorted-name order, so which command wins a
 * collision does not depend on how the filesystem enumerated directories.
 * The sort is by code point rather than `localeCompare`, because the latter
 * orders punctuation by locale and ICU version — which is precisely the
 * non-determinism this ordering exists to remove.
 */
export function assignMenuAliases(candidates: readonly MenuAliasCandidate[]): MenuAliasAssignment {
  const aliases = new Map<string, string>();
  const owners = new Map<string, string>();
  const warnings: string[] = [];

  for (const candidate of [...candidates].sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  })) {
    const alias = buildCustomCommandMenuAlias(candidate.name);

    if (alias === null) {
      warnings.push(
        `${candidate.dir}: '${candidate.name}' has no menu-safe alias (over ${CUSTOM_COMMAND_MENU_ALIAS_MAX_LENGTH} characters once prefixed); it stays available as /${candidate.textName}`,
      );
      continue;
    }

    const owner = owners.get(alias);
    if (owner !== undefined) {
      warnings.push(
        `${candidate.dir}: menu alias '/${alias}' is already taken by '${owner}'; '${candidate.name}' stays available as /${candidate.textName}`,
      );
      continue;
    }

    owners.set(alias, candidate.name);
    aliases.set(candidate.name, alias);
  }

  return { aliases, warnings };
}

/** Bot command menus render a single line, so embedded newlines break layout. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function tokenize(text: string): ResultType<string[], CustomCommandUnterminatedQuoteError> {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        cur += ch;
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }

    if (/\s/u.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (quote) {
    return Result.err(
      new CustomCommandUnterminatedQuoteError({
        quote,
        message: `Unterminated ${quote} quote in command input.`,
      }),
    );
  }
  if (cur.length > 0) out.push(cur);
  return Result.ok(out);
}

export type LoadedCustomCommand = DiscoveredCustomCommand & {
  textName: string;
  /**
   * Menu-safe alias, or `null` when the command cannot be advertised in a bot
   * command menu. A `null` here never removes the command — it stays reachable
   * through `textName`.
   */
  menuAlias: string | null;
};

/** One entry of a bot command menu, shaped for Telegram's `setMyCommands`. */
export type CustomCommandMenuEntry = {
  readonly command: string;
  readonly description: string;
};

export type ParsedCustomCommandInvocation = {
  command: LoadedCustomCommand;
  args: ParsedCustomCommandArgument[];
  prompt: string | null;
  text: string;
  source: "text" | "discord-slash";
};

type ParsedArgsAndPrompt = {
  args: ParsedCustomCommandArgument[];
  prompt: string | null;
};

export class CustomCommandManager {
  private readonly reserved = new Set(["lilac", "model", "divider"]);
  private readonly byName = new Map<string, LoadedCustomCommand>();
  private readonly byMenuAlias = new Map<string, LoadedCustomCommand>();
  private readonly warnings: string[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly discoveryDependencies?: Partial<CustomCommandDiscoveryDependencies>,
  ) {}

  async init(): Promise<ResultType<void, CustomCommandDiscoveryError>> {
    this.byName.clear();
    this.byMenuAlias.clear();
    this.warnings.length = 0;

    const discovered = await discoverCustomCommands({
      dataDir: this.dataDir,
      dependencies: this.discoveryDependencies,
    });
    return discovered.map((entries) => {
      for (const entry of entries) {
        if (entry.type === "invalid") {
          this.warnings.push(`${entry.invalid.dir}: ${entry.invalid.reason}`);
          continue;
        }

        const cmd = entry.command;
        if (this.reserved.has(cmd.def.name)) {
          this.warnings.push(`${cmd.dir}: command name '${cmd.def.name}' is reserved`);
          continue;
        }
        if (this.byName.has(cmd.def.name)) {
          this.warnings.push(`${cmd.dir}: duplicate command name '${cmd.def.name}'`);
          continue;
        }

        this.byName.set(cmd.def.name, {
          ...cmd,
          textName: buildCustomCommandTextName(cmd.def.name),
          menuAlias: null,
        });
      }

      this.assignMenuAliases();
    });
  }

  list(): LoadedCustomCommand[] {
    return [...this.byName.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  /**
   * The command menu to publish, in registry order.
   *
   * Only commands with an assigned alias appear; the rest stay invocable by
   * their typed form, and the reason each was left out is in `listWarnings()`.
   */
  listMenuEntries(): CustomCommandMenuEntry[] {
    return this.list().flatMap((cmd) =>
      cmd.menuAlias === null
        ? []
        : [
            {
              command: cmd.menuAlias,
              // Straight from the registry: a placeholder here would describe
              // the menu rather than the command it invokes.
              description: collapseWhitespace(cmd.def.description),
            },
          ],
    );
  }

  private assignMenuAliases(): void {
    const assignment = assignMenuAliases(
      this.list().map((cmd) => ({ name: cmd.def.name, dir: cmd.dir, textName: cmd.textName })),
    );
    this.warnings.push(...assignment.warnings);

    for (const [name, alias] of assignment.aliases) {
      const cmd = this.byName.get(name);
      if (!cmd) continue;
      const withAlias: LoadedCustomCommand = { ...cmd, menuAlias: alias };
      this.byName.set(name, withAlias);
      this.byMenuAlias.set(alias, withAlias);
    }
  }

  listWarnings(): string[] {
    return [...this.warnings];
  }

  get(name: string): LoadedCustomCommand | null {
    return this.byName.get(name) ?? null;
  }

  /**
   * Menu aliases resolve through the alias index rather than by undoing the
   * `-`/`_` mapping. An alias that was never advertised — because it collided
   * or could not be represented — therefore does not silently invoke whichever
   * command happens to share its de-normalized name.
   */
  private resolveToken(token: CustomCommandToken): LoadedCustomCommand | null {
    if (token.form === "text") return this.get(token.name);
    return (token.alias === undefined ? null : this.byMenuAlias.get(token.alias)) ?? null;
  }

  /**
   * `opts.botUsername` is required for a command carrying an `@target` to be
   * recognized at all; without it such a command is treated as not ours.
   */
  peekTextName(text: string, opts: ParseCustomCommandTokenOpts = {}): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const head = trimmed.slice(1).split(/\s/u, 1)[0];
    const token = head === undefined ? null : parseCustomCommandToken(head, opts);
    return token?.name ?? null;
  }

  parseText(
    text: string,
    opts: ParseCustomCommandTokenOpts = {},
  ): ResultType<ParsedCustomCommandInvocation | null, CustomCommandInvocationError> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return Result.ok(null);

    const tokenized = tokenize(trimmed.slice(1));
    return continueInvocation(tokenized, (tokens) => {
      const head = tokens.shift();
      const token = head === undefined ? null : parseCustomCommandToken(head, opts);
      if (!token) return Result.ok(null);

      const command = this.resolveToken(token);
      if (!command) return Result.ok(null);
      const parsed = this.parseArgsAndPrompt(command, tokens);
      return continueInvocation(parsed, (value) =>
        Result.ok({
          command,
          args: value.args,
          prompt: value.prompt,
          text: trimmed,
          source: "text",
        }),
      );
    });
  }

  parseSlash(params: {
    name: string;
    rawArgs: Record<string, CustomCommandArgumentValue>;
    prompt?: string | null;
  }): ResultType<ParsedCustomCommandInvocation, CustomCommandInvocationError> {
    const { name, rawArgs } = params;
    const command = this.get(name);
    if (!command) {
      return Result.err(
        new CustomCommandUnknownError({
          commandName: name,
          message: `Unknown custom command '${name}'.`,
        }),
      );
    }

    const args: ParsedCustomCommandArgument[] = [];
    const parseAt = (index: number): ResultType<void, CustomCommandInvocationError> => {
      const arg = command.def.args[index];
      if (!arg) return Result.ok(undefined);
      const value = rawArgs[arg.key];
      if (value === undefined || value === null) {
        if (arg.required) {
          return Result.err(
            new CustomCommandRequiredArgumentError({
              argumentKey: arg.key,
              message: `Missing required argument '${arg.key}'.`,
            }),
          );
        }
        args.push(undefined);
        return parseAt(index + 1);
      }
      const choice = validateArgChoice(arg, value);
      return continueInvocation(choice, (parsed) => {
        args.push(parsed);
        return parseAt(index + 1);
      });
    };
    return continueInvocation(parseAt(0), () =>
      Result.ok({
        command,
        args,
        prompt: params.prompt?.trim() ? params.prompt.trim() : null,
        text: this.formatText(
          command,
          command.def.args.flatMap((arg, index) => {
            const value = args[index];
            if (value === undefined) return [];
            return [`${arg.key}=${String(value)}`];
          }),
          params.prompt ?? null,
        ),
        source: "discord-slash",
      }),
    );
  }

  async execute(params: {
    command: LoadedCustomCommand;
    args: unknown[];
    context: CustomCommandContext;
  }): Promise<ResultType<CustomCommandResult, CustomCommandExecutionError>> {
    const commandName = params.command.def.name;
    const entrypointPath = params.command.entrypointPath;
    const imported = await importCustomCommandModule({ commandName, entrypointPath });
    return imported.match<
      () => Promise<ResultType<CustomCommandResult, CustomCommandExecutionError>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (commandModule) => async () => {
        const invoked = invokeCustomCommand({
          commandName,
          entrypointPath,
          run: () => commandModule.execute(params.args, params.context),
        });
        return invoked.match<
          () => Promise<ResultType<CustomCommandResult, CustomCommandExecutionError>>
        >({
          err: (error) => async () => Result.err(error),
          ok: (execution) => async () => execution,
        })();
      },
    })();
  }

  formatPreview(invocation: ParsedCustomCommandInvocation): string {
    const baseText = this.formatText(
      invocation.command,
      invocation.command.def.args.flatMap((arg, index) => {
        const value = invocation.args[index];
        if (value === undefined) return [];
        return [`${arg.key}=${String(value)}`];
      }),
    );

    if (!invocation.prompt) return baseText;
    return `${baseText}\nPrompt: ${invocation.prompt}`;
  }

  private formatText(
    command: LoadedCustomCommand,
    parts: readonly string[],
    prompt?: string | null,
  ): string {
    const trimmedPrompt = prompt?.trim() ? prompt.trim() : null;
    if (parts.length === 0 && !trimmedPrompt) return `/${command.textName}`;
    if (parts.length === 0) return `/${command.textName} ${trimmedPrompt}`;
    if (!trimmedPrompt) return `/${command.textName} ${parts.join(" ")}`;
    return `/${command.textName} ${parts.join(" ")} ${trimmedPrompt}`;
  }

  private parseArgsAndPrompt(
    command: LoadedCustomCommand,
    tokens: readonly string[],
  ): ResultType<ParsedArgsAndPrompt, CustomCommandInvocationError> {
    const out: ParsedCustomCommandArgument[] = Array.from({
      length: command.def.args.length,
    });
    let pos = 0;
    let promptStartIndex: number | null = null;

    const parseAt = (i: number): ResultType<void, CustomCommandInvocationError> => {
      const token = tokens[i];
      if (token === undefined) return Result.ok(undefined);
      const eq = token.indexOf("=");
      if (eq > 0) {
        const key = token.slice(0, eq);
        const raw = token.slice(eq + 1);
        const index = command.def.args.findIndex((arg) => arg.key === key);
        if (index < 0) {
          return Result.err(
            new CustomCommandUnknownArgumentError({
              argumentKey: key,
              commandTextName: command.textName,
              message: `Unknown argument '${key}' for /${command.textName}.`,
            }),
          );
        }
        const arg = command.def.args[index]!;
        const parsedValue = parseArgValue(arg.type, raw);
        return continueInvocation(parsedValue, (value) => {
          const choice = validateArgChoice(arg, value);
          return continueInvocation(choice, (selected) => {
            out[index] = selected;
            return parseAt(i + 1);
          });
        });
      }

      while (pos < command.def.args.length && out[pos] !== undefined) {
        pos += 1;
      }
      const arg = command.def.args[pos];
      if (!arg) {
        promptStartIndex = i;
        return Result.ok(undefined);
      }

      const parsedValue = parseArgValue(arg.type, token);
      const continueParsed = parsedValue.match<
        () => ResultType<void, CustomCommandInvocationError>
      >({
        err: (error) => () => {
          if (arg.required) return Result.err(error);
          promptStartIndex = i;
          return Result.ok(undefined);
        },
        ok: (value) => () =>
          continueInvocation(validateArgChoice(arg, value), (selected) => {
            out[pos] = selected;
            pos += 1;
            return parseAt(i + 1);
          }),
      });
      return continueParsed();
    };

    const validateRequiredAt = (
      index: number,
    ): ResultType<ParsedArgsAndPrompt, CustomCommandInvocationError> => {
      const arg = command.def.args[index];
      if (!arg) {
        return Result.ok({
          args: out,
          prompt: promptStartIndex === null ? null : tokens.slice(promptStartIndex).join(" "),
        });
      }
      if (arg.required && out[index] === undefined) {
        return Result.err(
          new CustomCommandRequiredArgumentError({
            argumentKey: arg.key,
            message: `Missing required argument '${arg.key}'.`,
          }),
        );
      }
      return validateRequiredAt(index + 1);
    };
    return continueInvocation(parseAt(0), () => validateRequiredAt(0));
  }
}

export function buildCustomCommandToolDisplay(input: {
  command: LoadedCustomCommand;
  text: string;
}): string {
  return `${CUSTOM_COMMAND_TOOL_NAME} ${input.text}`;
}
