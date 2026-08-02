import { createLogger } from "@stanley2058/lilac-utils";
import type { ToolModelMessage } from "ai";
import { stripVTControlCharacters } from "node:util";

import type { ToolResultArtifactStore } from "./tool-result-artifact-store";

const GENERATED_OVERFLOW_REFERENCE =
  /^\[tool result overflow\]\nThe tool completed, but its output exceeded the inline limit\.\n(?:Complete captured output: tool-result:\/\/[0-9a-f-]{36}\nUse read_file with this URI and start: \{ "type": "offset", "offset": 0 \}\. Reuse nextStart unchanged while more content remains\. Do not re-run the original tool\.|The complete output could not be retained\. Narrow the request or re-run the tool\.)$/u;
const UNSERIALIZABLE_JSON_OUTPUT = "[tool result is not JSON-serializable]";

export type ToolResultOutput = Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
>["output"];

type MeasuredText = {
  outputIndex: number;
  itemIndex?: number;
  value: string;
  bytes: number;
};

export type NormalizeToolResultOutputFn = (
  output: ToolResultOutput,
  context: {
    toolCallId: string;
    toolName: string;
    bypassGenericOutputNormalizer?: boolean;
    aggregateOutputBudgetExempt?: boolean;
  },
) => ToolResultOutput | Promise<ToolResultOutput>;

export type SettledToolResultOutputEntry = {
  output: ToolResultOutput;
  context: Parameters<NormalizeToolResultOutputFn>[1];
};

export type NormalizeSettledToolResultOutputsFn = (
  entries: readonly SettledToolResultOutputEntry[],
  normalizeUnspilled?: NormalizeToolResultOutputFn,
) => Promise<ToolResultOutput[]>;

export type ToolResultOutputGroupNormalizer = NormalizeToolResultOutputFn & {
  normalizeSettled: NormalizeSettledToolResultOutputsFn;
};

export type ToolResultOutputNormalizerConfig = {
  maxInlineBytes: number;
  artifactTtlMs: number;
  maxArtifactBytesPerScope: number;
  maxArtifactBytes?: number;
};

export type LegacyToolResultOutputNormalizerConfig = {
  maxPreviewBytes: number;
  artifactTtlMs: number;
  artifactMaxBytesPerSession: number;
  maxArtifactBytes?: number;
};

export type ToolResultOutputNormalizerOwner = (
  | { scopeId: string; sessionId?: string }
  | { scopeId?: string; sessionId: string }
) & { requestId: string };

export type ToolResultOutputNormalizerOptions = {
  artifacts?: ToolResultArtifactStore;
  owner: ToolResultOutputNormalizerOwner;
  getOutputConfig: () => ToolResultOutputNormalizerConfig | LegacyToolResultOutputNormalizerConfig;
  sanitize?: (value: string) => string;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function removeUnsafeControls(value: string): string {
  const withoutTerminalControls = stripVTControlCharacters(value);
  const withoutUnsafeControls = Array.from(withoutTerminalControls)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code >= 0x20;
    })
    .join("");
  return withoutUnsafeControls
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS)[A-Z0-9_]*)=([^\s]+)/giu,
      "$1=<redacted>",
    )
    .replace(/(['"]?\s*authorization\s*:\s*)([^'"\n]+)(['"]?)/giu, "$1<redacted>$3")
    .replace(/(https?:\/\/)([^\s/:@]+):([^\s@]+)@/giu, "$1<redacted>:<redacted>@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/gu,
      "<redacted>",
    );
}

function buildOverflowReference(uri?: string): string {
  return uri
    ? `[tool result overflow]\nThe tool completed, but its output exceeded the inline limit.\nComplete captured output: ${uri}\nUse read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse nextStart unchanged while more content remains. Do not re-run the original tool.`
    : "[tool result overflow]\nThe tool completed, but its output exceeded the inline limit.\nThe complete output could not be retained. Narrow the request or re-run the tool.";
}

