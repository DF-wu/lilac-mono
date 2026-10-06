import type { UserContent } from "ai";
import type { CustomCommandResult } from "@stanley2058/lilac-utils/custom-commands";

export function customCommandUserContent(
  output: CustomCommandResult,
  provider: string,
): Exclude<UserContent, string> {
  if (output.type !== "content") {
    return [{ type: "text", text: JSON.stringify(output) }];
  }
  return output.value.map((part) => ({
    ...commandContentPart(part, provider),
    ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
  }));
}

function commandContentPart(
  part: Extract<CustomCommandResult, { type: "content" }>["value"][number],
  provider: string,
): Exclude<UserContent, string>[number] {
  switch (part.type) {
    case "text":
    case "file":
      return part;
    case "image-data":
      return { type: "file", mediaType: part.mediaType, data: { type: "data", data: part.data } };
    case "file-data":
      return {
        type: "file",
        filename: part.filename,
        mediaType: part.mediaType,
        data: { type: "data", data: part.data },
      };
    case "image-url":
      return { type: "file", mediaType: "image", data: { type: "url", url: new URL(part.url) } };
    case "file-url":
      return {
        type: "file",
        mediaType: part.mediaType ?? "application/octet-stream",
        data: { type: "url", url: new URL(part.url) },
      };
    case "image-file-id":
      return {
        type: "file",
        mediaType: "image",
        data: {
          type: "reference",
          reference: typeof part.fileId === "string" ? { [provider]: part.fileId } : part.fileId,
        },
      };
    case "file-id":
      return {
        type: "file",
        mediaType: "application/octet-stream",
        data: {
          type: "reference",
          reference: typeof part.fileId === "string" ? { [provider]: part.fileId } : part.fileId,
        },
      };
    case "image-file-reference":
      return {
        type: "file",
        mediaType: "image",
        data: { type: "reference", reference: part.providerReference },
      };
    case "file-reference":
      return {
        type: "file",
        mediaType: "application/octet-stream",
        data: { type: "reference", reference: part.providerReference },
      };
    case "custom":
      return { type: "text", text: JSON.stringify(part) };
  }
}
