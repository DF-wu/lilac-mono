import type {
  DisplayMessage,
  DisplayPart,
  ReadyTurnSlot,
  SubagentSummary,
} from "@stanley2058/lilac-client-protocol";
import {
  subagentActivities,
  subagentTranscripts,
  toolActivities,
} from "./generated/tool-activities";

type Activity = Extract<DisplayPart, { type: "data-activity" }>;
export type AgentWorkStage = {
  id: string;
  label: string;
  description: string;
  frames: ReadyTurnSlot[];
};
export const demoTime = Date.parse("2026-09-19T09:00:00Z");
const prompt: DisplayMessage = {
  id: "demo_prompt",
  role: "user",
  metadata: { authorId: "demo_user", createdAt: demoTime, inputMode: "prompt" },
  parts: [
    {
      type: "text",
      text: "Compare a riverside walk with a museum visit for Saturday. Check the weather and opening hours, then recommend a plan.",
    },
  ],
};
function activity(
  id: string,
  kind: Activity["data"]["kind"],
  label: string,
  state: Activity["data"]["state"],
  detail: string,
  durationMs?: number,
): Activity {
  return { type: "data-activity", id, data: { kind, label, state, detail, durationMs } };
}
function tool(id: string, data: Activity["data"]): Activity {
  return { type: "data-activity", id, data };
}
function message(
  id: string,
  parts: DisplayPart[],
  phase: "commentary" | "final" = "commentary",
): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "demo_agent", createdAt: demoTime + 3000, phase },
    parts,
  };
}
function turn(
  messages: DisplayMessage[],
  state: ReadyTurnSlot["state"] = "running",
): ReadyTurnSlot {
  const settled = state === "complete" || state === "failed" || state === "canceled";
  return {
    kind: "ready",
    slotId: "demo_slot",
    turnId: "demo_turn",
    position: 0,
    state,
    startedAt: demoTime,
    ...(settled ? { settledAt: demoTime + 12_400 } : {}),
    messages: [prompt, ...messages],
  };
}
const thought = activity(
  "demo_think",
  "thinking",
  "Thinking",
  "complete",
  "**Comparing both plans**\n\nThe forecast decides between them. A dry morning favors the riverside walk; rain points to the museum, so I need its Saturday hours as a fallback.",
  2100,
);
const forecast = tool("demo_forecast", toolActivities.forecast.settled);
const notes = tool("demo_notes", toolActivities.notes.settled);
const routeMap = tool("demo_route_map", toolActivities.routeMap.settled);
const weather = tool("demo_weather", toolActivities.weather.settled);
const hours = tool("demo_hours", toolActivities.hours.settled);
const notesSearch = tool("demo_notes_search", toolActivities.notesSearch.settled);
const hoursAndNotes = tool("demo_hours_notes", toolActivities.hoursAndNotes.settled);
const planEdit = tool("demo_plan_edit", toolActivities.planEdit.settled);
const work = message("demo_work", [
  thought,
  notes,
  routeMap,
  notesSearch,
  forecast,
  weather,
  hours,
]);
const commentary = message("demo_commentary", [
  {
    type: "text",
    text: "The weather looks good for a walk. I'll check the museum as a backup before choosing.",
  },
]);
const multiple = [
  message("demo_reasoning", [thought]),
  commentary,
  message("demo_tools", [forecast, hoursAndNotes, planEdit]),
  message("demo_comparison", [
    {
      type: "text",
      text: "Both options fit. Here's the comparison:\n\n| Plan | Best for | Time |\n| --- | --- | --- |\n| Riverside walk | Fresh air, flexible stops | 2 hours |\n| Museum | Rainy weather, a quieter pace | 90 minutes |",
    },
  ]),
  message("demo_followup_work", [tool("demo_route", toolActivities.firstRoute.running)]),
];
const answer = [
  "I'd choose the **riverside walk** for Saturday and keep the museum as a backup. The forecast is mild at 18°C, with light cloud and only a small chance of rain. That makes the river the more flexible choice, especially if you want time to stop along the way.",
  "Start at Sanjo Station around 10:00 and walk north beside the water. The full route takes about two hours, but you can turn back whenever you like. There are several bridges, so shortening the walk does not require retracing the whole route.",
  "Plan a coffee stop after the first stretch. A café with indoor seating gives you somewhere to rest if the wind picks up, and it keeps the morning relaxed. Leave a little room in the schedule for photos or a detour through the nearby streets.",
  "If the weather changes, switch to the museum. It is open from 10:00 to 18:00, with last admission at 17:30, so you can make that call after breakfast. Allow about 90 minutes for the visit and another 15 minutes for the bus ride from the riverside area.",
  "For the afternoon, keep the plan open. You could return to the river for a shorter stroll, browse nearby shops, or stay longer at the museum if an exhibition catches your eye. The two options are close enough that you do not need to commit to both in advance.",
  "Bring a light jacket and comfortable shoes. No reservation is needed for the walk; check the museum's ticket page before leaving if you decide to go indoors.",
].join("\n\n");
const final = message("demo_final", [{ type: "text", text: answer }], "final");
const paragraphs = answer.split("\n\n");
const streamFrames = paragraphs.map((_paragraph, index) =>
  turn([
    work,
    commentary,
    {
      ...final,
      parts: [
        {
          type: "text",
          text:
            paragraphs.slice(0, index + 1).join("\n\n") +
            (index < paragraphs.length - 1 ? "\n\n" : ""),
        },
      ],
    },
  ]),
);

