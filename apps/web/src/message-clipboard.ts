import type { DisplayPart } from "@stanley2058/lilac-client-protocol";

export type ClipboardResource = { resourceId: string; name: string; mediaType: string };
export type MessageClipboard = { text: string; resources: ClipboardResource[] };

export function messageClipboard(text: string, parts: readonly DisplayPart[]): MessageClipboard {
  const resources = new Map<string, ClipboardResource>();
  for (const part of parts) {
    if (part.type !== "data-resource") continue;
    resources.set(part.data.resourceId, {
      resourceId: part.data.resourceId,
      name: part.data.name ?? "Attachment",
      mediaType: part.data.mediaType ?? "application/octet-stream",
    });
  }
  return { text, resources: [...resources.values()] };
}

export async function copyMessage(value: MessageClipboard) {
  if (!value.resources.length) return navigator.clipboard.writeText(value.text);
  const container = document.createElement("div");
  container.dataset.lilacMessage = location.origin;
  const text = document.createElement("pre");
  text.textContent = value.text;
  container.append(text);
  for (const resource of value.resources) {
    const item = document.createElement("span");
    item.dataset.resourceId = resource.resourceId;
    item.dataset.mediaType = resource.mediaType;
    item.textContent = resource.name;
    container.append(item);
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([value.text || value.resources.map((item) => item.name).join("\n")], {
        type: "text/plain",
      }),
      "text/html": new Blob([container.outerHTML], { type: "text/html" }),
    }),
  ]);
}

export function readMessageClipboard(html: string): MessageClipboard | undefined {
  if (!html.includes("data-lilac-message")) return;
  const document = new DOMParser().parseFromString(html, "text/html");
  const container = document.querySelector<HTMLElement>("[data-lilac-message]");
  if (container?.dataset.lilacMessage !== location.origin) return;
  const resources: ClipboardResource[] = [];
  for (const item of container.querySelectorAll<HTMLElement>("[data-resource-id]")) {
    const resourceId = item.dataset.resourceId;
    if (!resourceId) return;
    resources.push({
      resourceId,
      name: item.textContent ?? "Attachment",
      mediaType: item.dataset.mediaType ?? "application/octet-stream",
    });
  }
  if (!resources.length || resources.length > 32) return;
  return { text: container.querySelector("pre")?.textContent ?? "", resources };
}
