import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { ErrorNotice } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type StreamingMode = NativeRpcOutputs["config"]["readStreaming"]["mode"];
const options = [
  { value: "paragraph", label: "Paragraph" },
  { value: "complete", label: "Full" },
];

export function StreamingModeSelect({
  value,
  disabled,
  onChange,
}: {
  value: StreamingMode | null;
  disabled?: boolean;
  onChange: (mode: StreamingMode) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(mode) => {
        if (mode === "paragraph" || mode === "complete") onChange(mode);
      }}
    >
      <SelectTrigger aria-label="Response streaming">
        <SelectValue placeholder="Loading…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StreamingSettings({
  onSaved,
  disabled,
}: {
  onSaved: () => void;
  disabled?: boolean;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const settings = useQuery({
    queryKey: ["config", "streaming"],
    enabled: online,
    queryFn: ({ signal }) => client.rpc!.config.readStreaming({}, { signal }),
    staleTime: 0,
  });
  const update = useMutation({
    mutationFn: (mode: StreamingMode) =>
      client.rpc!.config.setStreaming({ mode, expectedRevision: settings.data!.revision }),
    onMutate: () => queries.cancelQueries({ queryKey: ["config", "streaming"] }),
    onSuccess: (value) => {
      queries.setQueryData(["config", "streaming"], value);
      void queries.invalidateQueries({ queryKey: ["config", "core"] });
      onSaved();
    },
    onError: () => {
      void queries.invalidateQueries({ queryKey: ["config", "streaming"] });
    },
  });
  let status = "";
  if (update.isPending) status = "Saving…";
  else if (update.isSuccess) status = "Saved";
  return (
    <>
      <div className="settings-row flex items-start justify-between gap-6 mb-8">
        <div className="settings-row-description min-w-0">
          <span>Response streaming</span>
          <p className="muted text-muted-foreground">
            Show each paragraph as it finishes, or wait for the full response. Applies to new
            responses for everyone.
          </p>
          <span role="status" className="text-sm text-muted-foreground">
            {status}
          </span>
        </div>
        <StreamingModeSelect
          value={update.isPending ? update.variables : (settings.data?.mode ?? null)}
          disabled={disabled || !online || update.isPending || !settings.data}
          onChange={(mode) => update.mutate(mode)}
        />
      </div>
      <ErrorNotice message={(update.error ?? settings.error)?.message} />
    </>
  );
}
