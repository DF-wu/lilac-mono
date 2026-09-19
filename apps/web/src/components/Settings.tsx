import { AgentIdentity } from "./AgentIdentity";
import type { ActorIdentity } from "./ActorAvatar";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Save, UserPlus } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcOutputs, NativeUser } from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

import {
  completeConfigSave,
  editConfig,
  type ConfigEditors,
  type ConfigKind,
} from "../config-editor";
export function Settings({
  client,
  onClose,
  theme,
  onTheme,
  agent,
}: {
  client: NativeClient;
  onClose: () => void;
  theme: string;
  agent: ActorIdentity;
  onTheme: (value: string) => void;
}) {
  const [tab, setTab] = useState<"core" | "mcp" | "users" | "appearance">("core");
  const [editors, setEditors] = useState<ConfigEditors>({});
  const [error, setError] = useState<string>();
  const [reloads, setReloads] = useState<NativeRpcOutputs["config"]["reloadMcp"]>();
  const [saving, setSaving] = useState<Partial<Record<ConfigKind, boolean>>>({});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const saveRequests = useRef({ core: 0, mcp: 0 });
  const savingKinds = useRef(new Set<ConfigKind>());
  const editor = tab === "core" || tab === "mcp" ? editors[tab] : undefined;
  const document = editor?.document;
  const text = editor?.text ?? "";
  const status = editor?.status ?? "";
  useEffect(() => {
    if (tab !== "core" && tab !== "mcp") return;
    const rpc = client.rpc;
    if (!rpc || editors[tab]) return;
    let canceled = false;
    setError(undefined);
    void attempt(
      () => rpc.config.read({ kind: tab }),
      (message) => {
        if (tabRef.current === tab) setError(message);
      },
    ).then((value) => {
      if (!value || canceled) return;
      setEditors((current) =>
        current[tab]
          ? current
          : { ...current, [tab]: { document: value, text: value.text, editRevision: 0 } },
      );
    });
    return () => {
      canceled = true;
    };
  }, [client, tab]);
  async function save() {
    const rpc = client.rpc;
    if (!rpc || !document || !editor || savingKinds.current.has(document.kind)) return;
    savingKinds.current.add(document.kind);
    const request = { kind: document.kind, editRevision: editor.editRevision };
    const sequence = ++saveRequests.current[request.kind];
    setSaving((current) => ({ ...current, [request.kind]: true }));
    setError(undefined);
    const saved = await attempt(
      () => rpc.config.save({ kind: request.kind, expectedRevision: document.revision, text }),
      (message) => {
        if (tabRef.current === request.kind) setError(message);
      },
    );
    if (saveRequests.current[request.kind] !== sequence) return;
    savingKinds.current.delete(request.kind);
    setSaving((current) => ({ ...current, [request.kind]: false }));
    if (!saved) return;
    setEditors((current) => completeConfigSave(current, request, saved));
  }
  async function reload() {
    if (!client.rpc) return;
    const result = await attempt(() => client.rpc!.config.reloadMcp({}), setError);
    if (result) setReloads(result);
  }
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <Tabs
        className="flex-col"
        value={tab}
        onValueChange={(value) => {
          if (value === "core" || value === "mcp" || value === "users" || value === "appearance")
            setTab(value);
        }}
      >
        <TabsList aria-label="Settings sections">
          {(["core", "mcp", "users", "appearance"] as const).map((key) => (
            <TabsTrigger key={key} value={key}>
              {{ core: "Core", mcp: "MCP", users: "People", appearance: "Appearance" }[key]}
            </TabsTrigger>
          ))}
        </TabsList>
        <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
        <TabsContent value="appearance">
          <AgentIdentity client={client} identity={agent} />
          <label className="field">
            Theme
            <Select
              items={[
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
              value={theme}
              onValueChange={(value) => {
                if (value) onTheme(value);
              }}
            >
              <SelectTrigger aria-label="Theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </TabsContent>
        <TabsContent value="users">
          <People client={client} />
        </TabsContent>
        {tab === "core" || tab === "mcp" ? (
          <TabsContent value={tab}>
            <Textarea
              className="config-editor"
              spellCheck={false}
              aria-label={`${tab === "core" ? "Core" : "MCP"} configuration YAML`}
              value={document ? text : ""}
              disabled={!document}
              onChange={(event) => {
                setEditors((current) => editConfig(current, tab, event.target.value));
              }}
            />
            <footer className="config-footer">
              <span role="status">
                {status}
                {tab === "mcp" && status === "Saved" ? ". Reload to apply changes." : ""}
              </span>
              <span className="toolbar-spacer" />
              {tab === "mcp" ? (
                <Button variant="secondary" className="button" onClick={() => void reload()}>
                  <RefreshCw />
                  Reload MCP
                </Button>
              ) : null}
              <Button
                className="button primary"
                disabled={!document || !!saving[document.kind] || text === document.text}
                onClick={() => void save()}
              >
                <Save />
                Save
              </Button>
            </footer>
            {reloads ? (
              <div className="reload-results">
                {reloads.servers.map((server) => (
                  <div key={server.name}>
                    <strong>{server.name}</strong>
                    <span>{server.state}</span>
                    {server.error ? <p className="error-text">{server.error}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </TabsContent>
        ) : null}
      </Tabs>
    </Modal>
  );
}

export function People({ client }: { client: NativeClient }) {
  const [users, setUsers] = useState<NativeUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"restricted" | "full">("restricted");
  async function load(cursor?: string) {
    if (!client.rpc) return;
    const result = await attempt(() => client.rpc!.users.list({ limit: 100, cursor }), setError);
    if (result) {
      setUsers((current) => (cursor ? [...current, ...result.items] : result.items));
      setNextCursor(result.nextCursor);
    }
  }
  useEffect(() => {
    void load();
  }, [client]);
  async function add() {
    if (!client.rpc || !providerId.trim()) return;
    const user = await attempt(
      () => client.rpc!.users.add({ providerUserId: providerId.trim(), toolMode: mode }),
      setError,
    );
    if (user) {
      setUsers((current) => [...current.filter((item) => item.id !== user.id), user]);
      setProviderId("");
    }
  }
  return (
    <section className="people">
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <div className="inline-form">
        <Input
          aria-label="Existing Clerk user ID"
          placeholder="Clerk user ID"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        />
        <Select
          items={[
            { value: "restricted", label: "Restricted" },
            { value: "full", label: "Full access" },
          ]}
          value={mode}
          onValueChange={(value) => setMode(value === "full" ? "full" : "restricted")}
        >
          <SelectTrigger aria-label="Tool access for added user">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="restricted">Restricted</SelectItem>
            <SelectItem value="full">Full access</SelectItem>
          </SelectContent>
        </Select>
        <IconButton label="Add existing user" onClick={() => void add()}>
          <UserPlus />
        </IconButton>
      </div>
      <VirtualList
        items={users}
        itemKey={(user) => user.id}
        label="People"
        className="people-list"
        render={(user) => (
          <div className="person-row">
            <span>{user.displayName}</span>
            <small>{user.role}</small>
            <Select
              items={[
                { value: "restricted", label: "Restricted" },
                { value: "full", label: "Full access" },
              ]}
              disabled={user.role !== "participant"}
              value={user.toolMode}
              onValueChange={(value) => {
                const toolMode = value === "full" ? "full" : "restricted";
                if (!client.rpc) return;
                void attempt(
                  () => client.rpc!.users.setToolMode({ userId: user.id, toolMode }),
                  setError,
                ).then((updated) => {
                  if (updated)
                    setUsers((current) =>
                      current.map((item) => (item.id === updated.id ? updated : item)),
                    );
                });
              }}
            >
              <SelectTrigger aria-label={`Tool access for ${user.displayName}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="restricted">Restricted</SelectItem>
                <SelectItem value="full">Full access</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      />
      {nextCursor ? (
        <Button
          type="button"
          variant="ghost"
          className="text-button"
          onClick={() => void load(nextCursor)}
        >
          Load more people
        </Button>
      ) : null}
    </section>
  );
}
