import { Link, useLocation } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import logo from "./assets/logo.svg";
import motion from "./assets/design-system/motion.mp4";
import tone from "./assets/design-system/tone.wav";
import weekendPdf from "./assets/design-system/weekend.pdf";
import type { Attachment } from "./types";
import { AttachmentPreviewBody, ReadyAttachment } from "./components/ResourcePreview";
import { MessageIdentityContext } from "./components/message-identity";
import { toast } from "./components/ui/toast";
import { IconButton, Modal, VirtualList } from "./components/ui";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./components/ui/avatar";
import { Bubble, BubbleContent } from "./components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "./components/ui/marker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { TooltipProvider } from "./components/ui/tooltip";
import { Markdown } from "./components/Markdown";
import ComposerEditor from "./components/composer-editor";
import { Message } from "./components/Timeline";
import { ThreadQueueDemo } from "./components/ThreadQueueDemo";
import { AgentWorkDemo } from "./components/AgentWorkDemo";
import { SidebarSearch } from "./components/SidebarSearch";
import { ThreadCard } from "./components/ThreadSelect";
import "./design-system.css";

const sections = [
  ["foundations", "Foundations"],
  ["threads", "Threads"],
  ["messages", "Messages"],
  ["agent-work", "Agent work"],
  ["composer", "Composer"],
  ["attachments", "Attachments"],
  ["content", "Rich content"],
  ["controls", "Controls"],
  ["overlays", "Overlays"],
  ["layout", "Layout"],
] as const;
const now = new Date("2026-09-19T09:00:00Z").getTime();
const threadStates = [
  { state: "idle", label: "Idle", title: "Weekend reading list" },
  { state: "completed", label: "Completed · unread", title: "A few places to visit in Kyoto" },
  { state: "working", label: "Working", title: "Compare the two proposals" },
  { state: "error", label: "Error", title: "Find the missing receipt" },
  { state: "input", label: "Needs input · preview only", title: "Which date works for everyone?" },
] as const;
const swatches = [
  "background",
  "surface",
  "surface-hover",
  "surface-raised",
  "foreground",
  "muted-foreground",
  "primary",
  "danger",
  "success",
] as const;
const spacings = [1, 2, 3, 4, 5, 6, 7];
const noop = () => {};
const markdownAttachment = [
  "#### A quiet weekend",
  "Start with **coffee by the river**, then browse the bookstore. Leave enough time to explore the neighborhood and find somewhere to read before heading home.",
  "- Bring a book to swap\n- Leave the afternoon free",
  "https://example.com/" + "a-long-path-without-breaks".repeat(8),
  "```text\n" + "A long code line should wrap within the preview. ".repeat(8) + "\n```",
  "| Plan | Details |\n| --- | --- |\n| Morning | " + "CoffeeAndBooks".repeat(12) + " |",
].join("\n\n");
const identities = {
  viewerId: "alex",
  agent: { displayName: "Lilac", avatarUrl: logo },
  users: new Map([
    ["alex", { displayName: "Alex Chen" }],
    ["morgan", { displayName: "Morgan Lee" }],
  ]),
};
const messageFixtures: DisplayMessage[] = [
  {
    id: "gallery-user",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 60_000 },
    parts: [
      {
        type: "text",
        text: "Can you help me plan a quiet weekend? Somewhere with good coffee and a bookstore.",
      },
    ],
  },
  {
    id: "gallery-participant",
    role: "user",
    metadata: { authorId: "morgan", createdAt: now - 30_000 },
    parts: [{ type: "text", text: "The riverside sounds good. I'll bring a book to swap." }],
  },
  {
    id: "gallery-user-attachment",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 15_000 },
    parts: [
      {
        type: "text",
        text: "Use [lilac.svg](/api/resources/gallery-shared-image) for the cover. Keep the plan short enough to share.",
      },
      {
        type: "data-resource",
        id: "gallery-shared-image",
        data: {
          resourceId: "gallery-shared-image",
          name: "lilac.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-cover-image",
        data: {
          resourceId: "gallery-cover-image",
          name: "cover-option.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-detail-image",
        data: {
          resourceId: "gallery-detail-image",
          name: "detail.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-shared-pdf",
        data: {
          resourceId: "gallery-shared-pdf",
          name: "weekend.pdf",
          mediaType: "application/pdf",
          size: 728,
          state: "ready",
        },
      },
    ],
  },
  {
    id: "gallery-long-user",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 10_000 },
    parts: [
      {
        type: "text",
        text: Array.from(
          { length: 14 },
          () =>
            `Leave room for a riverside walk, a bookstore visit, and an unhurried coffee. Keep the afternoon flexible so everyone can choose their own pace.`,
        ).join("\n\n"),
      },
    ],
  },
  {
    id: "gallery-agent",
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: now },
    parts: [
      {
        type: "text",
        text: "Start with the riverside walk, then stop at **Chapter House** for coffee. The bookstore next door stays open until six.\n\nLeave the afternoon free. You won't need reservations.",
      },
    ],
  },
  {
    id: "gallery-work",
    role: "assistant",
    metadata: { createdAt: now },
    parts: [
      {
        type: "data-activity",
        id: "gallery-think",
        data: {
          kind: "thinking",
          label: "Thinking",
          state: "complete",
          detail: "Comparing opening hours and walking distances.",
          durationMs: 2100,
        },
      },
      {
        type: "data-activity",
        id: "gallery-search",
        data: {
          kind: "tool",
          label: "Searched nearby places",
          state: "complete",
          detail: "Found three cafés and two independent bookstores.",
          durationMs: 900,
        },
      },
      {
        type: "text",
        text: "The café opens earlier than the bookstore, so that order works well.",
      },
    ],
  },
  {
    id: "gallery-files",
    role: "assistant",
    parts: [
      {
        type: "data-resource",
        id: "gallery-logo",
        data: {
          resourceId: "gallery-logo",
          name: "lilac.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-upload",
        data: {
          resourceId: "gallery-upload",
          name: "weekend-notes.txt",
          mediaType: "text/plain",
          size: 48000,
          state: "pending",
          progress: 0.6,
        },
      },
      {
        type: "data-resource",
        id: "gallery-failed",
        data: {
          resourceId: "gallery-failed",
          name: "map.pdf",
          mediaType: "application/pdf",
          size: 340000,
          state: "failed",
          error: "Upload interrupted",
        },
      },
    ],
  },
];
const richText =
  '### A small plan\n\nUse **bold**, *italic*, ~~strikethrough~~, and `inline code`. Links include a favicon: [GitHub](https://github.com).\n\n> Leave enough room to change your mind.\n\n- [x] Pick a place\n- [ ] Check the weather\n\n| Time | Plan |\n| --- | --- |\n| Morning | Coffee and a walk |\n| Afternoon | Bookstore |\n\n```typescript\nconst weekend = { pace: "slow", reservations: false };\nconsole.log("There is time to stop and explore", weekend);\n```\n\n```bash\nbun run dev:web\n```\n\nInline math: $a^2 + b^2 = c^2$.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n```mermaid\nflowchart LR\n  Coffee --> Walk --> Bookstore\n```';

