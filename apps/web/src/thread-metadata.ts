export const defaultAutoSettleDays = 3;

export type ThreadAge = "fresh" | "recent" | "aging" | "settling";

export function threadAge(updatedAt: number, now: number, settleDays: number): ThreadAge {
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 3_600_000) return "fresh";
  const progress = elapsed / (settleDays * 86_400_000);
  if (progress < 1 / 3) return "recent";
  if (progress < 2 / 3) return "aging";
  return "settling";
}

export function relativeThreadTime(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(updatedAt);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}
