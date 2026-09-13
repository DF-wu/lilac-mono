import { describe, expect, it } from "bun:test";
import {
  renderMarkdownTablesAsCodeBlocks,
  splitMarkdownTopLevelTables,
} from "../../../../src/shared/markdown-table-renderer";
import { buildDiscordTableChunks } from "../../../../src/surface/discord/output/discord-table-chunks";
import { DISCORD_TABLE_IMAGE_MAX_BYTES } from "../../../../src/surface/discord/output/discord-table-image-renderer";
import { chunkMarkdownForEmbeds } from "../../../../src/surface/discord/output/markdown-chunker";

const table = "| Name | Value |\n| --- | ---: |\n| Alpha | 10 |";
const image = new Uint8Array([1, 2, 3]);
const options = {
  renderText: renderMarkdownTablesAsCodeBlocks,
  chunkText: (text: string) =>
    chunkMarkdownForEmbeds(text, {
      maxChunkLength: 2000,
      maxLastChunkLength: 2000,
      hardMaxChunkLength: 2000,
      useSmartSplitting: true,
      completeLastChunk: true,
    }),
  renderImages: async (tables: readonly unknown[]) => tables.map(() => image),
};

describe("table attachment boundaries", () => {
  it("attaches to the last preceding text chunk and starts fresh after each table", async () => {
    const before = "Intro paragraph.\n\n".repeat(220);
    const chunks = await buildDiscordTableChunks(
      `${before}${table}\n\nBetween\n\n${table}\n\nAfter`,
      options,
    );
    const first = chunks.findIndex((chunk) => chunk.tableImage?.filename === "table-1.png");
    expect(first).toBeGreaterThan(0);
    expect(
      chunks
        .slice(0, first + 1)
        .map((chunk) => chunk.text)
        .join(""),
    ).toContain("Intro paragraph.");
    expect(chunks[first]?.text).not.toContain("Between");
    expect(chunks[first + 1]?.text.trim()).toBe("Between");
    expect(chunks[first + 1]?.tableImage?.filename).toBe("table-2.png");
    expect(chunks.at(-1)?.text.trim()).toBe("After");
    expect(chunks.every((chunk) => chunk.text.length <= 2000)).toBe(true);
  });

  it("supports table-only and adjacent tables without placeholder or trailing messages", async () => {
    const chunks = await buildDiscordTableChunks(`${table}\n\n${table}\n\n`, options);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["", ""]);
    expect(chunks.map((chunk) => chunk.tableImage?.filename)).toEqual([
      "table-1.png",
      "table-2.png",
    ]);
    expect(chunks[0]?.tableImage?.description).toBe(table);
  });

  it("falls back in place for individual failures and PNGs over the upload limit", async () => {
    const chunks = await buildDiscordTableChunks(
      `Before\n\n${table}\n\nBetween\n\n${table}\n\nAfter\n\n${table}`,
      {
        ...options,
        renderImages: async () => [null, new Uint8Array(DISCORD_TABLE_IMAGE_MAX_BYTES + 1), image],
      },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Before");
    expect(chunks[0]?.text).toContain("Between");
    expect(chunks[0]?.text).toContain("After");
    expect(chunks[0]?.text.match(/```text/g)).toHaveLength(2);
    expect(chunks[0]?.tableImage?.filename).toBe("table-3.png");
  });

  it("accepts exactly 20 MiB and includes alt text only for complete tables up to 1024 chars", async () => {
    const source = `| Name |\n| --- |\n| ${"x".repeat(1003)} |`;
    expect(source.length).toBe(1024);
    const chunks = await buildDiscordTableChunks(
      `${source}\n\n${source.replace("Name", "Names")}`,
      {
        ...options,
        renderImages: async () => [new Uint8Array(DISCORD_TABLE_IMAGE_MAX_BYTES), image],
      },
    );
    expect(chunks[0]?.tableImage?.description).toBe(source);
    expect(chunks[1]?.tableImage?.description).toBeUndefined();
    expect(chunks[1]?.tableImage).toBeDefined();
  });

  it("does not rasterize fenced, quoted, or list-nested tables", async () => {
    const source = `\`\`\`md\n${table}\n\`\`\`\n\n${table
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n- List\n\n${table
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}`;
    let calls = 0;
    const chunks = await buildDiscordTableChunks(source, {
      ...options,
      renderImages: async () => {
        calls++;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(chunks.every((chunk) => !chunk.tableImage)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain(`\`\`\`md\n${table}`);
  });

  it("projects GFM inline text, escaped pipes, missing cells, and alignment", () => {
    const parts = splitMarkdownTopLevelTables(
      "| Left | Right |\n| :--- | ---: |\n| **Bold** \\| `code` | [label](https://example.com) |\n| Short |",
    );
    expect(parts[0]).toMatchObject({
      kind: "table",
      table: {
        rows: [
          [{ runs: [{ text: "Left" }] }, { runs: [{ text: "Right" }] }],
          [
            { runs: [{ text: "Bold", bold: true }, { text: " | " }, { text: "code", code: true }] },
            { runs: [{ text: "label" }] },
          ],
          [{ runs: [{ text: "Short" }] }, { runs: [] }],
        ],
        align: ["left", "right"],
      },
    });
  });
  it("preserves nested styles and treats code and unsafe HTML as literal text", () => {
    const parts = splitMarkdownTopLevelTables(
      "| Format |\n| --- |\n| **bold *italic*** __under__ ~~gone~~ <u>line</u><br>`**literal**` <img src=x> |",
    );
    expect(parts[0]).toMatchObject({
      kind: "table",
      table: {
        rows: [
          [{ runs: [{ text: "Format" }] }],
          [
            {
              runs: [
                { text: "bold ", bold: true },
                { text: "italic", bold: true, italic: true },
                { text: " " },
                { text: "under", underline: true },
                { text: " " },
                { text: "gone", strike: true },
                { text: " " },
                { text: "line", underline: true },
                { text: "\n" },
                { text: "**literal**", code: true },
                { text: " " },
                { text: "<img src=x>" },
              ],
            },
          ],
        ],
      },
    });
  });
});
