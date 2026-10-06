import type { WorkflowRevision, WorkflowRun } from "../src/workflow/workflow-domain";
import {
  buildWorkflowProgressCard,
  renderWorkflowProgressView,
  toSurfaceActions,
  type WorkflowProgressCounts,
  type WorkflowProgressView,
} from "../src/workflow/workflow-progress-view";

const now = Date.parse("2026-09-19T09:00:00Z");
const hash = "a".repeat(64);
const artifact = {
  artifactId: `workflow-source:${hash}`,
  blobRef: {
    version: 1 as const,
    objectId: `b1_${hash.slice(0, 32)}`,
    sha256: hash,
    byteLength: 0,
  },
};
const revision: WorkflowRevision = {
  revisionId: "demo_revision",
  canonicalProjectId: "demo_project",
  canonicalWorkspaceRoot: "/demo",
  scope: "project",
  normalizedPath: ".lilac/workflows/weekend-route.js",
  sourceSha256: hash,
  inputSchemaSha256: hash,
  resourcePolicySha256: hash,
  runtimeVersion: "lilac-workflow-js-v4",
  name: "weekend-route",
  snapshotArtifact: artifact,
  metadata: {
    name: "weekend-route",
    description: "Check the weather, compare routes, and plan a coffee stop.",
  },
  inputSchema: {},
  resources: {
    agents: { maxConcurrent: 2, maxTotal: 8 },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 60_000,
    waits: ["sleep"],
  },
  limits: {
    maxSourceBytes: 100_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: 10_000,
    maxResultBytes: 100_000,
  },
  createdAt: now,
};
const baseRun: WorkflowRun = {
  runId: "demo_workflow_run",
  revisionId: revision.revisionId,
  state: "running",
  inputSchemaSnapshot: {},
  args: {},
  argsSha256: hash,
  origin: {
    requestId: "demo_request",
    sessionId: "native:demo",
    client: "native",
    userId: "demo_user",
    projectCwd: "/demo",
  },
  completionTarget: { kind: "durable_surface" },
  progressTarget: { platform: "native", channelId: "demo", replyToMessageId: null },
  terminalDetail: null,
  result: null,
  resultArtifact: null,
  claimedBy: "demo_engine",
  claimedAt: now,
  createdAt: now,
  startedAt: now,
  updatedAt: now,
  terminalAt: null,
};

function counts(overrides: Partial<WorkflowProgressCounts> = {}): WorkflowProgressCounts {
  return {
    completed: 0,
    queued: 0,
    active: 0,
    waiting: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
    ...overrides,
  };
}

function actionsFor(state: WorkflowRun["state"]): WorkflowProgressView["availableActions"] {
  if (["succeeded", "failed", "cancelled"].includes(state)) return [];
  if (state === "paused") return ["resume", "cancel"];
  return ["pause", "cancel"];
}

function view(
  state: WorkflowRun["state"],
  overrides: Partial<WorkflowProgressView> = {},
): WorkflowProgressView {
  return withRunTimes({
    revision,
    run: { ...baseRun, state },
    elapsedMs: 84_000,
    progress: counts({ completed: 2, active: 1, queued: 1, total: 4 }),
    phases: [
      { name: "Research", ...counts({ completed: 2, total: 2 }) },
      { name: "Route", ...counts({ active: 1, queued: 1, total: 2 }) },
    ],
    recentOperations: [
      { label: "Choose the walking route", phase: "Route", kind: "agent", state: "running" },
      { label: "Pick a coffee stop", phase: "Route", kind: "agent", state: "queued" },
      { label: "Check opening hours", phase: "Research", kind: "agent", state: "succeeded" },
    ],
    waits: [],
    agents: { used: 3, active: 1, queued: 1 },
    nextTriggerAt: null,
    availableActions: actionsFor(state),
    manualReconciliationRequired: false,
    sensitive: false,
    ...overrides,
  });
}

/** Places every sample's present at `now`, so a demo can shift all card timestamps together. */
function withRunTimes(view: WorkflowProgressView): WorkflowProgressView {
  const terminal = ["succeeded", "failed", "cancelled"].includes(view.run.state);
  return {
    ...view,
    run: { ...view.run, startedAt: now - view.elapsedMs, terminalAt: terminal ? now : null },
  };
}

