import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalBlobStore } from "@stanley2058/lilac-blob-storage";
import { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import { subagentFollowUpRegistration } from "../../../src/workflow/subagent-follow-up";
import { WorkflowSubagentDispatcher } from "../../../src/workflow/workflow-subagent-dispatcher";

const [root, mode] = process.argv.slice(2) as [string, string];
const input: Parameters<typeof subagentFollowUpRegistration>[0] = JSON.parse(
  await readFile(path.join(root, "input.json"), "utf8"),
);
const registration = subagentFollowUpRegistration(input);
if (!registration) throw new Error("Expected a follow-up registration");
const store = new DurableWorkflowStore(path.join(root, "workflow.db"));
const blobStore = (await createLocalBlobStore({ root: path.join(root, "blobs") })).unwrap();
const dispatcher = await WorkflowSubagentDispatcher.create({
  store,
  blobStore,
  dataDir: path.join(root, "data"),
  onRunCreated: async (run) => {
    if (mode !== "crash") return;
    // This hook runs after the invocation commits but before delegate returns to terminalize intake.
    await writeFile(path.join(root, "committed-run"), run.runId);
    process.kill(process.pid, "SIGKILL");
  },
});
const handle = await dispatcher.delegate(registration);
await writeFile(path.join(root, "replayed-run"), handle.runId);
store.close();
await blobStore.close({ deadlineAtMs: Date.now() + 5000 });
