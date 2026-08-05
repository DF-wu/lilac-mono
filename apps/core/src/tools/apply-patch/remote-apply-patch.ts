import { decodeRemoteApplyPatchResponseJson } from "@stanley2058/lilac-fs";

import { sshExecScriptJson } from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText } from "../../ssh/remote-js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const REMOTE_ALLOW_ALL_PATHS: readonly string[] = [];

export async function remoteApplyPatch(params: {
  host: string;
  cwd: string;
  patchText: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  dangerouslyAllow?: boolean;
}): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return { ok: false, error: source.error.message };
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: params.cwd,
    js: source.value,
    input: {
      op: "apply_patch",
      denyPaths: [
        ...(params.dangerouslyAllow === true ? REMOTE_ALLOW_ALL_PATHS : REMOTE_DENY_PATHS),
      ],
      input: { patchText: params.patchText },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: 1_000_000,
    decodeResponse: decodeRemoteApplyPatchResponseJson,
  });

  if (res.status === "error") return { ok: false, error: res.error.message };
  return { ok: true, output: res.value };
}
