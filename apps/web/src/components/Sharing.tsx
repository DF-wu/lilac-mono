import { useEffect, useState } from "react";
import { X, UserPlus } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type {
  NativeRpcOutputs,
  NativeThread,
  NativeUser,
} from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./ui";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Participant = NativeRpcOutputs["participants"]["list"]["items"][number];
export function Sharing({
  client,
  thread,
  onClose,
}: {
  client: NativeClient;
  thread: NativeThread;
  onClose: () => void;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [users, setUsers] = useState<NativeUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"read" | "edit">("read");
  const [error, setError] = useState<string>();
  async function loadUsers(cursor?: string) {
    if (!client.rpc) return;
    const page = await attempt(() => client.rpc!.users.list({ limit: 100, cursor }), setError);
    if (page) {
      setUsers((items) => (cursor ? [...items, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    }
  }
  async function refresh() {
    if (!client.rpc) return;
    const result = await attempt(
      () => client.rpc!.participants.list({ threadId: thread.id }),
      setError,
    );
    if (result) setParticipants(result.items);
  }
  useEffect(() => {
    void refresh();
    void loadUsers();
  }, [client, thread.id]);
  async function grant(id: string, value: "read" | "edit") {
    if (!client.rpc || !id) return;
    const result = await attempt(
      () => client.rpc!.participants.set({ threadId: thread.id, userId: id, role: value }),
      setError,
    );
    if (result) {
      setUserId("");
      await refresh();
    }
  }
  return (
    <Modal title="Share conversation" onClose={onClose}>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <div className="inline-form">
        <Select
          items={users.map((user) => ({ value: user.id, label: user.displayName }))}
          value={userId || null}
          onValueChange={(value) => setUserId(value ?? "")}
        >
          <SelectTrigger className="grow min-w-0" aria-label="Person to add">
            <SelectValue placeholder="Choose a person" />
          </SelectTrigger>
          <SelectContent>
            {users
              .filter(
                (user) =>
                  user.role === "participant" &&
                  !participants.some((entry) => entry.user.id === user.id),
              )
              .map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.displayName}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          items={[
            { value: "read", label: "Can read" },
            { value: "edit", label: "Can edit" },
          ]}
          value={role}
          onValueChange={(value) => setRole(value === "edit" ? "edit" : "read")}
        >
          <SelectTrigger aria-label="Access to conversation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">Can read</SelectItem>
            <SelectItem value="edit">Can edit</SelectItem>
          </SelectContent>
        </Select>
        <IconButton
          label="Share with selected person"
          disabled={!userId}
          onClick={() => void grant(userId, role)}
        >
          <UserPlus />
        </IconButton>
      </div>
      {nextCursor ? (
        <Button
          type="button"
          variant="ghost"
          className="text-button"
          onClick={() => void loadUsers(nextCursor)}
        >
          Load more people
        </Button>
      ) : null}
      <VirtualList
        items={participants}
        itemKey={(entry) => entry.user.id}
        label="Conversation participants"
        className="people-list"
        render={(entry) => (
          <div className="person-row">
            <span>{entry.user.displayName}</span>
            {entry.user.toolMode === "restricted" ? (
              <small>
                {entry.user.id === thread.starterId ? "Restricted" : "Restricted · read-only"}
              </small>
            ) : null}
            <Select
              items={[
                { value: "read", label: "Can read" },
                { value: "edit", label: "Can edit" },
              ]}
              value={entry.role}
              disabled={entry.user.id === thread.starterId || entry.user.role === "owner"}
              onValueChange={(value) =>
                void grant(entry.user.id, value === "edit" ? "edit" : "read")
              }
            >
              <SelectTrigger aria-label={`Access for ${entry.user.displayName}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Can read</SelectItem>
                <SelectItem value="edit" disabled={entry.user.toolMode === "restricted"}>
                  Can edit
                </SelectItem>
              </SelectContent>
            </Select>
            <IconButton
              label={`Remove ${entry.user.displayName}`}
              disabled={entry.user.id === thread.starterId || entry.user.role === "owner"}
              onClick={() => {
                if (!client.rpc) return;
                void attempt(
                  () =>
                    client.rpc!.participants.remove({ threadId: thread.id, userId: entry.user.id }),
                  setError,
                ).then(refresh);
              }}
            >
              <X />
            </IconButton>
          </div>
        )}
      />
    </Modal>
  );
}
