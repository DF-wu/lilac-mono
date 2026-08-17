import fs from "node:fs/promises";
import { z } from "zod";
import { Fzf } from "fzf";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import {
  discoverSkills,
  parseSkillMarkdownResult,
  type DiscoveredSkill,
  env,
  findWorkspaceRootResult,
} from "@stanley2058/lilac-utils";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function skillsFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `skills_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

const listInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Search query (fuzzy-matched against name/description/source)"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max results (default: 50)")
    .default(50),
  sources: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value : [value];
    })
    .describe(
      'Optional source filter(s), e.g. --sources=lilac-data or --sources:json=["lilac-data","claude-project"].',
    ),
});

const readInputSchema = z.object({
  name: z.string().min(1).describe("Skill name"),
  maxChars: z.coerce
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe("Max characters of SKILL.md body to return"),
});

type SkillIncludeSummary = {
  baseDir: string;
  dirs: string[];
  files: string[];
};

async function listTopLevelEntries(baseDir: string): Promise<SkillIncludeSummary> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });

  const dirs: string[] = [];
  const files: string[] = [];

  for (const ent of entries) {
    const name = ent.name;
    if (name === "node_modules" || name === ".git") continue;

    if (ent.isDirectory()) {
      dirs.push(`${name}/`);
    } else if (ent.isFile()) {
      files.push(name);
    }
  }

  dirs.sort();
  files.sort();

  return { baseDir, dirs, files };
}

function truncateText(text: string, maxChars: number | undefined) {
  const cap = maxChars ?? 50_000;
  if (text.length <= cap) return { text, truncated: false as const };
  return { text: text.slice(0, cap), truncated: true as const };
}

function scoreAndFilter(
  skills: DiscoveredSkill[],
  queryRaw: string | undefined,
  limit: number,
): DiscoveredSkill[] {
  const query = queryRaw?.trim();
  if (!query) return skills.slice(0, limit);

  // Use Fzf for fuzzy ranking.
  const fzf = new Fzf(skills, {
    selector: (s) => `${s.name} ${s.description} ${s.source}`,
  });

  return fzf
    .find(query)
    .slice(0, limit)
    .map((r) => r.item);
}

function requireSkillByName(
  skills: DiscoveredSkill[],
  name: string,
): ResultType<DiscoveredSkill, ServerToolFailure> {
  const found = skills.find((s) => s.name === name);
  if (!found) {
    return Result.err(
      skillsFailure(
        "not_found",
        `Skill not found: '${name}'. Use skills.list to see available skills.`,
      ),
    );
  }
  return Result.ok(found);
}

async function loadSkillsForToolHost(): Promise<
  ResultType<Awaited<ReturnType<typeof discoverSkills>>, ServerToolFailure>
> {
  return Result.gen(async function* () {
    const workspaceRoot = yield* findWorkspaceRootResult().mapError((error) =>
      skillsFailure("not_found", error.message),
    );
    const discovered = yield* Result.await(
      Result.tryPromise({
        try: () => discoverSkills({ workspaceRoot, dataDir: env.dataDir }),
        catch: (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return skillsFailure(
            "unavailable",
            cause instanceof Error ? cause.message : "Skill discovery failed",
          );
        },
      }),
    );
    return Result.ok(discovered);
  });
}

async function readSkillForToolHost(
  input: z.output<typeof readInputSchema>,
  mode: "brief" | "full",
): Promise<ServerToolResult> {
  return Result.gen(async function* () {
    const { skills } = yield* Result.await(loadSkillsForToolHost());
    const found = yield* requireSkillByName(skills, input.name);
    const raw = yield* Result.await(
      Result.tryPromise({
        try: () => Bun.file(found.location).text(),
        catch: (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return skillsFailure(
            typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
              ? "not_found"
              : "unavailable",
            cause instanceof Error ? cause.message : "Skill could not be read",
          );
        },
      }),
    );
    const parsed = yield* parseSkillMarkdownResult(raw).mapError((error) =>
      skillsFailure("unavailable", error.message),
    );
    const defaultCap = mode === "brief" ? 8000 : 50_000;
    const { text, truncated } = truncateText(parsed.body, input.maxChars ?? defaultCap);
    const includes = yield* Result.await(
      Result.tryPromise({
        try: () => listTopLevelEntries(found.baseDir),
        catch: (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return skillsFailure(
            "unavailable",
            cause instanceof Error ? cause.message : "Skill resources could not be listed",
          );
        },
      }),
    );

    return Result.ok({
      name: found.name,
      description: found.description,
      source: found.source,
      location: found.location,
      baseDir: found.baseDir,
      frontmatter: parsed.frontmatter,
      body: text,
      truncated,
      includes: mode === "full" ? includes : undefined,
    });
  });
}

export class Skills implements ServerTool {
  private readonly tool = defineServerTool({
    id: "skills",
    callables: ({ callable }) => ({
      "skills.list": callable({
        name: "Skills List",
        description: "List and search skills discovered from common directories.",
        inputSchema: listInputSchema,
        validation: "zod",
        primaryPositional: "query",
        async run(input) {
          return (await loadSkillsForToolHost()).map(({ skills, warnings }) => {
            let filtered = skills;
            if (input.sources && input.sources.length > 0) {
              const allowed = new Set(input.sources);
              filtered = filtered.filter((skill) => allowed.has(skill.source));
            }

            const ranked = scoreAndFilter(filtered, input.query, input.limit);
            return {
              skills: ranked.map((skill) => ({
                name: skill.name,
                description: skill.description,
                source: skill.source,
                location: skill.location,
              })),
              warnings,
            };
          });
        },
      }),
      "skills.brief": callable({
        name: "Skills Brief",
        description: "Load a skill's frontmatter + a truncated SKILL.md body.",
        inputSchema: readInputSchema,
        validation: "zod",
        primaryPositional: "name",
        run: (input) => readSkillForToolHost(input, "brief"),
      }),
      "skills.full": callable({
        name: "Skills Full",
        description:
          "Load a skill's frontmatter + a larger SKILL.md body, plus a top-level directory listing.",
        inputSchema: readInputSchema,
        validation: "zod",
        primaryPositional: "name",
        run: (input) => readSkillForToolHost(input, "full"),
      }),
    }),
  });

  get id(): string {
    return this.tool.id;
  }

  init(): Promise<void> {
    return this.tool.init();
  }

  destroy(): Promise<void> {
    return this.tool.destroy();
  }

  list() {
    return this.tool.list();
  }

  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }
}