const introduction = message("demo_introduction", [
  { type: "text", text: "I'll compare both plans and check the conditions for Saturday." },
]);
const firstWork = message("demo_first_work", [
  tool("demo_first_tool", toolActivities.firstRoute.settled),
]);
const steer = (id: string, authorId: string, text: string, offset: number): DisplayMessage => ({
  id,
  role: "user",
  metadata: { authorId, inputMode: "steer", createdAt: demoTime + offset },
  parts: [{ type: "text", text }],
});
const ownSteer = steer(
  "demo_own_steer",
  "demo_user",
  "Keep the walking part under an hour, please.",
  25_000,
);
const otherSteer = steer(
  "demo_other_steer",
  "demo_other_user",
  "Let's include a café with indoor seating too.",
  55_000,
);
const afterSteer = [
  message("demo_steer_thought", [
    activity(
      "demo_steer_think",
      "thinking",
      "Compared shorter routes",
      "complete",
      "A shorter river loop leaves time for a café stop.",
      5000,
    ),
  ]),
  message("demo_steer_commentary", [
    { type: "text", text: "I'll shorten the walk and look for a coffee stop along the way." },
  ]),
];
const nextTool = (data: Activity["data"]) =>
  message("demo_steer_work", [tool("demo_steer_tool", data)]);
const firstSteering = [
  introduction,
  firstWork,
  ownSteer,
  ...afterSteer,
  nextTool(toolActivities.shorterRoute.running),
];
const secondSteering = [
  introduction,
  firstWork,
  ownSteer,
  ...afterSteer,
  nextTool(toolActivities.shorterRoute.settled),
  otherSteer,
  message("demo_cafe_thought", [
    activity(
      "demo_cafe_think",
      "thinking",
      "Compared indoor stops",
      "complete",
      "Choose a café near the station in case it rains.",
      5000,
    ),
  ]),
  message("demo_cafe_commentary", [
    {
      type: "text",
      text: "I'll include an indoor café near the station, with the museum as an optional stop.",
    },
  ]),
];
const steeredFinal = message(
  "demo_steered_final",
  [
    {
      type: "text",
      text: "Take the **45-minute riverside loop** from Sanjo Station, then stop at a café with indoor seating. Keep the museum as an optional rainy-day alternative.",
    },
  ],
  "final",
);
const finalSteering = {
  ...turn([...secondSteering, steeredFinal], "complete"),
  settledAt: demoTime + 240_000,
};

const delegation = message("demo_delegation", [
  {
    type: "text",
    text: "I'll ask one subagent to check the weather and another to check the museum. Meanwhile, I'll compare travel times.",
  },
]);
function subagent(id: string, data: Activity["data"]) {
  return message(id, [tool(id, data)]);
}
const weatherSubagent = subagent("demo_subagent_weather", subagentActivities.weather.working);
const museumSubagent = subagent("demo_subagent_museum", subagentActivities.museum.working);
const weatherSubagentDone = subagent("demo_subagent_weather", subagentActivities.weather.done);
const museumSubagentDone = subagent("demo_subagent_museum", subagentActivities.museum.done);
const subagentUpdate = message("demo_subagent_update", [
  {
    type: "text",
    text: "The weather check is back: mild and dry, with the riverside path open. The museum check is still running.",
  },
]);
const parentRouteDone = message("demo_parent_work", [
  tool("demo_parent_route", toolActivities.travelTimes.settled),
]);

const foldedActivityMessages = [
  message("demo_old_thought", [
    activity("thinking", "thinking", "Thinking", "complete", "Compared both options."),
  ]),
  message("demo_first_update", [{ type: "text", text: "The route comparison is ready." }]),
  message("demo_background_agent", [
    tool("demo_subagent_museum", subagentActivities.museum.started),
  ]),
  message("demo_second_update", [
    { type: "text", text: "The agent is checking opening hours while I finish the plan." },
  ]),
  message("demo_latest_thought", [
    activity(
      "demo_latest_think",
      "thinking",
      "Thinking",
      "running",
      "Finishing the recommendation.",
    ),
  ]),
];

