import { useWorkspace } from "../workspace-context";
import { useStore } from "zustand";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configOptions, userOptions, useNativeOnline } from "../queries";
import { AccountProfile } from "./AccountProfile";
import { AgentIdentity } from "./AgentIdentity";
import type { ActorIdentity } from "./ActorAvatar";
import { useEffect, useRef, useState } from "react";
import { LogOut, RefreshCw, Save, UserPlus } from "lucide-react";
import type { NativeRpcOutputs, NativeUser } from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, VirtualList } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./settings.css";
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
  onClose,
  theme,
  onTheme,
  agent,
  viewer,
  onLogout,
}: {
  viewer: NativeUser;
  onLogout: () => Promise<void>;
  onClose: () => void;
  theme: string;
  agent: ActorIdentity;
  onTheme: (value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const { client, preferences } = useWorkspace();
  const animation = useStore(preferences, (state) => state.animation);
  const [tab, setTab] = useState<"account" | "theme" | "core" | "mcp" | "agent" | "users">(
    "account",
  );
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
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const loadConfig = open && online && viewer.role === "owner";
  const coreConfig = useQuery({
    ...configOptions(client, "core"),
    enabled: loadConfig && !editors.core,
  });
  const mcpConfig = useQuery({
    ...configOptions(client, "mcp"),
    enabled: loadConfig && !editors.mcp,
  });
  const config = tab === "mcp" ? mcpConfig : coreConfig;
  useEffect(() => {
    for (const value of [coreConfig.data, mcpConfig.data]) {
      if (!value) continue;
      setEditors((current) =>
        current[value.kind]
          ? current
          : {
              ...current,
              [value.kind]: { document: value, text: value.text, editRevision: 0 },
            },
      );
    }
  }, [coreConfig.data, mcpConfig.data]);
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
    void queries.invalidateQueries({ queryKey: ["config", request.kind] });
    setEditors((current) => completeConfigSave(current, request, saved));
  }
  async function reload() {
    if (!client.rpc) return;
    const result = await attempt(() => client.rpc!.config.reloadMcp({}), setError);
    if (result) setReloads(result);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="settings-dialog">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <Tabs
          className="settings-layout"
          orientation="vertical"
          value={tab}
          onValueChange={(value) => {
            if (
              value === "account" ||
              value === "theme" ||
              value === "core" ||
              value === "mcp" ||
              value === "agent" ||
              value === "users"
            ) {
              setTab(value);
              setError(undefined);
            }
          }}
        >
          <TabsList className="settings-navigation" aria-label="Settings sections">
            <div className="settings-navigation-group">
              <span className="settings-navigation-label" aria-hidden="true">
                Preferences
              </span>
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="theme">Theme</TabsTrigger>
            </div>
            {viewer.role === "owner" ? (
              <div className="settings-navigation-group">
                <span className="settings-navigation-label" aria-hidden="true">
                  Runtime
                </span>
                <TabsTrigger value="core">Core</TabsTrigger>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
                <TabsTrigger value="agent">Agent</TabsTrigger>
                <TabsTrigger value="users">User</TabsTrigger>
              </div>
            ) : null}
          </TabsList>
          <div className="settings-options">
            <ErrorNotice
              message={
                error ?? (tab === "core" || tab === "mcp" ? config.error?.message : undefined)
              }
              onDismiss={error ? () => setError(undefined) : undefined}
            />
            <TabsContent value="account" className="settings-section">
              <h2>Account</h2>
              <AccountProfile viewer={viewer} />
              <dl className="settings-account">
                <div>
                  <dt>Role</dt>
                  <dd>{viewer.role}</dd>
                </div>
                <div>
                  <dt>Tool access</dt>
                  <dd>{viewer.toolMode === "full" ? "Full access" : "Restricted"}</dd>
                </div>
              </dl>
              <Button variant="secondary" onClick={() => void attempt(onLogout, setError)}>
                <LogOut />
                Sign out
              </Button>
            </TabsContent>
            <TabsContent value="agent" className="settings-section">
              <AgentIdentity client={client} identity={agent} />
            </TabsContent>
            <TabsContent value="theme" className="settings-section">
              <h2>Theme</h2>
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
              <label className="field">
                Animation speed
                <Select
                  items={[
                    { value: "off", label: "Off" },
                    { value: "fast", label: "Fast" },
                    { value: "slow", label: "Slow" },
                  ]}
                  value={animation}
                  onValueChange={(value) => {
                    if (value === "off" || value === "fast" || value === "slow")
                      preferences.getState().setAnimation(value);
                  }}
                >
                  <SelectTrigger aria-label="Animation speed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                    <SelectItem value="slow">Slow</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <p className="muted">
                Animation speed is saved for your account on this device. Reduced motion follows
                your system preference.
              </p>
            </TabsContent>
            <TabsContent value="users" className="settings-section">
              <h2>User</h2>
              <People />
            </TabsContent>
            {tab === "core" || tab === "mcp" ? (
              <TabsContent value={tab} className="settings-section settings-config">
                <h2>{tab === "core" ? "Core" : "MCP"}</h2>
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
                {tab === "mcp" && reloads ? (
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
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export function People() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const userQuery = useInfiniteQuery({ ...userOptions(client), enabled: online });
  const users = userQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<"restricted" | "full">("restricted");
  const change = useMutation({
    mutationFn: (
      input:
        | { providerUserId: string; toolMode: "full" | "restricted" }
        | { userId: string; toolMode: "full" | "restricted" },
    ) => {
      const rpc = client.rpc;
      if (!rpc) return Promise.resolve(undefined);
      if ("providerUserId" in input) return rpc.users.add(input);
      return rpc.users.setToolMode(input);
    },
    onSuccess: async (user, input) => {
      if (!user) return;
      if ("providerUserId" in input) setProviderId("");
      await Promise.all([
        queries.invalidateQueries({ queryKey: ["participants"] }),
        queries.invalidateQueries({ queryKey: ["users"] }),
      ]);
    },
  });
  const mutating = change.isPending;
  return (
    <section className="people">
      <ErrorNotice
        message={change.error?.message ?? userQuery.error?.message}
        onDismiss={change.error ? () => change.reset() : undefined}
      />
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
        <IconButton
          label="Add existing user"
          disabled={!online || mutating || !providerId.trim()}
          onClick={() => change.mutate({ providerUserId: providerId.trim(), toolMode: mode })}
        >
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
              disabled={!online || mutating || user.role !== "participant"}
              value={user.toolMode}
              onValueChange={(value) =>
                change.mutate({
                  userId: user.id,
                  toolMode: value === "full" ? "full" : "restricted",
                })
              }
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
      {userQuery.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="text-button"
          disabled={userQuery.isFetching}
          onClick={() => {
            if (!userQuery.isFetching) void userQuery.fetchNextPage({ cancelRefetch: false });
          }}
        >
          Load more people
        </Button>
      ) : null}
    </section>
  );
}
