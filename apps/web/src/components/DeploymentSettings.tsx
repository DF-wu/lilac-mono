import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NativeDeploymentSettings,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { useNativeOnline } from "../queries";
import { ErrorNotice } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { StreamingModeSelect } from "./StreamingSettings";

type DeploymentDocument = NativeRpcOutputs["config"]["readDeployment"];

export function DeploymentSettingsForm({
  value,
  disabled,
  pending,
  onSave,
  onEdit,
}: {
  value: NativeDeploymentSettings;
  disabled?: boolean;
  pending?: boolean;
  onSave: (settings: NativeDeploymentSettings) => void;
  onEdit?: () => void;
}) {
  const [titleModel, setTitleModel] = useState(value.titleModel);
  const [streaming, setStreaming] = useState(value.outputStreaming);
  const [selectionAge, setSelectionAge] = useState(
    value.oldMessageSelectionMaxAgeMs?.toString() ?? "",
  );
  const [retentionAge, setRetentionAge] = useState(
    value.storageRetentionMaxAgeMs?.toString() ?? "",
  );
  const triggerRunId = useId();
  const [triggerRun, setTriggerRun] = useState(value.crossThreadSend.triggerRun);
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!titleModel.trim()) return;
        onSave({
          titleModel: titleModel.trim(),
          outputStreaming: streaming,
          oldMessageSelectionMaxAgeMs: selectionAge === "" ? null : Number(selectionAge),
          storageRetentionMaxAgeMs: retentionAge === "" ? null : Number(retentionAge),
          crossThreadSend: { triggerRun },
        });
      }}
    >
      <fieldset disabled={disabled || pending} className="grid min-w-0 gap-6">
        <label className="grid gap-2">
          <span>Title model</span>
          <Input
            required
            value={titleModel}
            onChange={(event) => {
              onEdit?.();
              setTitleModel(event.target.value);
            }}
          />
          <span className="text-sm text-muted-foreground">
            Use fast, main, or a provider/model reference.
          </span>
        </label>
        <div className="settings-row flex items-start justify-between gap-6">
          <div className="min-w-0">
            <span>Response streaming</span>
            <p className="text-sm text-muted-foreground">
              Show completed paragraphs or wait for the full response.
            </p>
          </div>
          <StreamingModeSelect
            value={streaming}
            disabled={disabled || pending}
            onChange={(mode) => {
              onEdit?.();
              setStreaming(mode);
            }}
          />
        </div>
        <label className="grid gap-2">
          <span>Old message selection max age (ms)</span>
          <Input
            type="number"
            min={1}
            step={1}
            placeholder="Unlimited"
            value={selectionAge}
            onChange={(event) => {
              onEdit?.();
              setSelectionAge(event.target.value);
            }}
          />
          <span className="text-sm text-muted-foreground">Leave blank for no age limit.</span>
        </label>
        <label className="grid gap-2">
          <span>Storage retention max age (ms)</span>
          <Input
            type="number"
            min={1}
            step={1}
            placeholder="Unlimited"
            value={retentionAge}
            onChange={(event) => {
              onEdit?.();
              setRetentionAge(event.target.value);
            }}
          />
          <span className="text-sm text-muted-foreground">
            Inactive threads older than this limit are deleted. Leave blank to keep them.
          </span>
        </label>
        <div className="flex items-center justify-between gap-6">
          <label htmlFor={triggerRunId}>Start a run for cross-thread messages</label>
          <Switch
            id={triggerRunId}
            checked={triggerRun}
            disabled={disabled || pending}
            onCheckedChange={(checked) => {
              onEdit?.();
              setTriggerRun(checked);
            }}
          />
        </div>
        <Button type="submit" className="justify-self-start">
          {pending ? "Saving…" : "Save"}
        </Button>
      </fieldset>
    </form>
  );
}

function DeploymentEditor({ initial, online }: { initial: DeploymentDocument; online: boolean }) {
  const { client } = useWorkspace();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<DeploymentDocument>();
  const document = draft ?? initial;
  const [formVersion, setFormVersion] = useState(0);
  const update = useMutation({
    mutationFn: (settings: NativeDeploymentSettings) =>
      client.rpc!.config.setDeployment({ settings, expectedRevision: document.revision }),
    onMutate: () => queries.cancelQueries({ queryKey: ["config", "deployment"] }),
    onSuccess: (value) => {
      setDraft(undefined);
      queries.setQueryData(["config", "deployment"], value);
    },
  });
  const reload = useMutation({
    mutationFn: () => client.rpc!.config.readDeployment({}),
    onSuccess: (value) => {
      setDraft(undefined);
      setFormVersion((version) => version + 1);
      update.reset();
      queries.setQueryData(["config", "deployment"], value);
    },
  });
  return (
    <>
      <DeploymentSettingsForm
        key={`${formVersion}:${document.revision}`}
        value={document.settings}
        disabled={!online || reload.isPending}
        pending={update.isPending}
        onSave={(settings) => update.mutate(settings)}
        onEdit={() => {
          setDraft(document);
          if (update.isSuccess) update.reset();
        }}
      />
      <span role="status" className="text-sm text-muted-foreground">
        {update.isSuccess ? "Saved" : ""}
      </span>
      <ErrorNotice message={(update.error ?? reload.error)?.message} />
      {update.isError ? (
        <Button
          variant="outline"
          disabled={!online || reload.isPending}
          onClick={() => reload.mutate()}
        >
          Reload settings
        </Button>
      ) : null}
    </>
  );
}

export function DeploymentSettings() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const settings = useQuery({
    queryKey: ["config", "deployment"],
    enabled: online,
    queryFn: ({ signal }) => client.rpc!.config.readDeployment({}, { signal }),
    staleTime: 0,
  });
  if (!settings.data)
    return <ErrorNotice message={settings.error?.message ?? (online ? "Loading…" : "Offline")} />;
  return <DeploymentEditor initial={settings.data} online={online} />;
}
