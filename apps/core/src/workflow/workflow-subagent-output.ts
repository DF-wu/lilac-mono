import {
  coreToolResultArtifactIdFromUri,
  type ToolResultArtifactStore,
} from "../artifacts/tool-result-artifact-store";

const TOOL_RESULT_ENVELOPE =
  /^(?<head>[\s\S]*)\n\n\[tool result truncated: \d+ characters omitted\]\nComplete output: (?<uri>(?:tool-result|resource):\/\/[^\s]+)\nUse (?:read|read_file) with this URI and start: \{ "type": "offset", "offset": 0 \}\. Reuse the returned nextStart unchanged while more content remains\.\n\n(?<tail>[\s\S]*)$/u;

export async function resolveWorkflowSubagentToolResult(input: {
  finalText: string;
  childSessionId: string;
  artifacts?: ToolResultArtifactStore;
}): Promise<string> {
  const match = TOOL_RESULT_ENVELOPE.exec(input.finalText);
  const uri = match?.groups?.["uri"];
  if (!uri || coreToolResultArtifactIdFromUri(uri) === null) return input.finalText;
  const expired = [
    match.groups?.["head"] ?? "",
    "",
    "[The child tool result expired before it could be transferred to the parent.]",
    "",
    match.groups?.["tail"] ?? "",
  ].join("\n");
  if (input.artifacts) {
    const artifact = await input.artifacts.read(uri, input.childSessionId);
    return artifact.match({ ok: (value) => value.content, err: () => expired });
  }
  return expired;
}
