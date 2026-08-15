import { Show, createSignal } from "solid-js";
import { Result, type Result as ResultType } from "better-result";

import { MiniLilacTransport } from "@stanley2058/mini-lilac-client";

import { MiniLilacApp } from "./app";
import { HELP_TEXT, parseCliOptions } from "./cli";
import { continuationCommand } from "./continuation";
import { createReadlinePreflightIO } from "./preflight";
import {
  bindingPreferenceServerKey,
  bindingPreferencesPath,
  loadBindingPreferences,
  saveBindingPreferences,
  type BindingPreferences,
} from "./preferences";
import {
  loadExistingSession,
  resolveStartupSession,
  type ExistingSessionLoadError,
  type StartupSession,
} from "./startup";
import {
  createTerminalRenderer,
  readTerminalTheme,
  renderTerminalApp,
  requestTerminalRendererShutdown,
  resolveTerminalShutdownOutcome,
  runWithOwnedTerminalRenderer,
  runTerminalEntrypoint,
  setTerminalBackground,
  type TerminalShutdownOutcome,
} from "./terminal-runtime-adapter";

export async function main(argv: readonly string[]): Promise<number> {
  const parsedOptions = parseCliOptions({ argv, env: process.env, cwd: process.cwd() });
  const options = parsedOptions.match({
    ok: (value) => value,
    err: (error) => {
      process.stderr.write(`${error.message}\n`);
      return undefined;
    },
  });
  if (options === undefined) return 1;

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write("Failed to start: mini-lilac requires TTY stdin and stdout.\n");
    return 1;
  }

  const baseTransport = new MiniLilacTransport({
    baseUrl: options.server,
    bearerToken: () => options.token,
    cwd: options.cwd,
  });

  const preferencesPath = bindingPreferencesPath(process.env);
  const preferenceServer = bindingPreferenceServerKey(options.server);
  let preferences: BindingPreferences = { version: 1, servers: {} };
  const loadedPreferences = await loadBindingPreferences(preferencesPath);
  loadedPreferences.match({
    ok: (value) => {
      preferences = value.preferences;
    },
    err: (error) => {
      process.stderr.write(`Warning: could not load TUI preferences: ${error.message}\n`);
    },
  });

  const io = createReadlinePreflightIO();
  const resolvedStartup = await resolveStartupSession(
    baseTransport,
    options,
    io,
    preferences.servers[preferenceServer],
  );
  io.close();
  const startup = resolvedStartup.match({
    ok: (value) => value,
    err: (error) => {
      process.stderr.write(`Failed to start: ${error.message}\n`);
      return undefined;
    },
  });
  if (startup === undefined) return 1;

  const transport = new MiniLilacTransport({
    baseUrl: options.server,
    bearerToken: () => options.token,
    cwd: options.cwd,
    model: startup.model,
    profile: startup.profile,
    reasoning: startup.reasoning,
  });
  transport.setReconnectCursor(startup.sessionId, startup.replayCursor);

  let resolveDestroyed: (() => void) | undefined;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const createdRenderer = await createTerminalRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 30,
    useMouse: true,
    autoFocus: false,
    useKittyKeyboard: {},
    backgroundColor: "transparent",
    onDestroy: () => resolveDestroyed?.(),
  });
  const renderer = createdRenderer.match({
    ok: (value) => value,
    err: (error) => {
      process.stderr.write(`Failed to start: ${error.message}\n`);
      return undefined;
    },
  });
  if (renderer === undefined) return 1;
  let continuationRequested = false;
  let currentSessionId = startup.sessionId;
  let shutdownOutcome: TerminalShutdownOutcome = { kind: "success" };
  const deferredWarnings: string[] = [];
  let preferenceWrite: Promise<void> = Promise.resolve();
  const terminalRun = await runWithOwnedTerminalRenderer(renderer, async () => {
    const theme = await readTerminalTheme(renderer);
    const background = setTerminalBackground(renderer, theme.background);
    const backgroundError = background.match({ ok: () => undefined, err: (error) => error });
    if (backgroundError !== undefined) return Result.err(backgroundError);

    const rememberBindings = (bindings: {
      readonly model: string | undefined;
      readonly profile: string | undefined;
      readonly reasoning: StartupSession["reasoning"];
    }) => {
      preferences = {
        ...preferences,
        servers: { ...preferences.servers, [preferenceServer]: bindings },
      };
      preferenceWrite = preferenceWrite.then(async () => {
        const saved = await saveBindingPreferences(preferencesPath, preferences);
        saved.match({
          ok: () => {},
          err: (error) => {
            deferredWarnings.push(`Warning: could not save TUI preferences: ${error.message}\n`);
          },
        });
      });
    };
    const rendered = await renderTerminalApp(() => {
      const [current, setCurrent] = createSignal(startup);
      const switchSession = async (
        sessionId: string,
      ): Promise<ResultType<void, ExistingSessionLoadError>> => {
        const loaded = await loadExistingSession(transport, sessionId, options.cwd);
        return loaded.map(({ snapshot, messages, todos, replayCursor }) => {
          transport.setSessionBindings({
            model: snapshot.model ?? undefined,
            profile: snapshot.profile ?? undefined,
            reasoning: snapshot.reasoning ?? undefined,
          });
          currentSessionId = snapshot.id;
          setCurrent({
            sessionId: snapshot.id,
            model: snapshot.model ?? undefined,
            profile: snapshot.profile ?? undefined,
            reasoning: snapshot.reasoning ?? undefined,
            snapshot,
            messages,
            todos,
            replayCursor,
            models: startup.models,
            profiles: startup.profiles,
          });
        });
      };
      const newSession = (bindings: {
        readonly model: string | undefined;
        readonly profile: string | undefined;
        readonly reasoning: StartupSession["reasoning"];
      }): void => {
        const sessionId = crypto.randomUUID();
        transport.setSessionBindings(bindings);
        currentSessionId = sessionId;
        setCurrent({
          sessionId,
          ...bindings,
          snapshot: undefined,
          messages: [],
          todos: { revision: 0, todos: [] },
          replayCursor: null,
          models: startup.models,
          profiles: startup.profiles,
        });
      };
      return (
        <Show when={current()} keyed>
          {(session) => (
            <MiniLilacApp
              transport={transport}
              cwd={options.cwd}
              sessionId={session.sessionId}
              model={session.model}
              profile={session.profile}
              reasoning={session.reasoning}
              models={session.models}
              profiles={session.profiles}
              initialSnapshot={session.snapshot}
              initialMessages={session.messages}
              initialTodos={session.todos}
              theme={theme}
              onBindingsChange={rememberBindings}
              onNewSession={newSession}
              onSessionSelect={switchSession}
              onExit={() => {
                continuationRequested = true;
                shutdownOutcome = requestTerminalRendererShutdown(renderer, () =>
                  resolveDestroyed?.(),
                );
              }}
            />
          )}
        </Show>
      );
    }, renderer);
    const renderError = rendered.match({ ok: () => undefined, err: (error) => error });
    if (renderError !== undefined) return Result.err(renderError);
    await destroyed;
    const shutdown = resolveTerminalShutdownOutcome(shutdownOutcome);
    const shutdownError = shutdown.match({ ok: () => undefined, err: (error) => error });
    if (shutdownError !== undefined) return Result.err(shutdownError);
    await preferenceWrite;
    return Result.ok(undefined);
  });

  for (const warning of deferredWarnings) process.stderr.write(warning);
  const terminalError = terminalRun.match({ ok: () => undefined, err: (error) => error });
  if (terminalError !== undefined) {
    process.stderr.write(`${terminalError.message}\n`);
    return 1;
  }
  if (continuationRequested) {
    process.stdout.write(
      `To continue this session, run: ${continuationCommand(options.server, currentSessionId)}\n`,
    );
    const usedCliToken = argv.some(
      (argument) => argument === "--token" || argument.startsWith("--token="),
    );
    if (usedCliToken) {
      process.stdout.write(
        "Re-supply --token or set MINI_LILAC_TOKEN; tokens are never printed to scrollback.\n",
      );
    }
  }
  return 0;
}

if (import.meta.main) {
  const outcome = await runTerminalEntrypoint(() => main(process.argv.slice(2)));
  process.exitCode = outcome.match({
    ok: (value) => value,
    err: (error) => {
      process.stderr.write(`${error.message}\n`);
      return 1;
    },
  });
}
