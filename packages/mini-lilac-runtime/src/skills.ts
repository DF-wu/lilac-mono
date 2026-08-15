import path from "node:path";
import { open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";

import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import {
  discoverSkills,
  findWorkspaceRootResult,
  formatAvailableSkillsSection,
  isPanic,
  parseSkillMarkdownResult,
  type DiscoveredSkill,
  type SkillScanRoot,
  type SkillWarning,
} from "@stanley2058/lilac-utils";
import {
  miniLilacSkillSummarySchema,
  type MiniLilacSkillSummary,
} from "@stanley2058/mini-lilac-client";
import { z } from "zod";

const MAX_DISCOVERED_SKILLS = 256;
const MAX_CATALOG_CHARS = 8_000;
const MAX_DESCRIPTION_CATALOG_CHARS = 160;
const MAX_SKILL_FILE_BYTES = 128 * 1_024;
const MAX_SKILL_INSTRUCTION_CHARS = 32_000;
const MAX_SKILL_RESOURCES = 10;

const SKILL_USAGE_INSTRUCTIONS = [
  "Use the `skill` tool to load a skill when the task clearly matches its description.",
  "A token in the form `@skills:<name>` is an explicit user selection. Before acting, call the `skill` tool with that exact name.",
  "If a selected skill is unavailable, say so briefly and continue with the best fallback.",
].join("\n");

export const miniLilacSkillLoadResultSchema = z
  .object({
    name: miniLilacSkillSummarySchema.shape.name,
    description: miniLilacSkillSummarySchema.shape.description,
    instructions: z.string().max(MAX_SKILL_INSTRUCTION_CHARS),
    baseDirectory: z.string().min(1),
    resources: z.array(z.string().min(1)).max(MAX_SKILL_RESOURCES),
    resourceListingTruncated: z.boolean(),
  })
  .strict();
export type MiniLilacSkillLoadResult = z.infer<typeof miniLilacSkillLoadResultSchema>;

export type MiniLilacSkillCatalogOptions = {
  dataDir: string;
  homeDir?: string;
  onWarning?: (warning: SkillWarning) => void;
};

export class MiniLilacSkillUnavailable extends TaggedError("MiniLilacSkillUnavailable")<{
  readonly name: string;
  readonly message: string;
}> {}

export class MiniLilacSkillFilesystemFailed extends TaggedError("MiniLilacSkillFilesystemFailed")<{
  readonly name: string;
  readonly operation: "resolve-file" | "resolve-directory" | "read-file" | "list-resources";
  readonly message: string;
}> {}

export class MiniLilacSkillPathInvalid extends TaggedError("MiniLilacSkillPathInvalid")<{
  readonly name: string;
  readonly issue: "file-symlink" | "directory-symlink";
  readonly message: string;
}> {}

export class MiniLilacSkillReadAndCleanupFailed extends TaggedError(
  "MiniLilacSkillReadAndCleanupFailed",
)<{
  readonly name: string;
  readonly readError: MiniLilacSkillFilesystemFailed;
  readonly cleanupError: MiniLilacSkillFilesystemFailed;
  readonly message: string;
}> {}

export class MiniLilacSkillContentInvalid extends TaggedError("MiniLilacSkillContentInvalid")<{
  readonly name: string;
  readonly issue: "too-large" | "markdown" | "identity" | "instructions-too-large";
  readonly message: string;
}> {}

export class MiniLilacSkillDiscoveryFailed extends TaggedError("MiniLilacSkillDiscoveryFailed")<{
  readonly workspaceRoot: string;
  readonly message: string;
}> {}

export type MiniLilacSkillLoadError =
  | MiniLilacSkillUnavailable
  | MiniLilacSkillFilesystemFailed
  | MiniLilacSkillReadAndCleanupFailed
  | MiniLilacSkillPathInvalid
  | MiniLilacSkillContentInvalid;

type SkillCapture<T, E> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly error: E }
  | { readonly status: "panic"; readonly panic: Panic };