const alertExamples = [
  "> [!NOTE]\n> Keep useful context close to the conversation.",
  "> [!TIP]\n> Use **Shift + Enter** to add a new line.",
  "> [!IMPORTANT]\n> Save your work before starting the next step.",
  "> [!WARNING]\n> Check the destination before moving files.",
  "> [!CAUTION]\n> Deleting this file cannot be undone.",
].join("\n\n");

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ds-section" aria-labelledby={`${id}-title`}>
      <header className="ds-section-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
function Specimen({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ds-specimen ${className}`}>
      <h3>{title}</h3>
      <div className="ds-specimen-body">{children}</div>
    </div>
  );
}
function DemoThreadActions({ onAction }: { onAction: (label: string) => void }) {
  return (
    <>
      <IconButton
        label="Settle conversation"
        tooltip="Settle"
        onClick={() => onAction("Settle selected")}
      >
        <Check />
      </IconButton>
      <IconButton
        label="Rename conversation"
        tooltip="Rename"
        onClick={() => onAction("Rename selected")}
      >
        <Pencil />
      </IconButton>
    </>
  );
}
function Foundations() {
  return (
    <Section id="foundations" title="Foundations">
      <div className="ds-swatches">
        {swatches.map((token) => (
          <div key={token} className="ds-swatch">
            <span className={`ds-color ds-color-${token}`} />
            <code>{token}</code>
          </div>
        ))}
      </div>
      <div className="ds-grid">
        <Specimen title="Type">
          <div className="ds-type">
            <span className="ds-type-2xl">A little room to think</span>
            <span className="ds-type-lg">Conversation title</span>
            <span>Body text and message content</span>
            <span className="ds-type-sm">Supporting details</span>
            <span className="ds-type-xs">Metadata and timestamps</span>
          </div>
        </Specimen>
        <Specimen title="Spacing & corners">
          <div className="ds-spacing">
            {spacings.map((space) => (
              <div key={space}>
                <code>{space}</code>
                <span className={`ds-space ds-space-${space}`} />
              </div>
            ))}
          </div>
          <div className="ds-row">
            <span className="ds-radius ds-radius-sm">sm</span>
            <span className="ds-radius ds-radius-md">md</span>
            <span className="ds-radius ds-radius-lg">lg</span>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
function Threads() {
  const [selected, setSelected] = useState("working");
  const [action, setAction] = useState("");
  return (
    <Section
      id="threads"
      title="Threads"
      description="Hover or focus a row to inspect its actions. The input state is visual only."
    >
      <div className="ds-grid">
        <div className="ds-thread-list">
          {threadStates.map(({ state, label, title }, index) => (
            <div key={state}>
              <h3 className="ds-state-label">{label}</h3>
              <ThreadCard
                title={title}
                starterName={index % 2 ? "Morgan Lee" : "Alex Chen"}
                updatedAt={now - index * 3_600_000}
                now={now}
                state={state}
                selected={selected === state}
                onSelect={() => setSelected(state)}
                actions={<DemoThreadActions onAction={setAction} />}
              />
            </div>
          ))}
        </div>
        <Specimen title="Personal queues">
          <ThreadQueueDemo />
          <p className="ds-muted">
            Drag conversations to reorder, pin, or settle them. Changes affect this preview only.
          </p>
        </Specimen>
        <Specimen title="Thread details">
          <div className="thread-details">
            <strong>Compare the two proposals</strong>
            <span>Started by Alex Chen</span>
            <span>Last active today at 5:00 PM</span>
            <span>Access: Alex Chen, Morgan Lee</span>
            <span>Working</span>
          </div>
          <p className="ds-feedback" role="status">
            {action || "Actions here affect this preview only."}
          </p>
        </Specimen>
      </div>
    </Section>
  );
}
function Messages() {
  return (
    <Section
      id="messages"
      title="Messages"
      description="The same message renderer used in conversations, with sample content."
    >
      <MessageIdentityContext value={identities}>
        <div className="ds-conversation">
          {messageFixtures.map((message) => (
            <Message
              key={message.id}
              message={message}
              resourceUrl={(id) => (id === "gallery-shared-pdf" ? weekendPdf : logo)}
              canEdit={false}
              onAction={noop}
              onReaction={noop}
            />
          ))}
        </div>
      </MessageIdentityContext>
      <div className="ds-grid">
        <Specimen title="Avatars">
          <div className="ds-row">
            {(["sm", "default", "lg"] as const).map((size) => (
              <Avatar key={size} size={size}>
                <AvatarImage src={logo} alt="Lilac" />
                <AvatarFallback>LI</AvatarFallback>
              </Avatar>
            ))}
            <Avatar>
              <AvatarFallback>AC</AvatarFallback>
              <AvatarBadge />
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>AC</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>ML</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+2</AvatarGroupCount>
            </AvatarGroup>
          </div>
        </Specimen>
        <Specimen title="Bubble variants">
          <div className="ds-stack">
            {(
              [
                "default",
                "secondary",
                "muted",
                "tinted",
                "outline",
                "ghost",
                "destructive",
              ] as const
            ).map((variant) => (
              <Bubble key={variant} variant={variant}>
                <BubbleContent>{variant}</BubbleContent>
              </Bubble>
            ))}
          </div>
        </Specimen>
      </div>
      <Specimen title="Markers">
        <div className="ds-stack">
          <Marker>
            <MarkerIcon>
              <LoaderCircle />
            </MarkerIcon>
            <MarkerContent>Thinking…</MarkerContent>
          </Marker>
          <Marker variant="separator">
            <MarkerContent>Conversation compacted</MarkerContent>
          </Marker>
          <Marker variant="border">
            <MarkerIcon>
              <Check />
            </MarkerIcon>
            <MarkerContent>Finished in 8 seconds</MarkerContent>
          </Marker>
        </div>
      </Specimen>
    </Section>
  );
}
function ComposerSpecimen() {
  const [text, setText] = useState("Help me turn these **notes** into a weekend plan.");
  const [disabled, setDisabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>(() => [
    {
      key: "gallery-notes",
      file: new File(["A quiet weekend"], "notes.txt", { type: "text/plain" }),
      reservation: Promise.resolve("gallery-notes"),
      state: "ready",
      progress: 1,
    },
  ]);
  return (
    <Section
      id="composer"
      title="Composer"
      description="Try the formatting toolbar, Markdown shortcuts, and multiline input."
    >
      <div className="ds-row">
        <Button variant="secondary" onClick={() => setDisabled((value) => !value)}>
          {disabled ? "Enable editor" : "Disable editor"}
        </Button>
      </div>
      <div className="composer ds-composer">
        <ComposerEditor
          text={text}
          onText={setText}
          attachments={attachments}
          onRemoveAttachment={(key) =>
            setAttachments((items) => items.filter((item) => item.key !== key))
          }
          disabled={disabled}
          placeholder="Message Lilac…"
          onPlainText={noop}
          onPrefix={noop}
          onKeyDown={noop}
          onPaste={noop}
          expanded={false}
        />
      </div>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" />}>
          <ChevronRight />
          Markdown output
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="ds-source">{text}</pre>
        </CollapsibleContent>
      </Collapsible>
    </Section>
  );
}
function Attachments() {
  return (
    <Section
      id="attachments"
      title="Attachments"
      description="Open a media card to try the viewer. These files are generated preview fixtures."
    >
      <div className="ds-grid">
        <Specimen title="Image">
          <ReadyAttachment
            href={logo}
            data={{
              resourceId: "gallery-image",
              name: "lilac.svg",
              mediaType: "image/svg+xml",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Video">
          <ReadyAttachment
            href={motion}
            data={{
              resourceId: "gallery-video",
              name: "motion.mp4",
              mediaType: "video/mp4",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Audio">
          <ReadyAttachment
            href={tone}
            data={{
              resourceId: "gallery-audio",
              name: "tone.wav",
              mediaType: "audio/wav",
              size: 88278,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Text preview">
          <AttachmentPreviewBody
            name="notes.txt"
            href="data:text/plain,A%20quiet%20weekend"
            kind="text"
            text={{
              status: "ready",
              text: "A quiet weekend\n\n1. Coffee by the river\n2. Browse the bookstore\n3. Leave the afternoon free",
              truncated: false,
            }}
          />
        </Specimen>
        <Specimen title="Markdown preview">
          <AttachmentPreviewBody
            name="notes.md"
            href={`data:text/markdown,${encodeURIComponent(markdownAttachment)}`}
            kind="text"
            text={{ status: "ready", text: markdownAttachment, truncated: false }}
          />
        </Specimen>
        <Specimen title="PDF">
          <ReadyAttachment
            href={weekendPdf}
            data={{
              resourceId: "gallery-pdf",
              name: "weekend.pdf",
              mediaType: "application/pdf",
              size: 728,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Truncated text">
          <AttachmentPreviewBody
            name="long-notes.txt"
            href="data:text/plain,Preview%20fixture"
            kind="text"
            text={{ status: "ready", text: "Preview fixture…", truncated: true }}
          />
        </Specimen>
        <Specimen title="Binary file">
          <AttachmentPreviewBody
            name="archive.zip"
            href=""
            kind="text"
            text={{ status: "error", message: "This binary file cannot be previewed as text." }}
          />
        </Specimen>
      </div>
    </Section>
  );
}
function Controls() {
  const [search, setSearch] = useState("");
  const [model, setModel] = useState<string | null>("balanced");
  return (
    <Section id="controls" title="Controls">
      <Specimen title="Buttons">
        <div className="ds-row">
          {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map(
            (variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ),
          )}
          <Button disabled>Disabled</Button>
          <IconButton label="New conversation">
            <Plus />
          </IconButton>
        </div>
        <div className="ds-row">
          {(["xs", "sm", "default", "lg"] as const).map((size) => (
            <Button key={size} size={size} variant="secondary">
              {size}
            </Button>
          ))}
        </div>
      </Specimen>
      <div className="ds-grid">
        <Specimen title="Inputs">
          <label className="ds-field">
            Conversation title
            <Input placeholder="Untitled conversation" />
          </label>
          <div className="ds-field">
            <span>Search</span>
            <SidebarSearch
              onSearch={(query) => setSearch(query.trim())}
              onClear={() => setSearch("")}
            />
            <span className="ds-muted" role="status">
              {search ? `Submitted search: ${search}` : ""}
            </span>
          </div>
          <label className="ds-field">
            Disabled
            <Input disabled value="Unavailable" readOnly />
          </label>
          <label className="ds-field">
            Invalid
            <Input aria-invalid defaultValue="Needs a name" />
          </label>
          <label className="ds-field">
            Plain text
            <Textarea placeholder="Write a note…" />
          </label>
        </Specimen>
        <Specimen title="Select & tabs">
          <Select
            value={model}
            onValueChange={setModel}
            items={[
              { value: "balanced", label: "Balanced" },
              { value: "deep", label: "Deep thinking" },
            ]}
          >
            <SelectTrigger aria-label="Example response model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="deep">Deep thinking</SelectItem>
            </SelectContent>
          </Select>
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general">General settings content.</TabsContent>
            <TabsContent value="appearance">Appearance settings content.</TabsContent>
          </Tabs>
          <Tabs defaultValue="chat">
            <TabsList variant="line">
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
            <TabsContent value="chat">Conversation content.</TabsContent>
            <TabsContent value="files">Shared files.</TabsContent>
          </Tabs>
        </Specimen>
      </div>
    </Section>
  );
}
function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [action, setAction] = useState("");
  return (
    <Section id="overlays" title="Overlays">
      <div className="ds-row">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>
            Thread actions
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setAction("Rename selected")}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAction("Archive selected")}>
              <Archive />
              Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" />}>Popover</PopoverTrigger>
          <PopoverContent>
            <strong>Shared with 2 people</strong>
            <p className="ds-muted">Alex Chen and Morgan Lee can edit this conversation.</p>
          </PopoverContent>
        </Popover>
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <IconButton label="Notifications">
          <Bell />
        </IconButton>
        <IconButton label="Copy message">
          <Copy />
        </IconButton>
      </div>
      <ContextMenu>
        <ContextMenuTrigger className="ds-context-target" tabIndex={0}>
          Right-click for thread actions
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setAction("Rename selected")}>
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setAction("Archive selected")}>
            <Archive />
            Archive
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className="ds-feedback" role="status">
        {action}
      </p>
      <Specimen title="Toasts">
        <div className="ds-row">
          <Button
            variant="secondary"
            onClick={() =>
              toast.add({
                title: "New version available",
                description: "Reload to use the latest version.",
                type: "info",
                actionProps: {
                  children: "Reload",
                  onClick: () => setAction("Reload selected in preview"),
                },
              })
            }
          >
            Update
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.add({
                title: "You're offline",
                description: "Cached conversations are still available.",
                type: "warning",
              })
            }
          >
            Offline
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.add({
                title: "Could not connect",
                description: "Check your connection and try again.",
                type: "error",
              })
            }
          >
            Connection error
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.add({ title: "Changes saved", type: "success" })}
          >
            Success
          </Button>
        </div>
      </Specimen>
      <Modal open={dialog} title="Rename conversation" onClose={() => setDialog(false)}>
        <label className="ds-field">
          Title
          <Input defaultValue="A quiet weekend" />
        </label>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setDialog(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setDialog(false);
              setAction("Preview title saved");
            }}
          >
            Save
          </Button>
        </div>
      </Modal>
    </Section>
  );
}
const listItems = [...Array.from({ length: 100 }).keys()].map((index) => ({
  id: String(index),
  label: `Conversation ${index + 1}`,
}));
function Layout() {
  return (
    <Section
      id="layout"
      title="Layout"
      description="Drag the divider. The list renders only visible rows."
    >
      <div className="ds-resizable">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="35%" minSize="25%">
            <div className="ds-panel">
              <strong>Conversations</strong>
              <VirtualList
                items={listItems}
                label="Example conversations"
                itemKey={(item) => item.id}
                render={(item) => (
                  <Button variant="ghost" className="ds-list-row">
                    <FileText />
                    {item.label}
                  </Button>
                )}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel minSize="30%">
            <div className="ds-panel ds-panel-center">
              <span className="brand">
                lilac<span>.</span>
              </span>
              <span className="ds-muted">Your next conversation starts here.</span>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Section>
  );
}
export default function DesignSystem() {
  const returnThreadId = useLocation({ select: (location) => location.state.chatThreadId });
  const returnDraftId = useLocation({ select: (location) => location.state.draftThreadId });

  const [queries] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "system");
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    return () => {
      if (previous) document.documentElement.dataset.theme = previous;
      else delete document.documentElement.dataset.theme;
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <QueryClientProvider client={queries}>
      <TooltipProvider>
        <div className="ds-page">
          <header className="ds-header">
            <Link
              to={returnThreadId ? "/threads/$threadId" : "/"}
              params={returnThreadId ? { threadId: returnThreadId } : {}}
              state={{ draftThreadId: returnDraftId }}
              className="ds-back"
            >
              <ArrowLeft />
              Back to chat
            </Link>
            <div className="ds-header-main">
              <div>
                <span className="ds-eyebrow">Lilac</span>
                <h1>Design system</h1>
                <p>Components, states, and patterns used in the native app.</p>
              </div>
              <Select
                value={theme}
                items={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
                onValueChange={(value) => {
                  if (value) setTheme(value);
                }}
              >
                <SelectTrigger aria-label="Preview theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </header>
          <div className="ds-body">
            <nav className="ds-nav" aria-label="Component sections">
              {sections.map(([id, title]) => (
                <a key={id} href={`#${id}`}>
                  {title}
                </a>
              ))}
            </nav>
            <main className="ds-main">
              <Foundations />
              <Threads />
              <Messages />
              <Section
                id="agent-work"
                title="Agent work"
                description="Choose a stage to inspect, or play through the examples. Expand work summaries and tool details. These use the conversation renderer with local sample data."
              >
                <AgentWorkDemo />
              </Section>
              <ComposerSpecimen />
              <Attachments />
              <Section id="content" title="Rich content">
                <div className="ds-content">
                  <Markdown text={richText} />
                  <Specimen title="GitHub alerts">
                    <Markdown text={alertExamples} />
                  </Specimen>
                </div>
              </Section>
              <Controls />
              <Overlays />
              <Layout />
            </main>
          </div>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
