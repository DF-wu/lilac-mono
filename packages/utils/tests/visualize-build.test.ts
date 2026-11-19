import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../builtin-skills/visualize/scripts/build.ts");

describe("visualize build URL handling", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lilac-visualize-urls-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function build(html: string) {
    await writeFile(join(directory, "page.html"), html);
    const result = Bun.spawnSync(["bun", script, "page.html", "out.html"], {
      cwd: directory,
      stderr: "pipe",
    });
    return { ...result, exists: await Bun.file(join(directory, "out.html")).exists() };
  }

  test("trims surrounding URL whitespace before decoding percent-encoded filename spaces", async () => {
    await writeFile(join(directory, " app "), "console.log('encoded spaces')");
    await writeFile(join(directory, "style.css"), "p{color:red}");
    const result = await build(
      '<script src=" \t%20app%20\n "></script><link rel="stylesheet" href=" style.css ">',
    );
    expect(result.exitCode).toBe(0);
    const html = await readFile(join(directory, "out.html"), "utf8");
    expect(html).toContain(
      `data:text/javascript;base64,${Buffer.from("console.log('encoded spaces')").toString("base64")}`,
    );
    expect(html).toContain(
      `data:text/css;base64,${Buffer.from("p{color:red}").toString("base64")}`,
    );
  });

  test("decodes HTML attribute character references before URL splitting and percent decoding", async () => {
    const names = [
      "a&b.png",
      " chart .png",
      "chart.png",
      "a©.png",
      "a&copyx.png",
      "€.png",
      "\u0081.png",
      "≂̸.png",
      "a .png",
    ];
    for (const name of names) await writeFile(join(directory, name), "image");
    const result = await build(
      [
        '<img src="a&amp;b.png">',
        '<img src="&#37;20chart&#37;20.png">',
        '<img src="chart.png&#63;v=1&#35;view">',
        '<img src="a&copy;.png">',
        '<img src="a&copyx.png">',
        '<img src="&#x80;.png">',
        '<img src="&#129;.png">',
        '<img src="&NotEqualTilde;.png">',
        '<img src="a&#32.png">',
      ].join(""),
    );
    expect(result.exitCode).toBe(0);
    const html = await readFile(join(directory, "out.html"), "utf8");
    expect(html.match(/data:image\/png;base64,aW1hZ2U=/gu)).toHaveLength(names.length);
    expect(html).toContain("aW1hZ2U=#view");
  });

  test("decodes character references once before interpreting the URL fragment", async () => {
    await writeFile(join(directory, "amp&"), "single pass");
    const result = await build('<script src="amp&amp;#32;"></script>');
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(directory, "out.html"), "utf8")).toBe(
      `<script src="data:text/javascript;base64,${Buffer.from("single pass").toString("base64")}#32;"></script>`,
    );
  });

  test.each(["a&copy.png", "a&copy=x.png"])(
    "rejects unterminated character reference in %s with encoding instructions",
    async (reference) => {
      const result = await build(`<img src="${reference}">`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("without semicolons");
      expect(result.stderr.toString()).toContain("&amp;");
      expect(result.exists).toBe(false);
    },
  );

  test.each([
    ["&#00000032;", "app"],
    ["&#99999999999999999999999999;", "�app"],
    ["&#x0000020;", "app"],
    ["&#xD800;", "�app"],
    ["&#1114112;", "�app"],
    ["&#0;", "�app"],
    ["&#x000000000000080;", "€app"],
  ] satisfies [string, string][])(
    "decodes numeric reference %s using HTML codepoint rules",
    async (reference, filename) => {
      await writeFile(join(directory, filename), "expected script");
      const result = await build(`<script src="${reference}app"></script>`);
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(directory, "out.html"), "utf8")).toBe(
        `<script src="data:text/javascript;base64,${Buffer.from("expected script").toString("base64")}"></script>`,
      );
    },
  );

  test.each(["<base href=assets/>", '<base href="https://example.com/">', '<base href="">'])(
    "rejects %s before reading local resources or writing output",
    async (base) => {
      const result = await build(`<img src="missing.png">${base}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("<base href>");
      expect(result.stderr.toString()).not.toContain("Missing local files");
      expect(result.exists).toBe(false);
    },
  );
});