export const agentWorkStages: AgentWorkStage[] = [
  {
    id: "sent",
    label: "Message sent",
    description: "The agent shows Thinking immediately after sending.",
    frames: [
      {
        ...turn([], "pending"),
        messages: [
          {
            ...prompt,
            parts: [
              ...prompt.parts,
              { type: "data-input-state", id: "demo_input", data: { state: "queued" } },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "thinking",
    label: "Thinking",
    description: "A running reasoning block. Expand it to inspect its sample detail.",
    frames: [
      turn([
        message("demo_work", [
          activity(
            "demo_think",
            "thinking",
            "Thinking…",
            "running",
            "Sample reasoning summary: weighing an outdoor plan against an indoor alternative.",
          ),
        ]),
      ]),
    ],
  },
  {
    id: "folded-activity-running",
    label: "Folded activity running",
    description: "Only the last section and the section with a running agent shine.",
    frames: [turn(foldedActivityMessages)],
  },
  {
    id: "folded-activity-complete",
    label: "Folded activity complete",
    description: "Completed work stops shining even when activity records still say running.",
    frames: [turn([...foldedActivityMessages, final], "complete")],
  },
  {
    id: "tool-call",
    label: "Tool call",
    description: "Completed reasoning followed by a running tool.",
    frames: [
      turn([message("demo_work", [thought, tool("demo_weather", toolActivities.weather.running)])]),
    ],
  },
  {
    id: "parallel-tools",
    label: "Parallel tools",
    description: "Two tools running in the same activity group.",
    frames: [
      turn([
        message("demo_work", [
          thought,
          tool("demo_weather", toolActivities.weather.running),
          tool("demo_hours", toolActivities.hours.running),
        ]),
      ]),
    ],
  },
  {
    id: "tool-results",
    label: "Tool results",
    description: "Completed tools with durations and expandable results.",
    frames: [turn([work, commentary])],
  },
  {
    id: "multiple-blocks",
    label: "Multiple blocks",
    description: "Reasoning, commentary, tools, a table, and another tool call interleaved.",
    frames: [turn(multiple)],
  },
  {
    id: "subagents-working",
    label: "Subagents · working",
    description: "Two subagents work in parallel while the parent checks travel times.",
    frames: [
      turn([
        delegation,
        weatherSubagent,
        museumSubagent,
        message("demo_parent_work", [
          tool("demo_parent_route", toolActivities.travelTimes.running),
        ]),
      ]),
    ],
  },
  {
    id: "subagents-results",
    label: "Subagents · partial results",
    description: "One subagent finishes; the parent shares an update while the other continues.",
    frames: [
      turn([delegation, weatherSubagentDone, museumSubagent, parentRouteDone, subagentUpdate]),
    ],
  },
  {
    id: "subagents-complete",
    label: "Subagents · complete",
    description: "Both subagents finish. Expand the work summary to inspect their progress.",
    frames: [
      {
        ...turn(
          [
            delegation,
            weatherSubagentDone,
            museumSubagentDone,
            parentRouteDone,
            subagentUpdate,
            final,
          ],
          "complete",
        ),
        settledAt: demoTime + 60_000,
      },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    description: "A child workflow running after the initial tools finish.",
    frames: [
      turn([
        work,
        message("demo_workflow", [
          activity(
            "demo_plan",
            "workflow",
            "Planning the route…",
            "running",
            "Route planner\n• Find a starting point\n• Check walking distances\n• Pick a coffee stop",
          ),
        ]),
      ]),
    ],
  },
  {
    id: "streaming",
    label: "Paragraph streaming",
    description:
      "Play to watch a longer answer arrive one paragraph at a time. Pause to inspect a partial answer.",
    frames: streamFrames,
  },
  {
    id: "complete",
    label: "Complete",
    description: "The final answer stays visible; prior work collapses into the work summary.",
    frames: [turn([work, commentary, final], "complete")],
  },
  {
    id: "full-turn-working",
    label: "Full turn · working",
    description:
      "One agent avatar introduces commentary, thinking, another update, and a running tool.",
    frames: [
      turn([
        introduction,
        message("demo_full_thought", [thought]),
        commentary,
        message("demo_full_tool", [tool("demo_full_call", toolActivities.hours.running)]),
      ]),
    ],
  },
  {
    id: "full-turn-complete",
    label: "Full turn · complete",
    description:
      "The same turn settles into one work summary above the final response. Expand to inspect earlier updates.",
    frames: [
      {
        ...turn(
          [
            introduction,
            message("demo_full_thought", [thought]),
            commentary,
            message("demo_full_tool", [hours]),
            final,
          ],
          "complete",
        ),
        settledAt: demoTime + 120_000,
      },
    ],
  },
  {
    id: "steering",
    label: "Steering · your update",
    description:
      "Your steering prompt stays right aligned and starts a new agent group. Earlier commentary stays visible while work continues.",
    frames: [turn(firstSteering)],
  },
  {
    id: "steering-other",
    label: "Steering · another participant",
    description: "Another participant's prompt stays left aligned, followed by a new agent group.",
    frames: [turn(secondSteering)],
  },
  {
    id: "steering-complete",
    label: "Steering · complete",
    description:
      "All intermediate work and steering prompts collapse together, with the final response below.",
    frames: [finalSteering],
  },
  {
    id: "needs-input",
    label: "Needs input",
    description: "A choice presented to the user. Buttons only update this demo.",
    frames: [
      turn([
        message("demo_question", [
          { type: "text", text: "Would you prefer an outdoor plan or a quieter indoor visit?" },
          {
            type: "data-actions",
            id: "demo_choices",
            data: {
              requestId: "demo_request",
              revision: 1,
              actions: [
                { actionId: "outdoor", label: "Riverside walk", style: "primary" },
                { actionId: "indoor", label: "Museum visit", style: "secondary" },
              ],
            },
          },
        ]),
      ]),
    ],
  },
  {
    id: "compacting",
    label: "Compacting context",
    description: "A context-compaction marker between activity and commentary.",
    frames: [
      turn([
        work,
        message("demo_compact", [
          {
            type: "data-compaction",
            id: "demo_compaction",
            data: { state: "running", beforeCount: 128 },
          },
        ]),
      ]),
    ],
  },
  {
    id: "tool-error",
    label: "Tool failed",
    description: "A failed tool while the agent is still working on a fallback.",
    frames: [
      turn([
        message("demo_work", [
          thought,
          tool("demo_weather", toolActivities.forecastTimeout.settled),
        ]),
        message("demo_fallback", [
          { type: "text", text: "The forecast service timed out. I'll use another source." },
        ]),
      ]),
    ],
  },
  {
    id: "failed",
    label: "Run failed",
    description: "A failed run with its partial work preserved in the expandable summary.",
    frames: [
      turn(
        [
          message("demo_work", [
            thought,
            tool("demo_weather", toolActivities.forecastUnavailable.settled),
          ]),
        ],
        "failed",
      ),
    ],
  },
  {
    id: "canceled",
    label: "Canceled",
    description: "A stopped run with completed work and partial commentary preserved.",
    frames: [turn([work, commentary], "canceled")],
  },
];

const flowStages = [
  "sent",
  "thinking",
  "tool-call",
  "parallel-tools",
  "tool-results",
  "streaming",
  "complete",
];
export const conversationFrames = flowStages
  .flatMap((id) => agentWorkStages.find((stage) => stage.id === id)!.frames)
  .map((frame) => ({
    ...frame,
    messages: frame.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "data-activity") return part;
        const { detail: _detail, durationMs: _duration, ...data } = part.data;
        return {
          ...part,
          data: { ...data, ...(data.kind === "tool" ? { detail: data.label } : {}) },
        };
      }),
    })),
  }));
