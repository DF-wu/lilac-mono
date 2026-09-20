import type {
  DisplayMessage,
  DisplayPart,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";

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
  "Compared the two plans",
  "complete",
  "Sample reasoning summary: compare weather, travel time, opening hours, and indoor alternatives.",
  2100,
);
const weather = activity(
  "demo_weather",
  "tool",
  "Checked Saturday's weather",
  "complete",
  'weather.lookup({ city: "Kyoto", day: "Saturday" })\n\n18°C, light cloud, 10% chance of rain.',
  850,
);
const hours = activity(
  "demo_hours",
  "tool",
  "Checked museum opening hours",
  "complete",
  'web.search({ query: "Kyoto museum Saturday hours" })\n\nOpen 10:00–18:00. Last admission 17:30.',
  1200,
);
const work = message("demo_work", [thought, weather, hours]);
const commentary = message("demo_commentary", [
  {
    type: "text",
    text: "The weather looks good for a walk. I'll check the museum as a backup before choosing.",
  },
]);
const multiple = [
  message("demo_reasoning", [thought]),
  commentary,
  message("demo_tools", [weather, hours]),
  message("demo_comparison", [
    {
      type: "text",
      text: "Both options fit. Here's the comparison:\n\n| Plan | Best for | Time |\n| --- | --- | --- |\n| Riverside walk | Fresh air, flexible stops | 2 hours |\n| Museum | Rainy weather, a quieter pace | 90 minutes |",
    },
  ]),
  message("demo_followup_work", [
    activity(
      "demo_route",
      "tool",
      "Checking the walking route…",
      "running",
      'maps.route({ from: "Sanjo Station", to: "Riverside café", mode: "walk" })',
    ),
  ]),
];
const answer =
  "I'd choose the **riverside walk**, with the museum as a rainy-day backup.\n\n1. Start at Sanjo Station around 10:00.\n2. Walk north along the river, then stop for coffee.\n3. Keep the afternoon free, or visit the museum before its 17:30 last admission.\n\nBring a light jacket. No reservations are needed for the walk.";
const final = message("demo_final", [{ type: "text", text: answer }], "final");
const streamFrames = Array.from(
  { length: Math.ceil(answer.length / 16) },
  (_value: undefined, index) =>
    turn([
      work,
      {
        ...final,
        metadata: { ...final.metadata, incomplete: true },
        parts: [{ type: "text", text: answer.slice(0, (index + 1) * 16) }],
      },
    ]),
);

const introduction = message("demo_introduction", [
  { type: "text", text: "I'll compare both plans and check the conditions for Saturday." },
]);
const firstWork = message("demo_first_work", [
  activity(
    "demo_first_tool",
    "tool",
    "Checked the first route",
    "complete",
    "The riverside route takes about two hours.",
    20_000,
  ),
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
const nextTool = (state: Activity["data"]["state"]) =>
  message("demo_steer_work", [
    activity(
      "demo_steer_tool",
      "tool",
      state === "running" ? "Checking shorter routes…" : "Checked shorter routes",
      state,
      "A 45-minute loop starts and ends near Sanjo Station.",
      state === "complete" ? 10_000 : undefined,
    ),
  ]);
const firstSteering = [introduction, firstWork, ownSteer, ...afterSteer, nextTool("running")];
const secondSteering = [
  introduction,
  firstWork,
  ownSteer,
  ...afterSteer,
  nextTool("complete"),
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
// Native projection exposes subagent progress as tool labels, without a child transcript or detail.
function subagent(id: string, label: string, state: Activity["data"]["state"]) {
  return message(id, [{ type: "data-activity", id, data: { kind: "tool", label, state } }]);
}
const weatherSubagent = subagent(
  "demo_subagent_weather",
  "subagent (explore; 1/2 done)\n|- + Check Saturday's forecast\n`- > Check riverside conditions",
  "running",
);
const museumSubagent = subagent(
  "demo_subagent_museum",
  "subagent (general; 0/2 done)\n|- > Check opening hours\n`- > Check ticket availability",
  "running",
);
const weatherSubagentDone = subagent(
  "demo_subagent_weather",
  "subagent (explore; 2/2 done)\n|- + Check Saturday's forecast\n`- + Check riverside conditions",
  "complete",
);
const museumSubagentDone = subagent(
  "demo_subagent_museum",
  "subagent (general; 2/2 done)\n|- + Check opening hours\n`- + Check ticket availability",
  "complete",
);
const subagentUpdate = message("demo_subagent_update", [
  {
    type: "text",
    text: "The weather check is back: mild and dry, with the riverside path open. The museum check is still running.",
  },
]);
const parentRouteDone = message("demo_parent_work", [
  activity(
    "demo_parent_route",
    "tool",
    "Checked travel times",
    "complete",
    "The riverside path starts at Sanjo Station. The museum is a 15-minute bus ride away.",
    8000,
  ),
]);

export const agentWorkStages: AgentWorkStage[] = [
  {
    id: "queued",
    label: "Queued",
    description: "The prompt is waiting to be admitted.",
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
    id: "tool-call",
    label: "Tool call",
    description: "Completed reasoning followed by a running tool.",
    frames: [
      turn([
        message("demo_work", [
          thought,
          activity(
            "demo_weather",
            "tool",
            "Checking the weather…",
            "running",
            'weather.lookup({ city: "Kyoto", day: "Saturday" })',
          ),
        ]),
      ]),
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
          activity(
            "demo_weather",
            "tool",
            "Checking the weather…",
            "running",
            "Waiting for the forecast.",
          ),
          activity(
            "demo_hours",
            "tool",
            "Checking opening hours…",
            "running",
            "Waiting for the museum's schedule.",
          ),
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
          activity(
            "demo_parent_route",
            "tool",
            "Checking travel times…",
            "running",
            "Compare the walk from Sanjo Station with the trip to the museum.",
          ),
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
    label: "Streaming response",
    description:
      "Play to watch the final answer arrive in chunks. Pause to inspect a partial answer.",
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
        message("demo_full_tool", [
          activity(
            "demo_full_call",
            "tool",
            "Checking opening hours…",
            "running",
            "Waiting for the museum schedule.",
          ),
        ]),
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
          activity(
            "demo_weather",
            "tool",
            "Weather lookup",
            "failed",
            "Request timed out. The forecast service did not respond.",
            5000,
          ),
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
            activity(
              "demo_weather",
              "tool",
              "Weather lookup",
              "failed",
              "The forecast service remained unavailable after retrying.",
              5000,
            ),
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
