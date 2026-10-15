import { captureError } from "../../../shared/error-capture";
import {
  discoverSkills,
  env,
  findWorkspaceRootResult,
  formatAvailableSkillsSection,
  isPanic,
  skillAvailableOn,
} from "@stanley2058/lilac-utils";
import { Result } from "better-result";

export async function maybeBuildSkillsSectionForPrimary(
  requestClient: string,
): Promise<string | null> {
  const workspaceRoot = findWorkspaceRootResult();
  const root = workspaceRoot.match({ ok: (value) => value, err: () => null });
  if (root === null) return null;

  const attempt = await Result.tryPromise({
    try: async () => {
      const { skills } = await discoverSkills({
        workspaceRoot: root,
        dataDir: env.dataDir,
      });
      return formatAvailableSkillsSection(
        skills.filter((skill) => skillAvailableOn(skill, requestClient)),
      );
    },
    catch: captureError,
  });

  if (attempt.isErr()) {
    const cause = attempt.error.cause;
    if (isPanic(cause)) throw cause;
    // Skill discovery is best-effort and must not prevent the agent from running.
    return null;
  }
  return attempt.value;
}
