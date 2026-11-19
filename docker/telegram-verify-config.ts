/**
 * Derives a verification core-config from a live one.
 *
 * The point of the verification container is to behave exactly like the real
 * deployment on Telegram while being completely inert on Discord, so this
 * copies the operator's config verbatim and overrides only what would
 * otherwise cause the parallel instance to act twice.
 *
 * Reads the live YAML on stdin, writes the derived config to stdout as JSON.
 * JSON is a subset of YAML, so the runtime's loader accepts it directly and we
 * avoid round-tripping a 50KB hand-written file through a YAML emitter.
 *
 * Usage:
 *   cat core-config.yaml | bun docker/telegram-verify-config.ts <chatId>
 */
const chatId = process.argv[2];
const apiRoot = process.argv[3];
if (!chatId) {
  console.error("usage: telegram-verify-config.ts <chatId> <apiRoot>");
  process.exit(2);
}

const raw = await Bun.stdin.text();
const parsed: unknown = Bun.YAML.parse(raw);

// This script lives outside any workspace package, so it cannot resolve zod.
// A narrow structural guard is enough: everything not named below is copied
// through untouched.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (!isRecord(parsed)) {
  console.error("could not parse the live core-config as an object");
  process.exit(1);
}

const config = parsed;
const surface = isRecord(config.surface) ? config.surface : {};
const discord = isRecord(surface.discord) ? surface.discord : {};
const telegram = isRecord(surface.telegram) ? surface.telegram : {};

if (Object.hasOwn(telegram, "tokenEnv")) {
  console.error(
    "surface.telegram.tokenEnv was removed; copy the token to surface.telegram.token and remove tokenEnv",
  );
  process.exit(1);
}

if (telegram.enabled === true) {
  console.error(
    "the reference runtime already has Telegram enabled; stop it or use a reference config with a different bot token before starting verification",
  );
  process.exit(1);
}

if (typeof telegram.token !== "string" || telegram.token.trim().length === 0) {
  console.error("set surface.telegram.token in the reference core-config before verification");
  process.exit(1);
}

const derived = {
  ...config,
  surface: {
    ...surface,
    discord: {
      ...discord,
      // The only substantive override. Both lists empty means
      // shouldAllowMessage() rejects every Discord message, so the parallel
      // instance cannot reply alongside the live one. statusMessage is kept
      // as-is so the two agree rather than fighting over presence.
      allowedChannelIds: [],
      allowedGuildIds: [],
    },
    telegram: {
      ...telegram,
      enabled: true,
      allowedChatIds: [chatId],
      // Optional Bot API endpoint override. Telegram supports self-hosted Bot
      // API servers; a verification run also uses it to reach a local proxy.
      ...(apiRoot ? { apiRoot } : {}),
    },
  },
};

console.log(JSON.stringify(derived, null, 2));