const finishedPhases = [
  { name: "Research", ...counts({ completed: 2, total: 2 }) },
  { name: "Route", ...counts({ completed: 2, total: 2 }) },
];
const queued = view("queued", {
  elapsedMs: 0,
  progress: counts(),
  phases: [],
  recentOperations: [],
  agents: { used: 0, active: 0, queued: 0 },
});
const starting = view("running", {
  elapsedMs: 2_000,
  progress: counts({ active: 1, queued: 1, total: 2 }),
  phases: [],
  recentOperations: [
    { label: "Check the weather", phase: "Research", kind: "agent", state: "dispatched" },
    { label: "Check opening hours", phase: "Research", kind: "agent", state: "queued" },
  ],
  agents: { used: 1, active: 1, queued: 1 },
});
const parallel = view("running", {
  elapsedMs: 12_000,
  progress: counts({ active: 2, total: 2 }),
  phases: [],
  recentOperations: starting.recentOperations.map((operation) => ({
    ...operation,
    state: "running",
  })),
  agents: { used: 2, active: 2, queued: 0 },
});
const succeeded = view("succeeded", {
  elapsedMs: 110_000,
  run: {
    ...baseRun,
    state: "succeeded",
    terminalAt: now + 110_000,
    result:
      "Start at Sanjo Station. Walk the river loop for 45 minutes, then stop at Chapter House for coffee.",
  },
  progress: counts({ completed: 4, total: 4 }),
  phases: finishedPhases,
  agents: { used: 4, active: 0, queued: 0 },
});

export const designWorkflowViews = {
  queued,
  starting,
  parallel,
  partial: view("running", {
    progress: counts({ completed: 1, active: 1, cancelled: 1, total: 3 }),
    phases: [],
    recentOperations: [
      { label: "Check the weather", phase: "Research", kind: "agent", state: "succeeded" },
      { label: "Check opening hours", phase: "Research", kind: "agent", state: "running" },
      { label: "Check the alternate museum", phase: "Research", kind: "agent", state: "cancelled" },
    ],
    agents: { used: 3, active: 1, queued: 0 },
  }),
  running: view("running"),
  blocked: view("blocked", {
    recentOperations: [
      { label: "Choose the walking route", phase: "Route", kind: "agent", state: "blocked" },
    ],
    agents: { used: 3, active: 0, queued: 1 },
  }),
  waiting: view("blocked", {
    progress: counts({ completed: 2, waiting: 1, total: 3 }),
    phases: [finishedPhases[0]!, { name: "Refresh", ...counts({ waiting: 1, total: 1 }) }],
    recentOperations: [
      { label: "Wait for the forecast refresh", phase: "Refresh", kind: "wait", state: "blocked" },
    ],
    waits: [
      {
        kind: "sleep",
        prompt: "Wait for the forecast refresh",
        dueAt: now + 180_000,
        deadlineAt: null,
        requiresReplyToMessage: false,
        isCurrentChannel: true,
      },
    ],
    agents: { used: 2, active: 0, queued: 0 },
  }),
  reply: view("blocked", {
    revision: { ...revision, resources: { ...revision.resources, waits: ["reply", "sleep"] } },
    run: {
      ...baseRun,
      state: "blocked",
      origin: { ...baseRun.origin, client: "discord", sessionId: "discord:demo" },
    },
    progress: counts({ completed: 2, waiting: 1, total: 3 }),
    phases: [finishedPhases[0]!, { name: "Choice", ...counts({ waiting: 1, total: 1 }) }],
    recentOperations: [
      {
        label: "Choose the riverside walk or museum",
        phase: "Choice",
        kind: "wait",
        state: "blocked",
      },
    ],
    waits: [
      {
        kind: "reply",
        prompt: "Choose the riverside walk or museum",
        dueAt: null,
        deadlineAt: now + 600_000,
        requiresReplyToMessage: true,
        isCurrentChannel: false,
      },
    ],
    agents: { used: 2, active: 0, queued: 0 },
  }),
  paused: view("paused"),
  resumed: view("running", { elapsedMs: 100_000 }),
  succeeded,
  failed: view("failed", {
    run: {
      ...baseRun,
      state: "failed",
      terminalAt: now + 84_000,
      terminalDetail:
        "The route service returned an error. The weather and opening-hours checks completed.",
    },
    progress: counts({ completed: 2, failed: 1, cancelled: 1, total: 4 }),
    phases: [
      finishedPhases[0]!,
      { name: "Route", ...counts({ failed: 1, cancelled: 1, total: 2 }) },
    ],
    agents: { used: 3, active: 0, queued: 0 },
  }),
  timeout: view("running", {
    recentOperations: [
      { label: "Choose the walking route", phase: "Route", kind: "agent", state: "timed_out" },
      { label: "Try the shorter river loop", phase: "Route", kind: "agent", state: "running" },
    ],
    progress: counts({ completed: 2, failed: 1, active: 1, total: 4 }),
    phases: [finishedPhases[0]!, { name: "Route", ...counts({ failed: 1, active: 1, total: 2 }) }],
    agents: { used: 4, active: 1, queued: 0 },
  }),
  stepFailed: view("running", {
    recentOperations: [
      { label: "Choose the walking route", phase: "Route", kind: "agent", state: "failed" },
      { label: "Try the shorter river loop", phase: "Route", kind: "agent", state: "running" },
    ],
    progress: counts({ completed: 2, failed: 1, active: 1, total: 4 }),
    phases: [finishedPhases[0]!, { name: "Route", ...counts({ failed: 1, active: 1, total: 2 }) }],
    agents: { used: 4, active: 1, queued: 0 },
  }),
  cancelled: view("cancelled", {
    run: {
      ...baseRun,
      state: "cancelled",
      terminalAt: now + 84_000,
      terminalDetail: "Cancelled by the user. Completed research remains available.",
    },
    progress: counts({ completed: 2, cancelled: 2, total: 4 }),
    phases: [finishedPhases[0]!, { name: "Route", ...counts({ cancelled: 2, total: 2 }) }],
    agents: { used: 3, active: 0, queued: 0 },
  }),
  attention: view("running", { manualReconciliationRequired: true, availableActions: ["cancel"] }),
  scheduled: view("queued", { ...queued, nextTriggerAt: now + 86_400_000 }),
  largeResult: view("succeeded", {
    ...succeeded,
    run: {
      ...succeeded.run,
      result: null,
      resultArtifact: { ...artifact, artifactId: `workflow-value:${hash}` },
    },
  }),
  noResult: view("succeeded", { ...succeeded, run: { ...succeeded.run, result: null } }),
  shortenedResult: view("succeeded", {
    ...succeeded,
    run: { ...succeeded.run, result: "Route notes: ".repeat(1_400) },
  }),
  sensitive: view("succeeded", {
    ...succeeded,
    sensitive: true,
    revision: { ...revision, metadata: { ...revision.metadata, description: "Workflow" } },
    phases: [{ name: "Workflow", ...counts({ completed: 4, total: 4 }) }],
  }),
  manyPhases: view("running", {
    progress: counts({ completed: 4, active: 1, queued: 1, total: 6 }),
    phases: [
      "Weather",
      "Opening hours",
      "Starting point",
      "Walking distance",
      "Coffee stop",
      "Summary",
    ].map((name, index) => ({
      name,
      ...counts({
        total: 1,
        completed: index < 4 ? 1 : 0,
        active: index === 4 ? 1 : 0,
        queued: index === 5 ? 1 : 0,
      }),
    })),
  }),
};

