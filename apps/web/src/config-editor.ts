import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
export type ConfigDocument = NativeRpcOutputs["config"]["read"];
export type ConfigKind = ConfigDocument["kind"];
export type ConfigEditor = {
  document: ConfigDocument;
  text: string;
  editRevision: number;
  status?: string;
};
export type ConfigEditors = Partial<Record<ConfigKind, ConfigEditor>>;
export type SaveRequest = { kind: ConfigKind; editRevision: number };

export function editConfig(editors: ConfigEditors, kind: ConfigKind, text: string): ConfigEditors {
  const editor = editors[kind];
  if (!editor) return editors;
  return {
    ...editors,
    [kind]: { ...editor, text, editRevision: editor.editRevision + 1, status: undefined },
  };
}

export function completeConfigSave(
  editors: ConfigEditors,
  request: SaveRequest,
  saved: ConfigDocument,
): ConfigEditors {
  const current = editors[request.kind];
  if (!current || saved.kind !== request.kind) return editors;
  const changedSinceSave = current.editRevision !== request.editRevision;
  return {
    ...editors,
    [request.kind]: {
      ...current,
      document: saved,
      text: changedSinceSave ? current.text : saved.text,
      status: changedSinceSave ? "Earlier changes saved. New edits are unsaved." : "Saved",
    },
  };
}
