export type FileTarget =
  | { type: "path"; path: string; name: string; line?: number; endLine?: number }
  | {
      type: "resource";
      href: string;
      name: string;
      mediaType: string;
      path?: string;
      line?: number;
      endLine?: number;
      resourceId?: string;
    };

export function parseFilePath(value: string): Extract<FileTarget, { type: "path" }> | undefined {
  if (value.includes("\n") || value.includes("\0")) return;
  const match = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*)|:[1-9]\d*)?)?$/.exec(value.trim());
  const path = match?.[1];
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return;
  if (!/^(?:\/|~\/|\.\.?\/)/.test(path)) return;
  if (path.endsWith("/")) return;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || name === "." || name === "..") return;
  const line = match?.[2] ? Number(match[2]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return;
  const endLine = match?.[3] ? Number(match[3]) : undefined;
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < (line ?? 1))) return;
  return { type: "path", path, name, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
}

export function fileLanguage(name: string): string {
  const base = name.toLowerCase();
  if (/^(?:\.(?:bashrc|zshrc|profile|bash_profile)|.*\.(?:sh|bash|zsh))$/.test(base)) return "bash";
  if (/^dockerfile(?:\..*)?$/.test(base)) return "dockerfile";
  if (/^(?:makefile|gnumakefile)$/.test(base)) return "makefile";
  const ext = base.split(".").at(-1) ?? "text";
  const aliases: Record<string, string> = {
    md: "markdown",
    mdx: "mdx",
    ts: "typescript",
    js: "javascript",
    py: "python",
    yml: "yaml",
    rs: "rust",
    rb: "ruby",
    h: "c",
    hpp: "cpp",
    conf: "ini",
    txt: "text",
  };
  return aliases[ext] ?? ext;
}
