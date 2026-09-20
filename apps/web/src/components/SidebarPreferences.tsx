import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SidebarPreferences as Preferences } from "@stanley2058/lilac-client-protocol";
import { refreshSidebar } from "../sidebar-queries";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ErrorNotice } from "./ui";
const intervals = [
  { value: 1, label: "1 day" },
  { value: 3, label: "3 days" },
  { value: 5, label: "5 days" },
  { value: 7, label: "1 week" },
  { value: 30, label: "1 month" },
] satisfies { value: Preferences["autoSettleDays"]; label: string }[];
export function SidebarPreferences() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const preferences = useQuery({
    queryKey: ["sidebar-preferences"],
    enabled: online,
    queryFn: ({ signal }) => client.rpc!.sidebar.preferences({}, { signal }),
  });
  const update = useMutation({
    mutationFn: (value: Preferences) => client.rpc!.sidebar.configure(value),
    onMutate: () => queries.cancelQueries({ queryKey: ["sidebar-preferences"] }),
    onSuccess: (value) => {
      queries.setQueryData(["sidebar-preferences"], value);
      void refreshSidebar(queries);
    },
  });
  const current = update.isPending
    ? update.variables.autoSettleDays
    : (preferences.data?.autoSettleDays ?? 3);
  return (
    <>
      <label className="field">
        Auto-settle inactive conversations
        <Select
          items={intervals}
          value={current}
          disabled={!online || update.isPending || !preferences.data}
          onValueChange={(value) => {
            const selected = intervals.find((option) => option.value === value);
            if (selected) update.mutate({ autoSettleDays: selected.value });
          }}
        >
          <SelectTrigger aria-label="Auto-settle inactive conversations">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intervals.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="muted">
        Pinned conversations stay pinned. New activity moves settled conversations back to Active.
        Saved to your account across devices.
      </p>
      <ErrorNotice message={(update.error ?? preferences.error)?.message} />
    </>
  );
}
