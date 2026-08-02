import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCustomCommandMenuAlias,
  customCommandDefSchema,
  parseCustomCommandToken,
} from "@stanley2058/lilac-utils";

import { assignMenuAliases, CustomCommandManager } from "../../src/custom-commands/manager";

/**
 * The command menu has to advertise something Telegram will accept
 * (`[a-z0-9_]{1,32}`) while the registry's canonical form is `lilac:<name>`,
 * which contains two characters that grammar forbids.
 */
async function writeCommand(dataDir: string, name: string, description: string): Promise<void> {
  const dir = path.join(dataDir, "cmds", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "def.json"),
    JSON.stringify({ name, description, args: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "index.ts"),
    `export async function execute() { return { type: "json", value: { name: ${JSON.stringify(name)} } }; }\n`,
    "utf8",
  );
}

describe("menu alias generation", () => {
  it("maps hyphens to underscores behind the menu prefix", () => {
    expect(buildCustomCommandMenuAlias("tarot")).toBe("lilac_tarot");
    expect(buildCustomCommandMenuAlias("daily-standup")).toBe("lilac_daily_standup");
  });

  it("refuses an alias that would exceed Telegram's 32-character limit", () => {
    // 26 characters is the longest that still fits under the `lilac_` prefix.
    const longest = "a".repeat(26);
    expect(buildCustomCommandMenuAlias(longest)).toBe(`lilac_${longest}`);
    expect(buildCustomCommandMenuAlias(`${longest}b`)).toBeNull();
  });

  it("does not truncate, because truncating is what would create collisions", () => {
    const a = buildCustomCommandMenuAlias(`${"a".repeat(26)}-one`);
    const b = buildCustomCommandMenuAlias(`${"a".repeat(26)}-two`);

    // Both are dropped rather than clipped to the same 32-character prefix.
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("keeps distinct names distinct", () => {
    // The pair that would collide under a naive 'strip separators' scheme.
    expect(buildCustomCommandMenuAlias("foo-bar")).toBe("lilac_foo_bar");
    expect(buildCustomCommandMenuAlias("foobar")).toBe("lilac_foobar");
  });

  it("rejects a name the menu grammar cannot hold at all", () => {
    expect(buildCustomCommandMenuAlias("Bad-Name")).toBeNull();
    expect(buildCustomCommandMenuAlias("has space")).toBeNull();
  });

  /**
   * This is what makes collisions impossible in practice. If the schema is
   * ever relaxed to allow `_`, the `-`/`_` mapping stops being injective and
   * two commands can claim one alias — so this assertion is the tripwire.
   */
  it("relies on the registry forbidding underscores in names", () => {
    expect(
      customCommandDefSchema.safeParse({ name: "foo_bar", description: "x", args: [] }).success,
    ).toBe(false);
    expect(
      customCommandDefSchema.safeParse({ name: "foo-bar", description: "x", args: [] }).success,
    ).toBe(true);
  });
});

describe("menu alias assignment resolves conflicts deterministically", () => {
  const candidate = (name: string) => ({ name, dir: `/cmds/${name}`, textName: `lilac:${name}` });

  it("assigns every representable command", () => {
    const { aliases, warnings } = assignMenuAliases([candidate("beta"), candidate("alpha-two")]);

    expect([...aliases]).toEqual([
      ["alpha-two", "lilac_alpha_two"],
      ["beta", "lilac_beta"],
    ]);
    expect(warnings).toEqual([]);
  });

  it("drops an overlong command and says why", () => {
    const long = "z".repeat(27);
    const { aliases, warnings } = assignMenuAliases([candidate("ok"), candidate(long)]);

    expect([...aliases.keys()]).toEqual(["ok"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no menu-safe alias");
    // The command is not lost — the warning has to point at the typed form.
    expect(warnings[0]).toContain(`/lilac:${long}`);
  });

  /**
   * Adversarial input: `foo_bar` cannot come out of the registry today, which
   * is exactly why the collision branch would otherwise never be exercised.
   */
  it("gives a contested alias to the first name in sort order and keeps the other typed-only", () => {
    const { aliases, warnings } = assignMenuAliases([candidate("foo_bar"), candidate("foo-bar")]);

    expect(aliases.get("foo-bar")).toBe("lilac_foo_bar");
    expect(aliases.has("foo_bar")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("already taken by 'foo-bar'");
    expect(warnings[0]).toContain("/lilac:foo_bar");
  });

  it("resolves a collision the same way whichever order the inputs arrive in", () => {
    const forward = assignMenuAliases([candidate("foo_bar"), candidate("foo-bar")]);
    const reverse = assignMenuAliases([candidate("foo-bar"), candidate("foo_bar")]);

    expect([...forward.aliases]).toEqual([...reverse.aliases]);
  });

  it("returns nothing for an empty registry", () => {
    expect(assignMenuAliases([]).aliases.size).toBe(0);
  });
});

describe("command tokens parse in both spellings", () => {
  it("reads the canonical typed form", () => {
    expect(parseCustomCommandToken("lilac:daily-standup")).toEqual({
      form: "text",
      name: "daily-standup",
    });
  });

  it("reads the menu alias back to the registry name", () => {
    expect(parseCustomCommandToken("lilac_daily_standup")).toEqual({
      form: "menu",
      name: "daily-standup",
      alias: "lilac_daily_standup",
    });
  });

  it("accepts the @botusername suffix when it names this bot", () => {
    // Without this a menu tap in any group parses as an unknown command.
    const opts = { botUsername: "Catalina_agentbot" };
    expect(parseCustomCommandToken("lilac_tarot@Catalina_agentbot", opts)).toEqual({
      form: "menu",
      name: "tarot",
      alias: "lilac_tarot",
    });
    expect(parseCustomCommandToken("lilac:tarot@Catalina_agentbot", opts)?.name).toBe("tarot");
  });

  it("matches the target case-insensitively, as Telegram usernames are", () => {
    expect(
      parseCustomCommandToken("lilac_tarot@catalina_AGENTBOT", {
        botUsername: "Catalina_agentbot",
      })?.name,
    ).toBe("tarot");
  });

  /**
   * The defect this guards: stripping any `@suffix` let a command explicitly
   * addressed to a different bot run ours. In a group with privacy mode off we
   * receive those messages, and the router's custom-command branch runs before
   * mention gating, so nothing downstream would have caught it.
   */
  it("refuses a command addressed to a different bot", () => {
    const opts = { botUsername: "Catalina_agentbot" };
    expect(parseCustomCommandToken("lilac_tarot@OtherBot", opts)).toBeNull();
    expect(parseCustomCommandToken("lilac:tarot@OtherBot", opts)).toBeNull();
  });

  it("refuses a targeted command when the bot's own username is unknown", () => {
    // Fail closed: a command aimed at someone we cannot identify is not ours.
    expect(parseCustomCommandToken("lilac_tarot@SomeBot")).toBeNull();
    expect(parseCustomCommandToken("lilac_tarot@SomeBot", { botUsername: "  " })).toBeNull();
  });

  it("still accepts an untargeted command without knowing the bot username", () => {
    expect(parseCustomCommandToken("lilac_tarot")?.name).toBe("tarot");
  });

  it("ignores tokens that are not custom commands", () => {
    expect(parseCustomCommandToken("start")).toBeNull();
    expect(parseCustomCommandToken("lilac")).toBeNull();
    expect(parseCustomCommandToken("lilac:")).toBeNull();
    expect(parseCustomCommandToken("lilac_")).toBeNull();
    expect(parseCustomCommandToken("lilacsomething")).toBeNull();
  });
});

describe("CustomCommandManager menu integration", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (!tmp) return;
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  async function load(
    commands: readonly { name: string; description: string }[],
  ): Promise<CustomCommandManager> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-menu-alias-"));
    const dataDir = path.join(tmp, "data");
    for (const cmd of commands) await writeCommand(dataDir, cmd.name, cmd.description);

    const manager = new CustomCommandManager(dataDir);
    await manager.init();
    return manager;
  }

  it("publishes an empty menu when nothing is registered", async () => {
    const manager = await load([]);
    expect(manager.listMenuEntries()).toEqual([]);
  });

  it("describes each entry from the registry rather than a placeholder", async () => {
    const manager = await load([
      { name: "tarot", description: "Draw a tarot spread" },
      { name: "daily-standup", description: "Summarize yesterday" },
    ]);

    expect(manager.listMenuEntries()).toEqual([
      { command: "lilac_daily_standup", description: "Summarize yesterday" },
      { command: "lilac_tarot", description: "Draw a tarot spread" },
    ]);
  });

  it("flattens a multi-line description, which a menu row cannot show", async () => {
    const manager = await load([{ name: "tarot", description: "Draw a spread\nthen read it" }]);

    expect(manager.listMenuEntries()[0]?.description).toBe("Draw a spread then read it");
  });

  it("omits an unrepresentable command from the menu but keeps it invocable", async () => {
    const long = "q".repeat(27);
    const manager = await load([{ name: long, description: "Too long to advertise" }]);

    expect(manager.listMenuEntries()).toEqual([]);
    expect(manager.get(long)).not.toBeNull();
    expect(manager.parseText(`/lilac:${long}`)?.command.def.name).toBe(long);
    expect(manager.listWarnings().join("\n")).toContain("no menu-safe alias");
  });

  it("resolves an alias invocation to the same command as the typed form", async () => {
    const manager = await load([{ name: "daily-standup", description: "Summarize yesterday" }]);

    const typed = manager.parseText("/lilac:daily-standup");
    const viaMenu = manager.parseText("/lilac_daily_standup");

    expect(viaMenu?.command.def.name).toBe("daily-standup");
    expect(viaMenu?.command.entrypointPath).toBe(typed?.command.entrypointPath ?? "");
  });

  it("parses arguments and trailing prompt identically for both spellings", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-menu-alias-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "daily-standup");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "daily-standup",
        description: "Summarize yesterday",
        args: [{ key: "team", type: "string", required: true }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await manager.init();

    const typed = manager.parseText("/lilac:daily-standup team=core and keep it short");
    const viaMenu = manager.parseText("/lilac_daily_standup team=core and keep it short");

    expect(viaMenu?.args).toEqual(typed?.args ?? []);
    expect(viaMenu?.args).toEqual(["core"]);
    expect(viaMenu?.prompt).toBe("and keep it short");
    expect(viaMenu?.prompt).toBe(typed?.prompt ?? "");
  });

  it("does not let an unadvertised alias reach a command by name de-normalization", async () => {
    const long = "r".repeat(27);
    const manager = await load([{ name: long, description: "Too long to advertise" }]);

    // The alias was never published, so the alias spelling must not resolve —
    // otherwise a dropped collision loser would still be reachable ambiguously.
    expect(manager.parseText(`/lilac_${long}`)).toBeNull();
  });

  it("does not resolve a command addressed to another bot", async () => {
    const manager = await load([{ name: "tarot", description: "Draw a tarot spread" }]);
    const opts = { botUsername: "Catalina_agentbot" };

    expect(manager.parseText("/lilac_tarot@OtherBot", opts)).toBeNull();
    // Nor should it report an unknown command, which would answer a message
    // that was never addressed to us.
    expect(manager.peekTextName("/lilac_tarot@OtherBot", opts)).toBeNull();
    expect(manager.parseText("/lilac_tarot@Catalina_agentbot", opts)?.command.def.name).toBe(
      "tarot",
    );
  });

  it("reports an unknown alias under its registry-shaped name", async () => {
    const manager = await load([{ name: "tarot", description: "Draw a tarot spread" }]);

    // The router turns this into "Unknown custom command 'daily-standup'".
    expect(manager.peekTextName("/lilac_daily_standup")).toBe("daily-standup");
    expect(manager.peekTextName("/lilac_tarot")).toBe("tarot");
    expect(manager.peekTextName("/start")).toBeNull();
  });
});
