import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  CONTEXT_LAYERS,
  DEPLOYMENT_UNITS,
  EVENT_TOPICS,
  IMPLEMENTATION_GAPS,
  PERSISTENCE_ENTRIES,
  SAFETY_AND_RELIABILITY,
  STARTUP_SEQUENCE,
  STATE_MACHINES,
  WORKSPACE_PACKAGES,
} from "../src/data/contracts";
import { RESEARCH_SOURCES } from "../src/data/research";
import { RUNTIME_SCENARIOS } from "../src/data/scenarios";
import { MAP_EDGES, MAP_LENS_OPTIONS, MAP_NODES } from "../src/data/system-map";
import { SOURCE_SNAPSHOT_COMMIT } from "../src/data/types";
import type { SourceRef } from "../src/data/types";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const snapshotLineCounts = new Map<string, number>();

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function getSnapshotLineCount(sourcePath: string): number {
  const cachedLineCount = snapshotLineCounts.get(sourcePath);
  if (cachedLineCount !== undefined) return cachedLineCount;

  const result = Bun.spawnSync(["git", "show", `${SOURCE_SNAPSHOT_COMMIT}:${sourcePath}`], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!result.success) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `Missing source evidence file in ${SOURCE_SNAPSHOT_COMMIT}: ${sourcePath}\n${detail}`,
    );
  }

  const lineCount = new TextDecoder().decode(result.stdout).split(/\r?\n/u).length;
  snapshotLineCounts.set(sourcePath, lineCount);
  return lineCount;
}

function validateSource(sourceRef: SourceRef): void {
  const lineCount = getSnapshotLineCount(sourceRef.path);
  if (sourceRef.line < 1 || sourceRef.line > lineCount) {
    throw new Error(
      `Source evidence line is outside ${SOURCE_SNAPSHOT_COMMIT}: ${sourceRef.path}:${sourceRef.line} (file has ${lineCount} lines)`,
    );
  }
}

describe("architecture evidence model", () => {
  test("covers the canonical 9 topics and 24 event types", () => {
    const eventTypes = EVENT_TOPICS.flatMap((topic) => topic.events.map((event) => event.type));
    expect(EVENT_TOPICS).toHaveLength(9);
    expect(eventTypes).toHaveLength(24);
    expect(uniqueCount(eventTypes)).toBe(eventTypes.length);
  });

  test("keeps every runtime scenario ordered and lane-valid", () => {
    expect(RUNTIME_SCENARIOS).toHaveLength(15);
    expect(uniqueCount(RUNTIME_SCENARIOS.map((scenario) => scenario.id))).toBe(
      RUNTIME_SCENARIOS.length,
    );

    for (const scenario of RUNTIME_SCENARIOS) {
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(uniqueCount(scenario.steps.map((step) => step.id))).toBe(scenario.steps.length);
      scenario.steps.forEach((step, index) => {
        expect(step.order === index + 1).toBe(true);
        expect(scenario.lanes.some((lane) => lane === step.from)).toBe(true);
        expect(scenario.lanes.some((lane) => lane === step.to)).toBe(true);
        expect(step.sources.length).toBeGreaterThan(0);
      });
    }
  });

  test("keeps topology edges attached to real nodes and lenses", () => {
    const nodeIds = new Set(MAP_NODES.map((node) => node.id));
    const lensIds = new Set(MAP_LENS_OPTIONS.map((lens) => lens.id));
    expect(uniqueCount(MAP_NODES.map((node) => node.id))).toBe(MAP_NODES.length);
    expect(uniqueCount(MAP_EDGES.map((edge) => edge.id))).toBe(MAP_EDGES.length);

    for (const edge of MAP_EDGES) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
      expect(edge.lens.length).toBeGreaterThan(0);
      expect(edge.lens.every((lens) => lensIds.has(lens))).toBe(true);
    }
  });

  test("keeps every source link on an existing in-range line in the pinned snapshot", () => {
    const sources: SourceRef[] = [
      ...MAP_NODES.flatMap((node) => node.data.sources),
      ...MAP_EDGES.flatMap((edge) => edge.sources),
      ...RUNTIME_SCENARIOS.flatMap((scenario) => scenario.steps.flatMap((step) => step.sources)),
      ...EVENT_TOPICS.flatMap((topic) => topic.sources),
      ...STATE_MACHINES.flatMap((machine) => machine.sources),
      ...WORKSPACE_PACKAGES.flatMap((workspace) => workspace.keyFiles),
      ...PERSISTENCE_ENTRIES.map((entry) => entry.source),
      ...STARTUP_SEQUENCE.map((entry) => entry.source),
      ...DEPLOYMENT_UNITS.flatMap((entry) => entry.sources),
      ...CONTEXT_LAYERS.map((entry) => entry.source),
      ...SAFETY_AND_RELIABILITY.map((entry) => entry.source),
      ...IMPLEMENTATION_GAPS.flatMap((entry) => [entry.source, entry.plan]),
    ];

    expect(sources.length).toBeGreaterThan(250);
    for (const sourceRef of sources) validateSource(sourceRef);
  });

  test("uses explicit external research URLs", () => {
    expect(RESEARCH_SOURCES.length).toBeGreaterThanOrEqual(7);
    for (const researchSource of RESEARCH_SOURCES) {
      expect(new URL(researchSource.url).protocol).toBe("https:");
      expect(researchSource.principle.length).toBeGreaterThan(20);
      expect(researchSource.applied.length).toBeGreaterThan(20);
    }
  });
});
