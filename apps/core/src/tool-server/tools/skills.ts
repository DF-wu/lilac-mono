import fs from "node:fs/promises";
import { z } from "zod";
import { Fzf } from "fzf";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  defineServerTool,
  type ServerTool,
  type ServerToolCallOptions,
} from "@stanley2058/lilac-plugin-runtime";

import {
  discoverSkills,
  parseSkillMarkdownResult,
  type DiscoveredSkill,
  env,
  findWorkspaceRootResult,
} from "@stanley2058/lilac-utils";

class SkillsToolFailure extends TaggedError("SkillsToolFailure")<{
  readonly message: string;
}> {}

function adaptSkillsResultToToolHost<TValue>(
  result: ResultType<TValue, SkillsToolFailure>,
): TValue {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function signalSkillsFailureToToolHost(message: string): never {
  return adaptSkillsResultToToolHost(Result.err(new SkillsToolFailure({ message })));
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

function requireSkillByName(skills: DiscoveredSkill[], name: string): DiscoveredSkill {
  const found = skills.find((s) => s.name === name);
  if (!found) {
    return signalSkillsFailureToToolHost(
      `Skill not found: '${name}'. Use skills.list to see available skills.`,
    );
  }
  return found;
}

async function loadSkillsForToolHost() {
  const workspaceRootResult = findWorkspaceRootResult();
  if (workspaceRootResult.status === "error") {
    switch (workspaceRootResult.error._tag) {
      case "WorkspaceRootNotFound":
        return signalSkillsFailureToToolHost(workspaceRootResult.error.message);
    }
  }

  return await discoverSkills({
    workspaceRoot: workspaceRootResult.value,
    dataDir: env.dataDir,
  });
}

async function readSkillForToolHost(
  input: z.output<typeof readInputSchema>,
  mode: "brief" | "full",
) {
  const { skills } = await loadSkillsForToolHost();
  const found = requireSkillByName(skills, input.name);

  const raw = await Bun.file(found.location).text();
  const parsedResult = parseSkillMarkdownResult(raw);
  if (parsedResult.status === "error") {
    switch (parsedResult.error._tag) {
      case "SkillMarkdownInvalid":
        return signalSkillsFailureToToolHost(parsedResult.error.message);
    }
  }
  const parsed = parsedResult.value;

  // Keep returned frontmatter stable + minimal-ish.
  const frontmatter = parsed.frontmatter;
  const defaultCap = mode === "brief" ? 8000 : 50_000;
  const { text, truncated } = truncateText(parsed.body, input.maxChars ?? defaultCap);

  const includes = await listTopLevelEntries(found.baseDir);

  return {
    name: found.name,
    description: found.description,
    source: found.source,
    location: found.location,
    baseDir: found.baseDir,
    frontmatter,
    body: text,
    truncated,
    includes: mode === "full" ? includes : undefined,
  };
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
          const { skills, warnings } = await loadSkillsForToolHost();

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
  ): Promise<unknown> {
    return this.tool.call(callableId, input, opts);
  }
}
