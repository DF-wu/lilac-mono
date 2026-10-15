import { captureAgentPromise } from "./failure-adapters";

export function isToolCallBarrier(name: string): boolean {
  const localName = name.startsWith("mcp__lilac__") ? name.slice("mcp__lilac__".length) : name;
  return ["write", "write_file", "edit", "edit_file", "patch", "apply_patch"].includes(localName);
}

export function groupToolCalls<T>(calls: readonly T[], name: (call: T) => string): T[][] {
  const groups: T[][] = [];
  let parallel: T[] = [];
  for (const call of calls) {
    if (isToolCallBarrier(name(call))) {
      if (parallel.length > 0) groups.push(parallel);
      groups.push([call]);
      parallel = [];
      continue;
    }
    parallel.push(call);
  }
  if (parallel.length > 0) groups.push(parallel);
  return groups;
}

/** MCP calls arrive individually, so reserve their order before asynchronous validation. */
export class ToolCallScheduler {
  private barrier: Promise<void> = Promise.resolve();
  private parallel: Promise<void>[] = [];

  run<T>(name: string, execute: () => Promise<T>): Promise<T> {
    const exclusive = isToolCallBarrier(name);
    const ready = exclusive ? Promise.all([this.barrier, ...this.parallel]) : this.barrier;
    const result = ready.then(execute);
    const settled = captureAgentPromise(() => result).then(() => undefined);
    if (exclusive) {
      this.barrier = settled;
      this.parallel = [];
    } else {
      this.parallel.push(settled);
      void settled.then(() => {
        const index = this.parallel.indexOf(settled);
        if (index >= 0) this.parallel.splice(index, 1);
      });
    }
    return result;
  }
}