function throwSkillPanic(panic: Panic): never {
  throw panic;
}

function captureSkillSync<T, E>(operation: () => T, error: E): SkillCapture<T, E> {
  try {
    return { status: "ok", value: operation() };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return { status: "error", error };
  }
}

async function captureSkillPromise<T, E>(
  operation: () => Promise<T>,
  error: E,
): Promise<SkillCapture<T, E>> {
  try {
    return { status: "ok", value: await operation() };
  } catch (cause) {
    if (isPanic(cause)) return { status: "panic", panic: cause };
    return { status: "error", error };
  }
}

export class MiniLilacSkillCatalogSnapshot {
  readonly summaries: readonly MiniLilacSkillSummary[];
  private readonly byName: ReadonlyMap<string, DiscoveredSkill>;

  constructor(skills: readonly DiscoveredSkill[]) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
    this.summaries = skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  promptSection(contextWindow?: number): string | null {
    if (this.summaries.length === 0) return null;
    const contextBudget =
      contextWindow === undefined ? MAX_CATALOG_CHARS : Math.floor(contextWindow * 0.02 * 4);
    const maxSectionChars = Math.max(512, Math.min(MAX_CATALOG_CHARS, contextBudget));
    const catalogBudget = Math.max(0, maxSectionChars - SKILL_USAGE_INSTRUCTIONS.length - 2);
    const catalog = formatAvailableSkillsSection(this.summaries, {
      maxDescriptionChars: MAX_DESCRIPTION_CATALOG_CHARS,
      maxSectionChars: catalogBudget,
    });
    if (catalog === null) return null;
    return `${catalog}\n\n${SKILL_USAGE_INSTRUCTIONS}`;
  }

  async loadResult(
    name: string,
  ): Promise<ResultType<MiniLilacSkillLoadResult, MiniLilacSkillLoadError>> {
    const skill = this.byName.get(name);
    if (skill === undefined) {
      return Result.err(
        new MiniLilacSkillUnavailable({ name, message: `Skill '${name}' is not available` }),
      );
    }
    const location = await this.resolvePath(name, skill.location, "resolve-file");
    let canonicalLocation!: string;
    let loadFailure: MiniLilacSkillLoadError | undefined;
    location.match({
      ok: (value) => void (canonicalLocation = value),
      err: (error) => void (loadFailure = error),
    });
    if (loadFailure !== undefined) return Result.err(loadFailure);
    if (path.normalize(canonicalLocation) !== path.normalize(path.resolve(skill.location))) {
      return Result.err(
        new MiniLilacSkillPathInvalid({
          name,
          issue: "file-symlink",
          message: `Skill '${name}' resolves through a symbolic link`,
        }),
      );
    }
    const raw = await this.readSkillFile(name, canonicalLocation);
    let source!: string;
    raw.match({
      ok: (value) => void (source = value),
      err: (error) => void (loadFailure = error),
    });
    if (loadFailure !== undefined) return Result.err(loadFailure);
    let parsedSkill!: ReturnType<typeof parseSkillMarkdownResult> extends ResultType<
      infer T,
      infer _
    >
      ? T
      : never;
    parseSkillMarkdownResult(source).match({
      ok: (value) => void (parsedSkill = value),
      err: (error) =>
        void (loadFailure = new MiniLilacSkillContentInvalid({
          name,
          issue: "markdown",
          message: `Skill '${name}' is invalid: ${error.message}`,
        })),
    });
    if (loadFailure !== undefined) return Result.err(loadFailure);
    if (parsedSkill.name !== name) {
      return Result.err(
        new MiniLilacSkillContentInvalid({
          name,
          issue: "identity",
          message: `Skill '${name}' changed identity while loading`,
        }),
      );
    }
    if (parsedSkill.body.length > MAX_SKILL_INSTRUCTION_CHARS) {
      return Result.err(
        new MiniLilacSkillContentInvalid({
          name,
          issue: "instructions-too-large",
          message: `Skill '${name}' instructions exceed ${MAX_SKILL_INSTRUCTION_CHARS} characters`,
        }),
      );
    }
    const baseDirectory = await this.resolvePath(name, skill.baseDir, "resolve-directory");
    let canonicalBaseDirectory!: string;
    baseDirectory.match({
      ok: (value) => void (canonicalBaseDirectory = value),
      err: (error) => void (loadFailure = error),
    });
    if (loadFailure !== undefined) return Result.err(loadFailure);
    if (path.normalize(canonicalBaseDirectory) !== path.normalize(path.resolve(skill.baseDir))) {
      return Result.err(
        new MiniLilacSkillPathInvalid({
          name,
          issue: "directory-symlink",
          message: `Skill '${name}' directory resolves through a symbolic link`,
        }),
      );
    }
    const listed = await this.listResources(name, canonicalBaseDirectory);
    let resources!: { readonly resources: string[]; readonly truncated: boolean };
    listed.match({
      ok: (value) => void (resources = value),
      err: (error) => void (loadFailure = error),
    });
    if (loadFailure !== undefined) return Result.err(loadFailure);
    return Result.ok({
      name,
      description: parsedSkill.description,
      instructions: parsedSkill.body,
      baseDirectory: skill.baseDir,
      resources: resources.resources,
      resourceListingTruncated: resources.truncated,
    });
  }