export function designWorkflowProgress() {
  return Object.fromEntries(
    Object.entries(designWorkflowViews).map(([key, view]) => {
      const stoppedCounts = (progress: WorkflowProgressCounts) => ({
        ...progress,
        active: 0,
        queued: 0,
        waiting: 0,
        cancelled: progress.cancelled + progress.active + progress.queued + progress.waiting,
      });
      const paused = {
        ...view,
        run: { ...view.run, state: "paused" as const },
        availableActions: ["resume", "cancel"] as const,
      };
      const resumed = {
        ...view,
        run: {
          ...view.run,
          state: view.run.state === "paused" ? ("running" as const) : view.run.state,
        },
        availableActions: ["pause", "cancel"] as const,
      };
      const cancelled = {
        ...view,
        run: {
          ...view.run,
          state: "cancelled" as const,
          terminalAt: now,
          terminalDetail: "Cancelled by the user. Completed research remains available.",
        },
        progress: stoppedCounts(view.progress),
        phases: view.phases.map((phase) => ({ ...phase, ...stoppedCounts(phase) })),
        agents: { ...view.agents, active: 0, queued: 0 },
        availableActions: [],
      };
      return [
        key,
        {
          ...render(view),
          transitions: {
            paused: render({ ...paused, availableActions: [...paused.availableActions] }),
            resumed: render({ ...resumed, availableActions: [...resumed.availableActions] }),
            cancelled: render(cancelled),
          },
        },
      ];
    }),
  );
}

function render(view: WorkflowProgressView) {
  const actions = toSurfaceActions({
    view,
    actionIds: new Map(view.availableActions.map((kind) => [kind, `demo_workflow_${kind}`])),
  });
  return {
    ...renderWorkflowProgressView({ view, platform: "native", actions }),
    workflow: buildWorkflowProgressCard(view),
  };
}
