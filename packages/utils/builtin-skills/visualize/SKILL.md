---
name: visualize
description: Visualize inside a native web reply with an inline HTML page. Load when a chart, diagram, table, or mockup would say more than prose, or before writing an `html-preview-file` fence.
surfaces: [native]
---

# Visualize

A fenced block whose language is `html-preview-file` and whose only content is a file path shows that HTML file inline in your reply:

````markdown
```html-preview-file
/absolute/path/weekly-runs.html
```
````

Lilac saves a copy of the page when your response ends, so the reader sees the page exactly as it was then.

## Steps

1. **Write one self-contained HTML file** following [Page rules](#page-rules). Done when the file exists at an absolute path on the Core host and every local asset it names exists.
2. **Check it in a browser.** Open the file with agent-browser (or any headless browser) at about 800px wide, take a screenshot, and read the console. Fix and repeat until the screenshot shows the intended content with nothing clipped or overflowing, and the console has no errors.
3. **Reference it** with the fence above, at the point in the reply where the page belongs. A reply saves at most 8 pages.
4. **Write the surrounding text** so it adds only what the page does not show: the conclusion, a caveat, the next step. The reader already sees the page.

## Page rules

- **Self-contained.** Put CSS in `<style>` and scripts in `<script>`. Remote `https://` URLs, such as a CDN chart library, load as they are. Lilac inlines local images, fonts, and stylesheets referenced by relative path, absolute path, or `file://` URL, and `resource://r1_...` URIs. A missing local asset makes the whole preview fail.
- **Part of the reply.** The page sits inside the reply on a transparent background, as wide as the reply column (about 800px on desktop, narrower on phones), and grows to fit its content. Leave `html` and `body` without a background, use a fluid width with no outer padding, and let the reply carry the title.
- **Stable height.** Give charts a fixed pixel height on their container, and let content set the page height; viewport units such as `100vh` make the frame keep growing.
- **Links** to `http(s)` pages open in a new browser tab.

## Theme

Lilac sets these CSS variables on `:root` and updates them live when the user changes theme or light/dark mode:

`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--success`, `--warning`, `--info`, `--border`, `--input`, `--ring`, `--link`, `--chart-1` to `--chart-5`, `--radius`, `--font-sans`, `--font-mono`.

The variables exist only inside Lilac, so give each use a fallback that matches a dark theme, which keeps the browser check in step 2 readable: `color: var(--muted-foreground, #a1a1aa)`.

Canvas chart libraries read colors once, from JavaScript. Read the variables with `getComputedStyle` and repaint when Lilac rewrites its theme `<style id="lilac-theme">`:

```js
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
function paint() {
  chart.data.datasets[0].backgroundColor = css("--chart-1", "#a78bfa");
  chart.options.scales.y.grid.color = css("--border", "#3f3f46");
  chart.update();
}
paint();
const theme = document.getElementById("lilac-theme");
if (theme) new MutationObserver(paint).observe(theme, { childList: true, characterData: true, subtree: true });
```
