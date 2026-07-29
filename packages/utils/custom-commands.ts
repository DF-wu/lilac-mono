import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContent } from "ai";

export const CUSTOM_COMMAND_TEXT_PREFIX = "lilac:";
export const CUSTOM_COMMAND_TOOL_NAME = "custom_command";
export const CUSTOM_COMMAND_PROMPT_ARG_KEY = "prompt";

/**
 * Prefix for the menu-safe alias of a custom command.
 *
 * The canonical typed form is `lilac:<name>`, but a bot command menu cannot
 * advertise it: Telegram's `setMyCommands` accepts only `[a-z0-9_]{1,32}`, so
 * both `:` and `-` are illegal there. The alias exists purely so a command can
 * be listed in such a menu, and resolves to the same definition as the typed
 * form.
 */
export const CUSTOM_COMMAND_MENU_PREFIX = "lilac_";

/** Telegram's command grammar — the tightest of the surfaces showing a menu. */
export const CUSTOM_COMMAND_MENU_ALIAS_MAX_LENGTH = 32;
const MENU_ALIAS_RE = /^[a-z0-9_]{1,32}$/;

const COMMAND_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_ARG_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const customCommandArgSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(COMMAND_ARG_KEY_RE, "arg key must be lowercase letters/numbers with hyphen separators"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().trim().min(1).max(100).optional(),
  required: z.boolean().optional().default(false),
  choices: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const customCommandDefSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(COMMAND_NAME_RE, "name must be lowercase letters/numbers with hyphen separators"),
    description: z.string().trim().min(1).max(100),
    args: z.array(customCommandArgSchema).max(24).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.args.length; i += 1) {
      const key = value.args[i]?.key;
      if (!key) continue;
      if (key === CUSTOM_COMMAND_PROMPT_ARG_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "key"],
          message: `'${CUSTOM_COMMAND_PROMPT_ARG_KEY}' is reserved for transcript prompts`,
        });
      }
      if (!seen.has(key)) {
        seen.add(key);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "key"],
          message: `duplicate arg key '${key}'`,
        });
      }

      const choices = value.args[i]?.choices;
      if (!choices) continue;
      if (value.args[i]?.type !== "string") {
        ctx.addIssue({
          code: "custom",
          path: ["args", i, "choices"],
          message: "choices are only supported for string args",
        });
      }

      const seenChoices = new Set<string>();
      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
        const choice = choices[choiceIndex];
        if (!choice) continue;
        if (!seenChoices.has(choice)) {
          seenChoices.add(choice);
          continue;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["args", i, "choices", choiceIndex],
          message: `duplicate choice '${choice}'`,
        });
      }
    }
  });

export type CustomCommandArgDef = z.infer<typeof customCommandArgSchema>;
export type CustomCommandDef = z.infer<typeof customCommandDefSchema>;
export type CustomCommandResult = Extract<ToolContent[number], { type: "tool-result" }>["output"];

export type CustomCommandContext = {
  cwd: string;
  dataDir: string;
  commandDir: string;
  commandName: string;
  requestId: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  reportActivity?: () => void;
};

export type CustomCommandModule = {
  execute(
    args: unknown[],
    ctx: CustomCommandContext,
  ): Promise<CustomCommandResult> | CustomCommandResult;
};

export type DiscoveredCustomCommand = {
  def: CustomCommandDef;
  dir: string;
  defPath: string;
  entrypointPath: string;
};

export type InvalidCustomCommand = {
  dir: string;
  defPath?: string;
  reason: string;
};

export type CustomCommandDiscovery =
  | {
      type: "command";
      command: DiscoveredCustomCommand;
    }
  | {
      type: "invalid";
      invalid: InvalidCustomCommand;
    };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function resolveEntrypoint(dir: string): Promise<string | null> {
  const candidates = [path.join(dir, "index.ts"), path.join(dir, "index.js")];
  for (const filePath of candidates) {
    if (await pathExists(filePath)) return filePath;
  }
  return null;
}

export function resolveCustomCommandsDir(dataDir: string): string {
  return path.join(dataDir, "cmds");
}

export function buildCustomCommandTextName(name: string): string {
  return `${CUSTOM_COMMAND_TEXT_PREFIX}${name}`;
}

