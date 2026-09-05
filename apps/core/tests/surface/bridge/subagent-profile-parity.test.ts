import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import {
  buildSystemPromptForProfile,
  selectWorkspaceSystemPrompt,
} from "../../../src/surface/bridge/bus-agent-runner/subagent-prompt";

describe("native subagent profile prompt parity", () => {
  const config = parseCoreConfigV2ToUniversal({ configVersion: 2 });

  it("uses the worker prompt only for explore and general profiles", () => {
    for (const profile of ["explore", "general"] as const) {
      expect(
        selectWorkspaceSystemPrompt({
          profile,
          primarySystemPrompt: "primary",
          workerSystemPrompt: "worker",
        }),
      ).toBe("worker");
    }

    for (const profile of ["primary", "self"] as const) {
      expect(
        selectWorkspaceSystemPrompt({
          profile,
          primarySystemPrompt: "primary",
          workerSystemPrompt: "worker",
        }),
      ).toBe("primary");
    }
  });

  it("falls back to the primary prompt when a worker prompt has not been loaded", () => {
    expect(
      selectWorkspaceSystemPrompt({
        profile: "general",
        primarySystemPrompt: "primary",
        workerSystemPrompt: "",
      }),
    ).toBe("primary");
  });

  for (const profile of ["explore", "general", "self"] as const) {
    it(`uses one ${profile} prompt for direct and workflow launches`, () => {
      const params = {
        baseSystemPrompt: "base",
        profile,
        profileConfig: config.agent.subagents.profiles[profile],
        exploreOverlay: config.agent.subagents.profiles.explore.promptOverlay,
        generalOverlay: config.agent.subagents.profiles.general.promptOverlay,
        selfOverlay: config.agent.subagents.profiles.self.promptOverlay,
        skillsSection: profile === "explore" ? null : "skills",
      };

      const direct = buildSystemPromptForProfile(params);
      const workflow = buildSystemPromptForProfile(params);
      expect(workflow).toBe(direct);
      expect(workflow).not.toContain("Workflow Tool Surface");
      if (profile === "explore" || profile === "general") {
        expect(workflow).toContain("TOOLS.md describes capabilities and conventions");
      }
    });
  }

  for (const profile of ["explore", "general", "self"] as const) {
    it(`renders ${profile} network and write settings as behavioral guidance`, () => {
      const restricted = parseCoreConfigV2ToUniversal({
        configVersion: 2,
        agent: {
          subagents: {
            profiles: {
              [profile]: { network: false, workspaceWrites: false },
            },
          },
        },
      }).agent.subagents.profiles[profile];

      const prompt = buildSystemPromptForProfile({
        baseSystemPrompt: "base",
        profile,
        profileConfig: restricted,
      });
      expect(prompt).toContain("Do not use network access or network-backed tools.");
      expect(prompt).toContain("Do not edit files.");
    });
  }

  it("only prohibits Bash when explore execution is disabled", () => {
    const disabled = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: { subagents: { profiles: { explore: { execution: false } } } },
    }).agent.subagents.profiles.explore;
    const restricted = config.agent.subagents.profiles.explore;

    expect(
      buildSystemPromptForProfile({
        baseSystemPrompt: "base",
        profile: "explore",
        profileConfig: disabled,
      }),
    ).toContain("Do not use bash.");
    expect(
      buildSystemPromptForProfile({
        baseSystemPrompt: "base",
        profile: "explore",
        profileConfig: restricted,
      }),
    ).not.toContain("Do not use bash.");
  });
});
