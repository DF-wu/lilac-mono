import { pathToFileURL } from "node:url";

import {
  buildCustomCommandMenuAlias,
  buildCustomCommandTextName,
  CUSTOM_COMMAND_MENU_ALIAS_MAX_LENGTH,
  CUSTOM_COMMAND_TOOL_NAME,
  discoverCustomCommands,
  isValidCustomCommandResult,
  parseCustomCommandToken,
  type CustomCommandArgDef,
  type CustomCommandContext,
  type CustomCommandToken,
  type ParseCustomCommandTokenOpts,
  type CustomCommandModule,
  type CustomCommandResult,
  type DiscoveredCustomCommand,
} from "@stanley2058/lilac-utils";

function validateArgChoice(arg: CustomCommandArgDef, value: unknown): unknown {
  if (arg.type !== "string" || typeof value !== "string" || !arg.choices?.length) {
    return value;
  }
  if (arg.choices.includes(value)) return value;

  throw new Error(`Argument '${arg.key}' must be one of: ${arg.choices.join(", ")}.`);
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

function parseNumberToken(token: string): number {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected a number, got '${token}'.`);
  }
  return value;
}

function parseBooleanToken(token: string): boolean {
  const value = token.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;
  throw new Error(`Expected a boolean, got '${token}'.`);
}

function parseArgValue(type: "string" | "number" | "boolean", raw: string): unknown {
  if (type === "string") return parseStringToken(raw);
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

  for (const candidate of [...candidates].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
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

function tokenize(text: string): string[] {
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
    throw new Error(`Unterminated ${quote} quote in command input.`);
  }
  if (cur.length > 0) out.push(cur);
  return out;
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
  args: unknown[];
  prompt: string | null;
  text: string;
  source: "text" | "discord-slash";
};

type ParsedArgsAndPrompt = {
  args: unknown[];
  prompt: string | null;
};

export class CustomCommandManager {
  private readonly reserved = new Set(["lilac", "model", "divider"]);
  private readonly byName = new Map<string, LoadedCustomCommand>();
  private readonly byMenuAlias = new Map<string, LoadedCustomCommand>();
  private readonly warnings: string[] = [];

  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    this.byName.clear();
    this.byMenuAlias.clear();
    this.warnings.length = 0;

    for (const entry of await discoverCustomCommands({ dataDir: this.dataDir })) {
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
  ): ParsedCustomCommandInvocation | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const tokens = tokenize(trimmed.slice(1));
    const head = tokens.shift();
    const token = head === undefined ? null : parseCustomCommandToken(head, opts);
    if (!token) return null;

    const command = this.resolveToken(token);
    if (!command) return null;
    const parsed = this.parseArgsAndPrompt(command, tokens);

    return {
      command,
      args: parsed.args,
      prompt: parsed.prompt,
      text: trimmed,
      source: "text",
    };
  }

  parseSlash(params: {
    name: string;
    rawArgs: Record<string, unknown>;
    prompt?: string | null;
  }): ParsedCustomCommandInvocation {
    const { name, rawArgs } = params;
    const command = this.get(name);
    if (!command) {
      throw new Error(`Unknown custom command '${name}'.`);
    }

    const args = command.def.args.map((arg) => {
      const value = rawArgs[arg.key];
      if (value === undefined || value === null) {
        if (arg.required) {
          throw new Error(`Missing required argument '${arg.key}'.`);
        }
        return undefined;
      }
      return validateArgChoice(arg, value);
    });

    return {
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
    };
  }

  async execute(params: {
    command: LoadedCustomCommand;
    args: unknown[];
    context: CustomCommandContext;
  }): Promise<CustomCommandResult> {
    const mod = (await import(
      pathToFileURL(params.command.entrypointPath).href
    )) as Partial<CustomCommandModule>;
    if (typeof mod.execute !== "function") {
      throw new Error(`Command '${params.command.def.name}' must export async execute(args, ctx).`);
    }

    const result = await mod.execute(params.args, params.context);
    if (!isValidCustomCommandResult(result)) {
      throw new Error(
        `Command '${params.command.def.name}' returned an invalid tool result payload.`,
      );
    }
    return result;
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
  ): ParsedArgsAndPrompt {
    const out = Array.from({ length: command.def.args.length }, () => undefined as unknown);
    let pos = 0;
    let promptStartIndex: number | null = null;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      const eq = token.indexOf("=");
      if (eq > 0) {
        const key = token.slice(0, eq);
        const raw = token.slice(eq + 1);
        const index = command.def.args.findIndex((arg) => arg.key === key);
        if (index < 0) {
          throw new Error(`Unknown argument '${key}' for /${command.textName}.`);
        }
        out[index] = validateArgChoice(
          command.def.args[index]!,
          parseArgValue(command.def.args[index]!.type, raw),
        );
        continue;
      }

      while (pos < command.def.args.length && out[pos] !== undefined) {
        pos += 1;
      }
      const arg = command.def.args[pos];
      if (!arg) {
        promptStartIndex = i;
        break;
      }

      let parsedValue: unknown;
      try {
        parsedValue = parseArgValue(arg.type, token);
      } catch (error) {
        if (arg.required) throw error;
        promptStartIndex = i;
        break;
      }
      out[pos] = validateArgChoice(arg, parsedValue);
      pos += 1;
    }

    for (let i = 0; i < command.def.args.length; i += 1) {
      const arg = command.def.args[i]!;
      if (arg.required && out[i] === undefined) {
        throw new Error(`Missing required argument '${arg.key}'.`);
      }
    }

    return {
      args: out,
      prompt: promptStartIndex === null ? null : tokens.slice(promptStartIndex).join(" "),
    };
  }
}

export function buildCustomCommandToolDisplay(input: {
  command: LoadedCustomCommand;
  text: string;
}): string {
  return `${CUSTOM_COMMAND_TOOL_NAME} ${input.text}`;
}
