import associations from "./assets/file-icons/associations.json";

const filenames = new Map(Object.entries(associations.fileNames));
const extensions = new Map(Object.entries(associations.fileExtensions));
const languages = new Map(Object.entries(associations.languageIds));
const shellProfiles = new Set([".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"]);

export function fileIconName(name: string, mediaType = ""): string {
  const basename = name.split(/[\\/]/).at(-1) ?? name;
  const lower = basename.toLowerCase();
  const exact = filenames.get(basename) ?? filenames.get(lower);
  if (exact) return exact;
  if (shellProfiles.has(lower)) return "bash";
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const extension = lower.slice(dot + 1);
    const icon = extensions.get(extension) ?? languages.get(extension);
    if (icon) return icon;
  }
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/pdf") return "pdf";
  return "_file";
}
