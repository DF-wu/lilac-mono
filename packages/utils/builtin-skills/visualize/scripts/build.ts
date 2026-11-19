// Inlines a page's local scripts, stylesheets, and images as data URLs so the preview is one
// HTML file. Usage: bun build.ts SOURCE.html OUTPUT.html
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [source, output] = Bun.argv.slice(2);
if (!source || !output) {
  console.error("Usage: bun build.ts SOURCE.html OUTPUT.html");
  process.exit(1);
}
const sourceDir = dirname(resolve(source));
const missing: string[] = [];
const unsupportedReferences: string[] = [];
const windows1252 = new TextDecoder("windows-1252");
const sourceHtml = readFileSync(source, "utf8");
let hasBase = false;
new HTMLRewriter()
  .on("base[href]", {
    element() {
      hasBase = true;
    },
  })
  .transform(sourceHtml);
if (hasBase) {
  console.error(
    "Unsupported <base href>: remove it and resolve asset paths relative to the source HTML.",
  );
  process.exit(1);
}

// Remote, data, file, and fragment URLs stay as written. Anything else is a path from the source.
// Scripts and stylesheets get their element's type, so a file without an extension still loads.
function dataUrl(attribute: string | null, type?: string): string | undefined {
  // URL whitespace is stripped before percent decoding, so encoded filename spaces survive.
  const reference =
    attribute === null
      ? ""
      : decodeAttribute(attribute).replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "");
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) return undefined;
  const path = resolve(sourceDir, decodeURIComponent(reference.replace(/[?#].*$/su, "")));
  if (!existsSync(path)) {
    missing.push(reference);
    return undefined;
  }
  const fragment = /#.*$/su.exec(reference)?.[0] ?? "";
  const bytes = readFileSync(path).toString("base64");
  return `data:${type ?? Bun.file(path).type};base64,${bytes}${fragment}`;
}

function decodeAttribute(attribute: string): string {
  return attribute.replace(/&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]*);?/giu, (reference) => {
    if (reference.startsWith("&#")) return decodeNumericReference(reference);
    // Decode one token so Markdown cannot interpret filename punctuation or decode twice.
    const terminated = reference.endsWith(";") ? reference : `${reference};`;
    const decoded = Bun.markdown.render(terminated, { text: (text) => text });
    if (decoded === terminated) return reference;
    if (!reference.endsWith(";")) {
      unsupportedReferences.push(reference);
      return reference;
    }
    return decoded;
  });
}

function decodeNumericReference(reference: string): string {
  const hexadecimal = /^&#x/iu.test(reference);
  const codePoint = Number.parseInt(reference.slice(hexadecimal ? 3 : 2), hexadecimal ? 16 : 10);
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
    return "\ufffd";
  // HTML numeric references use the Windows-1252 mapping for C1 control values.
  if (codePoint >= 0x80 && codePoint <= 0x9f) return windows1252.decode(Uint8Array.of(codePoint));
  return String.fromCodePoint(codePoint);
}

// Replacing only the URL keeps the element's other attributes, such as `defer` and `media`.
const html = new HTMLRewriter()
  .on("script[src]", {
    element(element) {
      const url = dataUrl(element.getAttribute("src"), "text/javascript");
      if (url) element.setAttribute("src", url);
    },
  })
  .on("img[src]", {
    element(element) {
      const url = dataUrl(element.getAttribute("src"));
      if (url) element.setAttribute("src", url);
    },
  })
  .on("link[rel~=stylesheet][href]", {
    element(element) {
      const url = dataUrl(element.getAttribute("href"), "text/css");
      if (url) element.setAttribute("href", url);
    },
  })
  .transform(sourceHtml);

if (unsupportedReferences.length > 0) {
  console.error(
    `Unsupported HTML named character references without semicolons: ${unsupportedReferences.join(", ")}. End named references with ; and write literal ampersands as &amp; or percent-encode the filename.`,
  );
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`Missing local files: ${missing.join(", ")}`);
  process.exit(1);
}
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, html);
console.log(`Wrote ${resolve(output)}`);