  /** Compatibility adapter for the skill tool's established rejection contract. */
  async load(name: string): Promise<MiniLilacSkillLoadResult> {
    const loaded = await this.loadResult(name);
    let skill!: MiniLilacSkillLoadResult;
    let failure: MiniLilacSkillLoadError | undefined;
    loaded.match({
      ok: (value) => void (skill = value),
      err: (error) => void (failure = error),
    });
    if (failure !== undefined) throw failure;
    return skill;
  }

  private async resolvePath(
    name: string,
    inputPath: string,
    operation: "resolve-file" | "resolve-directory",
  ): Promise<ResultType<string, MiniLilacSkillFilesystemFailed>> {
    const resolved = await captureSkillPromise(
      () => realpath(inputPath),
      new MiniLilacSkillFilesystemFailed({
        name,
        operation,
        message: `Failed to resolve skill '${name}'`,
      }),
    );
    if (resolved.status === "panic") return throwSkillPanic(resolved.panic);
    if (resolved.status === "error") return Result.err(resolved.error);
    return Result.ok(resolved.value);
  }

  private async readSkillFile(
    name: string,
    location: string,
  ): Promise<
    ResultType<
      string,
      | MiniLilacSkillFilesystemFailed
      | MiniLilacSkillReadAndCleanupFailed
      | MiniLilacSkillContentInvalid
    >
  > {
    const opened = await captureSkillPromise(
      () => open(location, "r"),
      new MiniLilacSkillFilesystemFailed({
        name,
        operation: "read-file",
        message: `Failed to open skill '${name}'`,
      }),
    );
    if (opened.status === "panic") return throwSkillPanic(opened.panic);
    if (opened.status === "error") return Result.err(opened.error);
    const handle = opened.value;

    const readError = new MiniLilacSkillFilesystemFailed({
      name,
      operation: "read-file",
      message: `Failed to read skill '${name}'`,
    });
    const read = await captureSkillPromise(async () => {
      const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_SKILL_FILE_BYTES) {
        return Result.err(
          new MiniLilacSkillContentInvalid({
            name,
            issue: "too-large",
            message: `Skill '${name}' exceeds ${MAX_SKILL_FILE_BYTES} bytes`,
          }),
        );
      }
      return Result.ok(buffer.subarray(0, offset).toString("utf8"));
    }, readError);

