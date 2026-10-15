const imageExtensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export function namePastedImage(file: File): File {
  if (file.name || !file.type.startsWith("image/")) return file;
  const extension = imageExtensions[file.type];
  return new File([file], extension ? `pasted-image.${extension}` : "pasted-image", {
    type: file.type,
    lastModified: file.lastModified,
  });
}
