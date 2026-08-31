import type { RequestContext } from "./types";

const invocationCwdByContext = new WeakMap<RequestContext, string>();

export function bindRequestInvocationCwd(context: RequestContext, cwd: string | undefined): void {
  if (cwd) invocationCwdByContext.set(context, cwd);
}

export function requestInvocationCwd(context: RequestContext): string | undefined {
  return invocationCwdByContext.get(context);
}
