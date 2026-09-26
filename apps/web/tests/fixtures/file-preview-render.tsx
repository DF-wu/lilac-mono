import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreviewBody } from "../../src/components/ResourcePreview";

const preview = (
  <AttachmentPreviewBody
    name="source.ts"
    href="/api/resources/id"
    kind="text"
    text={{ status: "ready", text: "<script>untrusted</script>", truncated: true }}
  />
);
const cold = renderToStaticMarkup(preview);
const stream = await renderToReadableStream(preview);
await stream.allReady;
await stream.cancel();
const warm = renderToStaticMarkup(preview);
console.log(JSON.stringify({ cold, warm }));