function resolveConfig(
  config: ToolResultOutputNormalizerConfig | LegacyToolResultOutputNormalizerConfig,
): ToolResultOutputNormalizerConfig {
  if ("maxInlineBytes" in config) return config;
  return {
    maxInlineBytes: config.maxPreviewBytes,
    artifactTtlMs: config.artifactTtlMs,
    maxArtifactBytesPerScope: config.artifactMaxBytesPerSession,
    ...(config.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: config.maxArtifactBytes }),
  };
}

function ownerScopeId(owner: ToolResultOutputNormalizerOwner): string {
  const scopeId = owner.scopeId ?? owner.sessionId;
  if (!scopeId) throw new Error("Tool result normalizer owner scopeId is required");
  return scopeId;
}

export function createOverflowReferenceNormalizer(
  params: ToolResultOutputNormalizerOptions,
): ToolResultOutputGroupNormalizer {
  const logger = createLogger({ module: "tool-result-output" });

  function prepareCapturedText(value: string): string {
    if (GENERATED_OVERFLOW_REFERENCE.test(value)) return value;
    value = removeUnsafeControls(value);
    if (params.sanitize) value = removeUnsafeControls(params.sanitize(value));
    return value;
  }

  async function normalizeCapturedText(
    value: string,
    context: Parameters<NormalizeToolResultOutputFn>[1],
    spill: boolean,
    config = resolveConfig(params.getOutputConfig()),
  ): Promise<string> {
    if (GENERATED_OVERFLOW_REFERENCE.test(value)) return value;
    value = prepareCapturedText(value);
    if (!spill) return value;

    let uri: string | undefined;
    try {
      const artifact = await params.artifacts?.create({
        scopeId: ownerScopeId(params.owner),
        requestId: params.owner.requestId,
        ...context,
        content: value,
        ttlMs: config.artifactTtlMs,
        maxBytesPerScope: config.maxArtifactBytesPerScope,
        ...(config.maxArtifactBytes === undefined
          ? {}
          : { maxArtifactBytes: config.maxArtifactBytes }),
      });
      uri = artifact?.uri;
    } catch (error) {
      logger.warn("tool.artifact.write_failed", {
        toolName: context.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("tool.result.overflow", {
      toolName: context.toolName,
      originalBytes: utf8Bytes(value),
      artifactStored: uri !== undefined,
    });

    return buildOverflowReference(uri);
  }

  function measureOutput(output: ToolResultOutput, outputIndex: number): MeasuredText[] {
    if (output.type === "text" || output.type === "error-text") {
      const value = prepareCapturedText(output.value);
      return [
        {
          outputIndex,
          value,
          bytes: GENERATED_OVERFLOW_REFERENCE.test(value) ? 0 : utf8Bytes(value),
        },
      ];
    }

    if (output.type === "execution-denied") {
      if (output.reason === undefined) return [];
      const value = prepareCapturedText(output.reason);
      return [
        {
          outputIndex,
          value,
          bytes: GENERATED_OVERFLOW_REFERENCE.test(value) ? 0 : utf8Bytes(value),
        },
      ];
    }

    if (output.type === "json" || output.type === "error-json") {
      try {
        const value = JSON.stringify(output.value, null, 2);
        if (value === undefined) return [];
        return [{ outputIndex, value, bytes: utf8Bytes(value) }];
      } catch {
        return [];
      }
    }

    if (output.type === "content") {
      return output.value.flatMap((item, itemIndex) => {
        if (item.type !== "text") return [];
        const value = prepareCapturedText(item.text);
        return [
          {
            outputIndex,
            itemIndex,
            value,
            bytes: GENERATED_OVERFLOW_REFERENCE.test(value) ? 0 : utf8Bytes(value),
          },
        ];
      });
    }

    return [];
  }

  function measuredTextKey(outputIndex: number, itemIndex?: number): string {
    return itemIndex === undefined ? `${outputIndex}` : `${outputIndex}:${itemIndex}`;
  }

  function selectSpills(measured: readonly MeasuredText[], maxInlineBytes: number): Set<string> {
    let inlineBytes = measured.reduce((sum, item) => sum + item.bytes, 0);
    const selected = new Set<string>();
    const candidates = measured
      .filter((item) => item.bytes > 0)
      .toSorted(
        (left, right) =>
          right.bytes - left.bytes ||
          left.outputIndex - right.outputIndex ||
          (left.itemIndex ?? -1) - (right.itemIndex ?? -1),
      );

    for (const candidate of candidates) {
      if (inlineBytes <= maxInlineBytes) break;
      selected.add(measuredTextKey(candidate.outputIndex, candidate.itemIndex));
      inlineBytes -= candidate.bytes;
    }

    return selected;
  }

  async function normalizeOutput(
    output: ToolResultOutput,
    context: Parameters<NormalizeToolResultOutputFn>[1],
    outputIndex: number,
    selected: ReadonlySet<string>,
    config: ToolResultOutputNormalizerConfig,
  ): Promise<ToolResultOutput> {
    const spillOutput = selected.has(measuredTextKey(outputIndex));

    if (output.type === "text" || output.type === "error-text") {
      const value = await normalizeCapturedText(output.value, context, spillOutput, config);
      return { ...output, value };
    }

    if (output.type === "execution-denied") {
      if (!output.reason) return output;
      const reason = await normalizeCapturedText(output.reason, context, spillOutput, config);
      return { ...output, reason };
    }

    if (output.type === "json" || output.type === "error-json") {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(output.value, null, 2);
      } catch {
        serialized = undefined;
      }
      if (serialized === undefined) {
        return output.type === "error-json"
          ? { ...output, type: "error-text", value: UNSERIALIZABLE_JSON_OUTPUT }
          : { ...output, type: "text", value: UNSERIALIZABLE_JSON_OUTPUT };
      }
      if (!spillOutput) return output;
      const value = await normalizeCapturedText(serialized, context, true, config);
      return output.type === "error-json"
        ? { ...output, type: "error-text", value }
        : { ...output, type: "text", value };
    }

    if (output.type === "content") {
      const value = await Promise.all(
        output.value.map(async (item, itemIndex) => {
          if (item.type !== "text") return item;
          const text = await normalizeCapturedText(
            item.text,
            context,
            selected.has(measuredTextKey(outputIndex, itemIndex)),
            config,
          );
          return { ...item, text };
        }),
      );
      return { ...output, value };
    }

    return output;
  }

  const normalize: NormalizeToolResultOutputFn = async (output, context) => {
    const config = resolveConfig(params.getOutputConfig());
    const measured = measureOutput(output, 0);
    return await normalizeOutput(
      output,
      context,
      0,
      selectSpills(measured, config.maxInlineBytes),
      config,
    );
  };

  const normalizeSettled: NormalizeSettledToolResultOutputsFn = async (
    entries,
    normalizeUnspilled = normalize,
  ) => {
    const config = resolveConfig(params.getOutputConfig());
    const measured = entries.flatMap((entry, outputIndex) =>
      entry.context.aggregateOutputBudgetExempt === true
        ? []
        : measureOutput(entry.output, outputIndex),
    );
    const selected = selectSpills(measured, config.maxInlineBytes);

    return await Promise.all(
      entries.map(async (entry, outputIndex) => {
        const outputSelected = measured.some(
          (item) =>
            item.outputIndex === outputIndex &&
            selected.has(measuredTextKey(item.outputIndex, item.itemIndex)),
        );
        if (!outputSelected && normalizeUnspilled !== normalize) {
          return await normalizeUnspilled(entry.output, entry.context);
        }
        return await normalizeOutput(entry.output, entry.context, outputIndex, selected, config);
      }),
    );
  };

  return Object.assign(normalize, { normalizeSettled });
}

export const createToolResultOutputNormalizer = createOverflowReferenceNormalizer;
