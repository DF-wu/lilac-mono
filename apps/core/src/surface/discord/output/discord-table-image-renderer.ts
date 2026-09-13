import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { chromium, type Page } from "playwright";

import type { MarkdownTableData } from "../../../shared/markdown-table-renderer";
import { settleSurfaceFallback } from "../../adapter";

export const DISCORD_TABLE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

class DiscordTableRenderFailed extends TaggedError("DiscordTableRenderFailed")<{
  message: string;
}> {}

async function captureTableRender<T>(
  operation: () => Promise<T>,
): Promise<ResultType<T, DiscordTableRenderFailed>> {
  return settleSurfaceFallback(
    await Result.tryPromise({
      try: operation,
      catch: (cause) => {
        const fallback = new DiscordTableRenderFailed({ message: "Table image rendering failed" });
        if (Panic.is(cause)) return { kind: "panic", panic: cause, fallback };
        return { kind: "fallback", fallback };
      },
    }),
  );
}

function drawTable(table: MarkdownTableData): void {
  const element = document.createElement("table");
  element.style.cssText =
    'border-collapse:collapse;table-layout:fixed;font:25px/32px "Liberation Sans",Arial,sans-serif;color:#eeeef5;outline:1px solid #474656;outline-offset:-1px';
  document.body.style.margin = "0";
  document.body.replaceChildren(element);
  const cells = table.rows.map((row, rowIndex) => {
    const tr = element.insertRow();
    return row.map((cell) => {
      const td = tr.insertCell();
      td.style.cssText = "padding:4px 6px;vertical-align:top;box-shadow:inset 1px 1px #474656";
      td.style.background = rowIndex % 2 ? "#20212d" : "#262735";
      if (rowIndex === 0) {
        td.style.background = "#333044";
        td.style.color = "#c1a2ff";
        td.style.fontSize = "23px";
        td.style.fontWeight = "700";
      }
      const content = document.createElement("div");
      // This is a wrapping target. Unbroken words may extend the column beyond it.
      content.style.cssText =
        "width:360px;min-height:32px;white-space:pre-wrap;overflow-wrap:normal;word-break:normal";
      td.append(content);
      for (const run of cell.runs) {
        const span = document.createElement("span");
        span.textContent = run.text;
        if (run.bold) span.style.fontWeight = "700";
        if (run.italic) span.style.fontStyle = "italic";
        span.style.textDecorationLine = [
          run.underline ? "underline" : "",
          run.strike ? "line-through" : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (run.code) {
          span.style.fontFamily = '"Liberation Mono",monospace';
          span.style.background = "#353642";
          span.style.borderRadius = "3px";
        }
        content.append(span);
      }
      return content;
    });
  });
  const widths = (cells[0] ?? []).map((_, column) => {
    let width = 0;
    for (const row of cells) {
      const content = row[column]!;
      const left = content.getBoundingClientRect().left;
      const range = document.createRange();
      range.selectNodeContents(content);
      for (const rect of range.getClientRects()) width = Math.max(width, rect.right - left);
    }
    return Math.ceil(width) + 1;
  });
  element.style.width = `${widths.reduce((sum, width) => sum + width + 12, 0)}px`;
  for (const row of cells) {
    for (const [column, content] of row.entries()) {
      content.style.width = `${widths[column]}px`;
      content.parentElement!.style.width = `${widths[column]}px`;
      content.style.textAlign = table.align[column] ?? "left";
    }
  }
}

async function renderTableOnPage(page: Page, table: MarkdownTableData): Promise<Uint8Array> {
  await page.evaluate(drawTable, table);
  return page.locator("table").screenshot({ type: "png" });
}

export async function renderDiscordTableImages(
  tables: readonly MarkdownTableData[],
): Promise<readonly (Uint8Array | null)[]> {
  if (tables.length === 0) return [];
  const executablePath =
    process.env.LILAC_CHROMIUM_PATH ??
    process.env.CHROMIUM_PATH ??
    Bun.which("chromium") ??
    Bun.which("chromium-browser") ??
    Bun.which("google-chrome") ??
    Bun.which("google-chrome-stable") ??
    undefined;
  const launched = await captureTableRender(() =>
    chromium.launch({ headless: true, executablePath }),
  );
  const browser = launched.match({ ok: (value) => value, err: () => null });
  if (!browser) return tables.map(() => null);

  const render = async (): Promise<readonly (Uint8Array | null)[]> => {
    const opened = await captureTableRender(() => browser.newPage({ deviceScaleFactor: 2 }));
    const page = opened.match({ ok: (value) => value, err: () => null });
    if (!page) return tables.map(() => null);
    const images: (Uint8Array | null)[] = [];
    for (const table of tables) {
      const rendered = await captureTableRender(() => renderTableOnPage(page, table));
      images.push(rendered.match({ ok: (bytes) => bytes, err: () => null }));
    }
    return images;
  };
  return render().finally(async () => {
    await captureTableRender(() => browser.close());
  });
}