    const cleanupError = new MiniLilacSkillFilesystemFailed({
      name,
      operation: "read-file",
      message: `Failed to close skill '${name}'`,
    });
    const closed = await captureSkillPromise(() => handle.close(), cleanupError);

    if (read.status === "panic") return throwSkillPanic(read.panic);
    if (closed.status === "panic") return throwSkillPanic(closed.panic);
    let ownedReadError: MiniLilacSkillFilesystemFailed | MiniLilacSkillContentInvalid | undefined;
    if (read.status === "error") ownedReadError = read.error;
    else {
      Result.match(read.value, {
        ok: () => {},
        err: (error: MiniLilacSkillFilesystemFailed | MiniLilacSkillContentInvalid) =>
          void (ownedReadError = error),
      });
    }
    if (ownedReadError && closed.status === "error") {
      const normalizedReadError =
        ownedReadError instanceof MiniLilacSkillFilesystemFailed
          ? ownedReadError
          : new MiniLilacSkillFilesystemFailed({
              name,
              operation: "read-file",
              message: ownedReadError.message,
            });
      return Result.err(
        new MiniLilacSkillReadAndCleanupFailed({
          name,
          readError: normalizedReadError,
          cleanupError: closed.error,
          message: `Failed to read and close skill '${name}'`,
        }),
      );
    }
    if (ownedReadError) return Result.err(ownedReadError);
    if (closed.status === "error") return Result.err(closed.error);
    if (read.status === "error") return Result.err(read.error);
    return read.value;
  }

  private async listResources(
    name: string,
    baseDirectory: string,
  ): Promise<
    ResultType<
      { readonly resources: string[]; readonly truncated: boolean },
      MiniLilacSkillFilesystemFailed
    >
  > {
    const resources: string[] = [];
    let resourceListingTruncated = false;
    const listed = await captureSkillPromise(
      async () => {
        const directory = await opendir(baseDirectory);
        for await (const entry of directory) {
          if (entry.name === "SKILL.md" || entry.name === ".git" || entry.name === "node_modules") {
            continue;
          }
          if (!entry.isFile() && !entry.isDirectory()) continue;
          if (resources.length === MAX_SKILL_RESOURCES) {
            resourceListingTruncated = true;
            break;
          }
          resources.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
        }
      },
      new MiniLilacSkillFilesystemFailed({
        name,
        operation: "list-resources",
        message: `Failed to list resources for skill '${name}'`,
      }),
    );
    if (listed.status === "panic") return throwSkillPanic(listed.panic);
    if (listed.status === "error") return Result.err(listed.error);
    resources.sort();
    return Result.ok({ resources, truncated: resourceListingTruncated });
  }
}

export class MiniLilacSkillCatalog {
  constructor(private readonly options: MiniLilacSkillCatalogOptions) {}

