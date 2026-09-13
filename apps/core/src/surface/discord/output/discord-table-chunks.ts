import {
  splitMarkdownTopLevelTables,
  type MarkdownTableData,
} from "../../../shared/markdown-table-renderer";
import { DISCORD_TABLE_IMAGE_MAX_BYTES } from "./discord-table-image-renderer";

export type DiscordPlainChunk = {
  text: string;
  tableImage?: { bytes: Uint8Array; filename: string; description?: string };
};

export async function buildDiscordTableChunks(
  text: string,
  options: {
    renderText: (text: string) => string;
    chunkText: (text: string) => string[];
    renderImages: (tables: readonly MarkdownTableData[]) => Promise<readonly (Uint8Array | null)[]>;
  },
): Promise<DiscordPlainChunk[]> {
  const segments = splitMarkdownTopLevelTables(text);
  const tables = segments.flatMap((segment) => (segment.kind === "table" ? [segment.table] : []));
  const images = tables.length > 0 ? await options.renderImages(tables) : [];
  const chunks: DiscordPlainChunk[] = [];
  let pendingText = "";
  let tableIndex = 0;
  const flushText = (): DiscordPlainChunk[] => {
    const rendered = options.renderText(pendingText);
    pendingText = "";
    if (!rendered.trim()) return [];
    return options.chunkText(rendered).map((chunk) => ({ text: chunk }));
  };
  for (const segment of segments) {
    if (segment.kind === "text") {
      pendingText += segment.text;
      continue;
    }
    const bytes = images[tableIndex++];
    if (!bytes || bytes.byteLength > DISCORD_TABLE_IMAGE_MAX_BYTES) {
      pendingText += segment.source;
      continue;
    }
    const preceding = flushText();
    const target = preceding.at(-1) ?? { text: "" };
    target.tableImage = {
      bytes,
      filename: `table-${tableIndex}.png`,
      description: segment.source.length <= 1024 ? segment.source : undefined,
    };
    if (preceding.length === 0) preceding.push(target);
    chunks.push(...preceding);
  }
  chunks.push(...flushText());
  return chunks;
}
