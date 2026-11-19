import {
  buildCustomCommandMenuAlias,
  CUSTOM_COMMAND_MENU_ALIAS_MAX_LENGTH,
} from "@stanley2058/lilac-utils";

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

/** One entry of a bot command menu, shaped for Telegram's `setMyCommands`. */
export type CustomCommandMenuEntry = {
  readonly command: string;
  readonly description: string;
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
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
