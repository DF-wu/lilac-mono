import { isRecord } from "../runtime-utils";

import type { CoreConfigKeyPath } from "./types";

function aliasedTargetKey(path: CoreConfigKeyPath, sourceKey: string): string | undefined {
  if (path.length === 2 && path[0] === "tools" && path[1] === "web" && sourceKey === "search") {
    return "extract";
  }

  if (
    path.length === 3 &&
    path[0] === "tools" &&
    path[1] === "web" &&
    (path[2] === "extract" || path[2] === "search") &&
    sourceKey === "provider"
  ) {
    return "providers";
  }

  return undefined;
}

export function collectUnknownConfigKeyPaths(
  source: unknown,
  target: unknown,
): CoreConfigKeyPath[] {
  const unknownPaths: CoreConfigKeyPath[] = [];
  const collectInto = (
    sourceValue: unknown,
    targetValue: unknown,
    path: CoreConfigKeyPath,
  ): void => {
    if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      const commonLength = Math.min(sourceValue.length, targetValue.length);
      for (let index = 0; index < commonLength; index += 1) {
        collectInto(sourceValue[index], targetValue[index], [...path, index]);
      }
      return;
    }

    if (!isRecord(sourceValue) || !isRecord(targetValue)) return;

    for (const sourceKey of Object.keys(sourceValue)) {
      const targetKey = Object.hasOwn(targetValue, sourceKey)
        ? sourceKey
        : aliasedTargetKey(path, sourceKey);
      const sourcePath = [...path, sourceKey];

      if (targetKey === undefined || !Object.hasOwn(targetValue, targetKey)) {
        unknownPaths.push(sourcePath);
        continue;
      }

      collectInto(sourceValue[sourceKey], targetValue[targetKey], sourcePath);
    }
  };

  collectInto(source, target, []);
  return unknownPaths;
}

export function formatCoreConfigKeyPath(path: CoreConfigKeyPath): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      formatted += formatted.length === 0 ? segment : `.${segment}`;
      continue;
    }

    formatted += `[${JSON.stringify(segment)}]`;
  }
  return formatted;
}
