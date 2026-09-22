import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export type ActorIdentity = { displayName: string; avatarUrl?: string };

export function initials(name: string): string {
  return (
    name
      .replace(/\s+\([^)]*\)\s*$/u, "")
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toLocaleUpperCase() || "?"
  );
}

export function ActorAvatar({
  displayName,
  avatarUrl,
  size = "default",
}: ActorIdentity & { size?: "default" | "sm" | "lg" }) {
  return (
    <Avatar size={size} role="img" aria-label={displayName}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback>{initials(displayName)}</AvatarFallback>
    </Avatar>
  );
}
