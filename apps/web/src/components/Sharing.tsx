import { useWorkspace } from "../workspace-context";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { participantOptions, userOptions, useNativeOnline } from "../queries";
import { useState } from "react";
import { X, UserPlus } from "lucide-react";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { ErrorNotice, IconButton, VirtualList } from "./ui";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function Sharing({ thread }: { thread: NativeThread }) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const participantQuery = useQuery({ ...participantOptions(client, thread.id), enabled: online });
  const userQuery = useInfiniteQuery({ ...userOptions(client), enabled: online });
  const participants = participantQuery.data?.items ?? [];
  const users = userQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const participantIds = new Set(participants.map((entry) => entry.user.id));
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"read" | "edit">("read");
  const change = useMutation({
    mutationFn: (input: { userId: string; role?: "read" | "edit" }) => {
      const rpc = client.rpc;
      if (!rpc) return Promise.resolve(undefined);
      if (input.role)
        return rpc.participants.set({
          threadId: thread.id,
          userId: input.userId,
          role: input.role,
        });
      return rpc.participants.remove({ threadId: thread.id, userId: input.userId });
    },
    onSuccess: async (result) => {
      if (!result) return;
      setUserId("");
      await queries.invalidateQueries({ queryKey: ["participants", thread.id] });
    },
  });
  const mutating = change.isPending;
  return (
    <>
      <ErrorNotice
        message={
          change.error?.message ?? participantQuery.error?.message ?? userQuery.error?.message
        }
        onDismiss={change.error ? () => change.reset() : undefined}
      />
      <div className="inline-form flex gap-2 mb-4 items-center">
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
              .filter((user) => user.role === "participant" && !participantIds.has(user.id))
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
          disabled={!userId || !online || mutating}
          onClick={() => change.mutate({ userId, role })}
        >
          <UserPlus />
        </IconButton>
      </div>
      {userQuery.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="text-primary py-2 px-3 text-sm"
          disabled={userQuery.isFetching}
          onClick={() => {
            if (!userQuery.isFetching) void userQuery.fetchNextPage({ cancelRefetch: false });
          }}
        >
          Load more people
        </Button>
      ) : null}
      <VirtualList
        items={participants}
        itemKey={(entry) => entry.user.id}
        label="Conversation participants"
        className="people-list h-80"
        render={(entry) => (
          <div className="person-row flex items-center gap-2 py-2 px-0 text-sm">
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
              disabled={
                !online ||
                mutating ||
                entry.user.id === thread.starterId ||
                entry.user.role === "owner"
              }
              onValueChange={(value) =>
                change.mutate({ userId: entry.user.id, role: value === "edit" ? "edit" : "read" })
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
              disabled={
                !online ||
                mutating ||
                entry.user.id === thread.starterId ||
                entry.user.role === "owner"
              }
              onClick={() => change.mutate({ userId: entry.user.id })}
            >
              <X />
            </IconButton>
          </div>
        )}
      />
    </>
  );
}