/**
 * The menu alias for a command name, or `null` when none can represent it.
 *
 * Deliberately no truncation: shortening is what would make two distinct
 * commands collide, and a silently clipped alias is worse than no menu entry —
 * the command is still reachable through its typed `lilac:<name>` form either
 * way. Registry names cannot contain `_`, so mapping `-` to `_` is reversible.
 */
export function buildCustomCommandMenuAlias(name: string): string | null {
  const alias = `${CUSTOM_COMMAND_MENU_PREFIX}${name.replaceAll("-", "_")}`;
  return MENU_ALIAS_RE.test(alias) ? alias : null;
}

export type CustomCommandToken = {
  /** Which spelling the user used; both reach the same definition. */
  readonly form: "text" | "menu";
  /** Registry-shaped name, e.g. `foo-bar`, regardless of the form used. */
  readonly name: string;
  /** The alias exactly as written, present only for the menu form. */
  readonly alias?: string;
};

export type ParseCustomCommandTokenOpts = {
  /**
   * Username of the connected bot, used to check a command's `@target`.
   * Omitting it makes any targeted command unparseable rather than assumed
   * ours — see below.
   */
  readonly botUsername?: string;
};

/**
 * Read a leading command token in either spelling.
 *
 * Telegram appends `@botusername` to commands sent in a group, and in a group
 * with several bots it delivers commands aimed at *other* bots too when
 * privacy mode is off. The target is therefore validated, not stripped: an
 * earlier version discarded any `@suffix`, which let `/lilac_tarot@OtherBot`
 * run this bot's command. Mention gating does not catch it, because the
 * router's custom-command branch runs before that check.
 *
 * Fail closed on an unverifiable target. A command addressed to someone we
 * cannot identify is not ours to answer, and no surface but Telegram uses this
 * suffix convention, so nothing legitimate is lost.
 */
export function parseCustomCommandToken(
  token: string,
  opts: ParseCustomCommandTokenOpts = {},
): CustomCommandToken | null {
  const at = token.indexOf("@");
  const bare = (at === -1 ? token : token.slice(0, at)).trim();

  if (at !== -1) {
    const target = token.slice(at + 1).trim();
    const self = opts.botUsername?.trim();
    // Telegram usernames are case-insensitive.
    if (!self || target.toLowerCase() !== self.toLowerCase()) return null;
  }

  if (bare.startsWith(CUSTOM_COMMAND_TEXT_PREFIX)) {
    const name = bare.slice(CUSTOM_COMMAND_TEXT_PREFIX.length).trim();
    return name.length > 0 ? { form: "text", name } : null;
  }

  if (bare.startsWith(CUSTOM_COMMAND_MENU_PREFIX)) {
    const alias = bare.slice(CUSTOM_COMMAND_MENU_PREFIX.length).trim();
    if (alias.length === 0) return null;
    return { form: "menu", name: alias.replaceAll("_", "-"), alias: bare };
  }

  return null;
}

export function isValidCustomCommandResult(value: unknown): value is CustomCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>)["type"];
  return type === "json" || type === "error-text" || type === "content";
}

export async function discoverCustomCommands(params: {
  dataDir: string;
}): Promise<CustomCommandDiscovery[]> {
  const root = resolveCustomCommandsDir(params.dataDir);

  let dirents: Dirent[] = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  }

  const out: CustomCommandDiscovery[] = [];
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const dir = path.join(root, dirent.name);
    const defPath = path.join(dir, "def.json");

    if (!(await pathExists(defPath))) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          reason: "missing def.json",
        },
      });
      continue;
    }

    const entrypointPath = await resolveEntrypoint(dir);
    if (!entrypointPath) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          defPath,
          reason: "missing index.ts or index.js",
        },
      });
      continue;
    }

    try {
      const parsed = customCommandDefSchema.parse(await readJson(defPath));
      out.push({
        type: "command",
        command: {
          def: parsed,
          dir,
          defPath,
          entrypointPath,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      out.push({
        type: "invalid",
        invalid: {
          dir,
          defPath,
          reason: `invalid def.json: ${msg}`,
        },
      });
    }
  }

  return out;
}