  async discoverResult(
    cwd: string,
  ): Promise<ResultType<MiniLilacSkillCatalogSnapshot, MiniLilacSkillDiscoveryFailed>> {
    const foundWorkspaceRoot = findWorkspaceRootResult(cwd);
    const workspaceRoot = foundWorkspaceRoot.unwrapOr(path.resolve(cwd));
    const homeDir = this.options.homeDir ?? homedir();
    const roots: SkillScanRoot[] = [
      {
        pattern: path.join(this.options.dataDir, "skills", "*", "SKILL.md"),
        source: "lilac-data",
        precedence: 300,
      },
      {
        pattern: path.join(workspaceRoot, ".agents", "skills", "**", "SKILL.md"),
        source: "agent-project",
        precedence: 200,
      },
      {
        pattern: path.join(homeDir, ".agents", "skills", "**", "SKILL.md"),
        source: "agent-user",
        precedence: 100,
      },
    ];
    const discovered = await captureSkillPromise(
      () =>
        discoverSkills({
          workspaceRoot,
          dataDir: this.options.dataDir,
          homeDir,
          roots,
          maxSkills: MAX_DISCOVERED_SKILLS * 2,
          maxScanEntries: MAX_DISCOVERED_SKILLS * 16,
        }),
      new MiniLilacSkillDiscoveryFailed({
        workspaceRoot,
        message: "Skill discovery failed",
      }),
    );
    if (discovered.status === "panic") return throwSkillPanic(discovered.panic);
    if (discovered.status === "error") return Result.err(discovered.error);
    for (const warning of discovered.value.warnings) {
      const emitted = this.emitWarning(workspaceRoot, warning);
      let warningFailure: MiniLilacSkillDiscoveryFailed | undefined;
      emitted.match({
        ok: () => {},
        err: (error) => void (warningFailure = error),
      });
      if (warningFailure !== undefined) return Result.err(warningFailure);
    }
    const skills: DiscoveredSkill[] = [];
    for (const skill of discovered.value.skills) {
      const resolved = await captureSkillPromise(
        () => realpath(skill.location),
        new MiniLilacSkillDiscoveryFailed({
          workspaceRoot,
          message: "Skill path resolution failed",
        }),
      );
      if (resolved.status === "panic") return throwSkillPanic(resolved.panic);
      if (resolved.status === "error") {
        const emitted = this.emitWarning(workspaceRoot, {
          location: skill.location,
          message: "skill path resolution failed",
        });
        let warningFailure: MiniLilacSkillDiscoveryFailed | undefined;
        emitted.match({
          ok: () => {},
          err: (error) => void (warningFailure = error),
        });
        if (warningFailure !== undefined) return Result.err(warningFailure);
        continue;
      }
      if (path.normalize(resolved.value) !== path.normalize(path.resolve(skill.location))) {
        const emitted = this.emitWarning(workspaceRoot, {
          location: skill.location,
          message: "skill resolves through a symbolic link",
        });
        let warningFailure: MiniLilacSkillDiscoveryFailed | undefined;
        emitted.match({
          ok: () => {},
          err: (error) => void (warningFailure = error),
        });
        if (warningFailure !== undefined) return Result.err(warningFailure);
        continue;
      }
      skills.push(skill);
      if (skills.length === MAX_DISCOVERED_SKILLS) {
        if (discovered.value.skills.length > skills.length) {
          const emitted = this.emitWarning(workspaceRoot, {
            location: workspaceRoot,
            message: `skill discovery capped at ${MAX_DISCOVERED_SKILLS} entries`,
          });
          let warningFailure: MiniLilacSkillDiscoveryFailed | undefined;
          emitted.match({
            ok: () => {},
            err: (error) => void (warningFailure = error),
          });
          if (warningFailure !== undefined) return Result.err(warningFailure);
        }
        break;
      }
    }
    return Result.ok(new MiniLilacSkillCatalogSnapshot(skills));
  }

  private emitWarning(
    workspaceRoot: string,
    warning: SkillWarning,
  ): ResultType<void, MiniLilacSkillDiscoveryFailed> {
    const emitted = captureSkillSync(
      () => this.options.onWarning?.(warning),
      new MiniLilacSkillDiscoveryFailed({
        workspaceRoot,
        message: "Skill warning callback failed",
      }),
    );
    if (emitted.status === "panic") return throwSkillPanic(emitted.panic);
    if (emitted.status === "error") return Result.err(emitted.error);
    return Result.ok(undefined);
  }

  async discover(cwd: string): Promise<MiniLilacSkillCatalogSnapshot> {
    const discovered = await this.discoverResult(cwd);
    let snapshot: MiniLilacSkillCatalogSnapshot | undefined;
    let failure!: MiniLilacSkillDiscoveryFailed;
    discovered.match({
      ok: (value) => void (snapshot = value),
      err: (error) => void (failure = error),
    });
    if (snapshot !== undefined) return snapshot;
    this.options.onWarning?.({
      location: failure.workspaceRoot,
      message: failure.message,
    });
    return new MiniLilacSkillCatalogSnapshot([]);
  }
}
