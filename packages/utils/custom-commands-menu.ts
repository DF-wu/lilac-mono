import { CUSTOM_COMMAND_TEXT_PREFIX } from "./custom-commands";

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