agentWorkStages.unshift({
  id: "conversation",
  label: "Send to completion",
  description: "Send a message to watch the same timeline and composer used in a thread.",
  frames: conversationFrames,
});

const demoSubagentSamples = {
  demo_subagent_weather: { profile: "explore", name: "Weather and riverside", sample: "weather" },
  demo_subagent_museum: { profile: "general", name: "Museum visit", sample: "museum" },
} as const;

function demoSubagentSample(id: string) {
  return id in demoSubagentSamples
    ? demoSubagentSamples[id as keyof typeof demoSubagentSamples]
    : undefined;
}

export function demoSubagents(slot: ReadyTurnSlot): SubagentSummary[] {
  return slot.messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "data-activity") return [];
      const sample = demoSubagentSample(part.id);
      if (!sample) return [];
      const running = part.data.state === "running";
      // Core titles a running subagent with its active tool's name.
      const activeTool = subagentTranscripts[sample.sample].running
        .flatMap((child) => child.parts)
        .findLast((child) => child.type === "data-activity" && child.data.state === "running");
      const title = activeTool?.type === "data-activity" ? activeTool.data.label : "Thinking…";
      return [
        {
          id: part.id,
          activityId: part.id,
          turnId: slot.turnId,
          profile: sample.profile,
          name: sample.name,
          state: part.data.state,
          title: running ? title : "Completed",
          startedAt: demoTime + 3000,
        },
      ];
    }),
  );
}

export function demoSubagentTranscript(agent: SubagentSummary): DisplayMessage[] {
  const sample = demoSubagentSample(agent.id);
  if (!sample) return [];
  return subagentTranscripts[sample.sample][agent.state === "running" ? "running" : "complete"];
}
