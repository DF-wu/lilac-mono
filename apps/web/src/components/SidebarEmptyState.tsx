const messages = {
  default: "No conversations yet",
  archived: "No archived conversations",
  others: "No Discord or GitHub conversations",
};

export function SidebarEmptyState({ view }: { view: keyof typeof messages }) {
  return <p className="p-3 text-sm text-muted-foreground">{messages[view]}</p>;
}
