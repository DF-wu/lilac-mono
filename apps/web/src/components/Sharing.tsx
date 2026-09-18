import { useEffect, useState } from "react";
import { X, UserPlus } from "lucide-react";
import type { NativeClient } from "@stanley2058/lilac-client";
import type {
  NativeRpcOutputs,
  NativeThread,
  NativeUser,
} from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, Modal, VirtualList } from "./ui";

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
        <select
          aria-label="Person to add"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">Choose a person</option>
          {users
            .filter(
              (user) =>
                user.role === "participant" &&
                !participants.some((entry) => entry.user.id === user.id),
            )
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
        </select>
        <select
          aria-label="Access to conversation"
          value={role}
          onChange={(event) => setRole(event.target.value === "edit" ? "edit" : "read")}
        >
          <option value="read">Can read</option>
          <option value="edit">Can edit</option>
        </select>
        <IconButton
          label="Share with selected person"
          disabled={!userId}
          onClick={() => void grant(userId, role)}
        >
          <UserPlus />
        </IconButton>
      </div>
      {nextCursor ? (
        <button type="button" className="text-button" onClick={() => void loadUsers(nextCursor)}>
          Load more people
        </button>
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
            <select
              aria-label={`Access for ${entry.user.displayName}`}
              value={entry.role}
              disabled={entry.user.id === thread.starterId || entry.user.role === "owner"}
              onChange={(event) =>
                void grant(entry.user.id, event.target.value === "edit" ? "edit" : "read")
              }
            >
              <option value="read">Can read</option>
              <option value="edit" disabled={entry.user.toolMode === "restricted"}>
                Can edit
              </option>
            </select>
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
