import type {
  MiniLilacModelSummary,
  MiniLilacProfileSummary,
  MiniLilacReasoning,
  MiniLilacSessionResume,
  MiniLilacSessionSnapshot,
  MiniLilacTodoState,
  MiniLilacTransport,
  MiniLilacRequestError,
  MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { canonicalCwd, type CliOptions } from "./cli";
import {
  modelChoices,
  PreflightSelectionUnknown,
  selectChoice,
  type PreflightIO,
  type PreflightSelectionError,
} from "./preflight";
import type { BindingPreference } from "./preferences";

export type StartupTransport = Pick<
  MiniLilacTransport,
  "getSessionResumeResult" | "listModelsResult" | "listProfilesResult" | "setReconnectCursor"
>;

export class StartupSessionCwdUnresolvable extends TaggedError("StartupSessionCwdUnresolvable")<{
  readonly sessionId: string;
  readonly cwd: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class StartupSessionCwdMismatch extends TaggedError("StartupSessionCwdMismatch")<{
  readonly sessionId: string;
  readonly storedCwd: string;
  readonly currentCwd: string;
  readonly message: string;
}> {}

export type StartupError =
  | MiniLilacRequestError
  | PreflightSelectionError
  | StartupSessionCwdUnresolvable
  | StartupSessionCwdMismatch;

export type ExistingSessionLoadError =
  | MiniLilacRequestError
  | StartupSessionCwdUnresolvable
  | StartupSessionCwdMismatch;

export interface StartupSession {
  readonly sessionId: string;
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly reasoning: MiniLilacReasoning | undefined;
  readonly snapshot: MiniLilacSessionSnapshot | undefined;
  readonly messages: MiniLilacUIMessage[];
  readonly todos: MiniLilacTodoState;
  readonly replayCursor: MiniLilacSessionResume["replayCursor"];
  readonly models: readonly MiniLilacModelSummary[];
  readonly profiles: readonly MiniLilacProfileSummary[];
}

export function verifySessionCwd(
  snapshot: MiniLilacSessionSnapshot,
  cwd: string,
): ResultType<void, StartupSessionCwdUnresolvable | StartupSessionCwdMismatch> {
  const canonical = canonicalCwd(snapshot.cwd);
  if (canonical.status === "error") {
    return Result.err(
      new StartupSessionCwdUnresolvable({
        sessionId: snapshot.id,
        cwd: snapshot.cwd,
        cause: canonical.error,
        message: `Session '${snapshot.id}' cwd no longer resolves: ${snapshot.cwd}`,
      }),
    );
  }
  const storedCwd = canonical.value;
  if (storedCwd !== cwd) {
    return Result.err(
      new StartupSessionCwdMismatch({
        sessionId: snapshot.id,
        storedCwd,
        currentCwd: cwd,
        message: `Session '${snapshot.id}' belongs to cwd '${storedCwd}', not current cwd '${cwd}'`,
      }),
    );
  }
  return Result.ok(undefined);
}

export async function loadExistingSession(
  transport: Pick<MiniLilacTransport, "getSessionResumeResult" | "setReconnectCursor">,
  sessionId: string,
  cwd: string,
): Promise<
  ResultType<
    {
      readonly snapshot: MiniLilacSessionSnapshot;
      readonly messages: MiniLilacUIMessage[];
      readonly todos: MiniLilacTodoState;
      readonly replayCursor: MiniLilacSessionResume["replayCursor"];
    },
    ExistingSessionLoadError
  >
> {
  const loaded = await transport.getSessionResumeResult(sessionId);
  if (loaded.status === "error") return Result.err(loaded.error);
  const { snapshot, messages, todos, replayCursor } = loaded.value;
  const verified = verifySessionCwd(snapshot, cwd);
  if (verified.status === "error") return Result.err(verified.error);
  transport.setReconnectCursor(sessionId, replayCursor);
  return Result.ok({ snapshot, messages, todos, replayCursor });
}

/** Resolve a fresh or resumed session without creating fresh binding mismatches. */
export async function resolveStartupSession(
  transport: StartupTransport,
  options: CliOptions,
  io: PreflightIO,
  preference?: BindingPreference,
): Promise<ResultType<StartupSession, StartupError>> {
  let snapshot: MiniLilacSessionSnapshot | undefined;
  let messages: MiniLilacUIMessage[] = [];
  let todos: MiniLilacTodoState = { revision: 0, todos: [] };
  let replayCursor: MiniLilacSessionResume["replayCursor"] = null;

  if (options.session !== undefined) {
    // Resume state and canonical transcript are loaded before catalog selection.
    const loaded = await loadExistingSession(transport, options.session, options.cwd);
    if (loaded.status === "error") return Result.err(loaded.error);
    ({ snapshot, messages, todos, replayCursor } = loaded.value);
    const ignoredBindings: string[] = [];
    if (options.model !== undefined && options.model !== (snapshot.model ?? undefined)) {
      ignoredBindings.push("--model");
    }
    if (options.profile !== undefined && options.profile !== (snapshot.profile ?? undefined)) {
      ignoredBindings.push("--profile");
    }
    if (
      options.reasoning !== undefined &&
      options.reasoning !== (snapshot.reasoning ?? undefined)
    ) {
      ignoredBindings.push("--reasoning");
    }
    if (ignoredBindings.length > 0) {
      io.write(
        `Warning: ${ignoredBindings.join(", ")} ignored; resumed sessions keep their stored bindings.\n`,
      );
    }
  }

  const [modelsResult, profilesResult] = await Promise.all([
    transport.listModelsResult(),
    transport.listProfilesResult(),
  ]);
  if (modelsResult.status === "error") return Result.err(modelsResult.error);
  if (profilesResult.status === "error") return Result.err(profilesResult.error);
  const models = modelsResult.value;
  const profiles = profilesResult.value;
  // Every persisted value is authoritative on resume, including null (which is
  // represented as an omitted transport option). Never select a fresh binding.
  const preferredModel = options.model ?? preference?.model;
  const rememberedModel = models.some((entry) => entry.id === preferredModel)
    ? preferredModel
    : undefined;
  let model = snapshot?.model ?? undefined;
  if (snapshot === undefined) {
    const selected = await selectChoice(
      io,
      "Model",
      modelChoices(models),
      options.model ?? rememberedModel,
    );
    if (selected.status === "error") return Result.err(selected.error);
    model = selected.value.id;
  }
  const preferredProfile = options.profile ?? preference?.profile;
  if (
    snapshot === undefined &&
    options.profile !== undefined &&
    !profiles.some((entry) => entry.id === options.profile && !entry.subagentOnly)
  ) {
    return Result.err(
      new PreflightSelectionUnknown({
        title: "Profile",
        selection: options.profile,
        message: `Unknown selection '${options.profile}' for profile`,
      }),
    );
  }
  const rememberedProfile = profiles.some(
    (entry) => entry.id === preferredProfile && !entry.subagentOnly,
  )
    ? preferredProfile
    : undefined;
  const profile =
    snapshot === undefined
      ? (options.profile ?? rememberedProfile)
      : (snapshot.profile ?? undefined);

  return Result.ok({
    sessionId: snapshot?.id ?? options.session ?? crypto.randomUUID(),
    model,
    profile,
    // Resume bindings are authoritative. A stored null means provider default,
    // not permission for a fresh CLI override.
    reasoning:
      snapshot === undefined
        ? (options.reasoning ?? preference?.reasoning)
        : (snapshot.reasoning ?? undefined),
    snapshot,
    messages,
    todos,
    replayCursor,
    models,
    profiles,
  });
}
