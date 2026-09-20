import { createContext, useContext } from "react";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";

export const SubagentContext = createContext<{
  agents: ReadonlyMap<string, SubagentSummary>;
  open: (id: string) => void;
}>({ agents: new Map(), open: () => {} });
export const useSubagents = () => useContext(SubagentContext);
export const subagentProfileName = (profile: SubagentSummary["profile"]) =>
  ({ explore: "Explore Agent", general: "General Agent", self: "Self Agent" })[profile];
