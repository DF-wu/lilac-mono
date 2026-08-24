# Core Unified Ingress Resources

## Status

This is the active implementation plan for giving every Core ingress attachment a stable, unguessable
`resource://` URI. Possession of the exact URI grants access while at least one retained structured
reference keeps its resource record alive. One Core resource module resolves those URIs for model
composition, `read`, `grep`, `resource.materialize`, and the deprecated `attachment.download`
callable.

The first surface adapter is Discord. Mini Lilac is unchanged.

## Goals

The implementation must:

- give every Core ingress attachment a stable opaque resource URI;
- keep surface URLs, credentials, attachment IDs, and blob object IDs out of model-visible markers and
  durable messages;
- keep structured resource identity in event-bus messages and stored transcripts;
- use one capability-validation and resolution path for model composition, `read`, `grep`, and
  materialization;
- preserve direct model image and PDF parts when the provider accepts that media and the verified file
  is no larger than 25 MiB;
- keep larger media model-visible through metadata and explicit materialization guidance without
  placing its bytes in the model request;
- stream origin downloads into `BlobStore` with a hard 512 MiB resource limit;
- let `read` consume verified text, images, and PDFs without writing into cwd;
- let `grep` search one verified text resource without decoding the complete resource into one
  JavaScript string;
- let `resource.materialize` write selected resources into the request cwd allowed by filesystem
  policy with per-item results and no overwrite behavior;
- retain historical stored blob parts and the deprecated `attachment.download` callable; and
- delete resource records with their final retained transcript or surface-projection reference.

## Scope

This plan changes Core ingress attachments, beginning with Discord. It changes the Core event-bus and
transcript contracts needed to carry structured resource parts. It adds one Core-owned SQLite resource
store beside existing transcript persistence.

The shared resource path covers:

- provider request composition;
- `read(resource://...)`;
- `grep({ path: "resource://..." })`;
- `resource.materialize`; and
- deprecated `attachment.download` calls for current resource-backed attachments.

Images and PDFs may appear as provider file parts. Text and other binary resources appear as metadata
only until a tool accesses them.

## Product decisions

1. Resource URIs are opaque identifiers. They do not encode a surface, message, attachment, session,
   storage adapter, or filesystem path.
2. A resource URI is an unguessable capability reference. Possession of the exact URI grants access
   while at least one retained resource reference exists. Access is not limited by request, session, or
   originating surface.
3. Registering the same canonical surface reference returns the same resource ID while that resource
   record remains retained.
4. A URI copied through ordinary text can be passed to `read`, `grep`, or `resource.materialize`. Core
   does not parse ordinary text to turn that reference into an automatic provider file part.
5. Cross-request and cross-surface access require no transfer record or permission update. A future
   surface adapter can resolve its own origins through the same resource module.
6. Signed surface URLs are transient. The surface adapter refreshes them from the stored surface
   reference when a cache fill needs origin bytes.
7. Provider file parts are byte-backed. Provider request composition never uses an HTTPS URL-backed
   resource part.
8. Provider inline bytes are limited to 25 MiB per resource. A resource above that limit remains
   marker-only and tells the model to materialize and transform it before consumption.
9. Claude Code receives byte-backed images up to the inline limit. It receives metadata only for PDFs
   and other files.
10. Every resource is limited to 512 MiB. One `resource.materialize` call is limited to 1 GiB and 32
    selected URIs.
11. These limits are package-owned constants in the first version. Tests inject smaller limits. This
    change does not add resource configuration fields or migrate the Discord attachment-cache setting.
12. The cache has no global byte budget, LRU policy, or independent TTL. A cached object lives with its
    resource record. Final-reference cleanup deletes the cached object before completing resource-row
    cleanup, and transcript maintenance retries a failed delete.
13. Resource metadata remains while at least one retained transcript or surface projection refers to
    it. Using a URI from another request does not extend retention unless that request persists a
    structured resource part.
14. Materialization chooses one safe filename. An existing destination returns `already_exists`; the
    tool does not overwrite it or choose a numbered alternative.
15. Materialization writes directly to an exclusively created destination. A file may be visible while
    the operation is running. The tool deletes that operation-owned file if streaming, verification,
    or cancellation fails.
16. Expected resource and item failures use Results. Throws and Panics remain defects.

## Fixed limits

Production uses these constants:

```ts
const RESOURCE_MAX_BYTES = 512 * 1024 * 1024;
const RESOURCE_MODEL_INLINE_MAX_BYTES = 25 * 1024 * 1024;
const RESOURCE_MATERIALIZE_CALL_MAX_BYTES = 1024 * 1024 * 1024;
const RESOURCE_MATERIALIZE_MAX_COUNT = 32;
```

Reported size provides an early rejection only. The resource module counts actual streamed bytes and
aborts when an operation limit is exceeded.

## Resource URI contract

Resource URIs use this strict format:

```text
resource://r1_<random-128-bit-id>
```

The parser accepts the exact scheme and one lowercase versioned identifier. It rejects credentials,
ports, paths, query strings, fragments, percent-encoded variants, and trailing content. Registration
retries a random-ID collision.

The model-visible URI and marker never contain the database row ID, Discord attachment ID, Discord CDN
URL, signed query parameters, or `BlobRefV1.objectId`.

## Durable records

Add a strict versioned resource record codec:

```ts
type ResourceRecordV1 = {
  version: 1;
  resourceId: string;
  origin: ResourceOriginV1;
  filename?: string;
  declaredMediaType?: string;
  detectedMediaType?: string;
  reportedByteLength?: number;
  createdAt: number;
  cache?: {
    blob: BlobRefV1;
    cachedAt: number;
  };
};
```

The first origin is Discord:

```ts
type DiscordResourceOriginV1 = {
  version: 1;
  kind: "discord-attachment";
  channelId: string;
  messageId: string;
  ordinal: number;
  attachmentId?: string;
};
```

The canonical origin includes the visible attachment ordinal and the attachment ID when Discord
provides one. Filename, declared media type, and reported size are the ingress metadata snapshot used
to verify an attachment without an ID and to render the marker. Later origin resolution may verify
current response metadata, but it does not silently change the marker attribution.

Store resource records and retention references in the Core transcript SQLite database. The schema
contains:

- one resource row per canonical surface origin;
- a unique resource-ID index;
- zero or one current cache reference per resource; and
- resource-reference rows keyed by retained transcript or surface-projection owner.

Admission writes the structured message and its resource references in the same persistence workflow.
Deleting a transcript or projection deletes its reference rows. A record with no retained references
stops resolving immediately. Transcript maintenance deletes its cached blob idempotently and removes
the resource row after BlobStore reports `deleted` or `absent`. A failed blob delete leaves the
zero-reference row for the next maintenance pass.

The cached bytes are resource-owned derived content. The resource store uses a durable BlobRef and
deletes it when the final retained resource reference disappears. A missing or corrupt cache object
clears the cached reference conditionally and falls back to the surface origin. A resource remains
usable while its origin can still be resolved.

## Internal message contract

Extend the event-bus and stored-message part unions with:

```ts
type StoredResourcePartV1 = {
  type: "resource";
  uri: string;
  filename?: string;
  mediaType?: string;
  size?: number;
};
```

This part is internal. Provider adapters never receive it directly. The resource marker uses the
metadata snapshot stored in this part. The resource record supplies capability validation, origin
resolution, detected classification, and cached bytes.

Update at least:

- `packages/event-bus/blob-messages.ts`;
- the Core request-composition schemas;
- Core primary-lineage identity projection;
- transcript persistence codecs;
- request admission and recovery;
- `apps/core/src/transcript/stored-message-materialization.ts`; and
- request message caching used by Level 2 tools.

Existing stored blob parts remain valid. No historical message or attachment rewrite is required.

The transcript schema moves from version 6 to version 7. Startup performs one focused additive v6 to
v7 migration that creates the resource tables and updates the schema version. Older schema handling
keeps its existing migration policy. The rollout updates Core and its event-bus package together; an
older Core binary is not expected to consume newly encoded resource parts.

## Access contract

The random 128-bit resource ID is the access capability. Resource access succeeds when the URI parses,
its resource record exists, and at least one retained resource reference exists. The resource module
does not compare request, session, principal, or surface identity.

Structured resource parts remain the durable presentation and retention contract. Ordinary text is
not parsed to discover provider file parts or create retention references, but an exact URI copied in
text can be supplied directly to a resource-aware tool. No subagent schema or prompt contract changes
as part of this plan.

Cross-request access does not extend resource lifetime by itself. The URI stops resolving after the
final structured transcript or surface-projection reference is deleted. A future surface or explicit
transfer path can retain the same resource ID by persisting a structured resource part and its
retention reference.

## Discord origin resolution

The Discord adapter resolves a stored surface reference as follows:

1. Reread the referenced message through the existing Discord surface client.
2. Apply the current visible-attachment rules, including forwarded snapshots.
3. Select the stored visible ordinal.
4. Verify the attachment ID when present. Otherwise verify the stored filename, size, and media-type
   fingerprint before using the selected attachment.
5. Return `origin_unavailable` when the message or attachment is absent, no longer visible, or fails
   identity verification.
6. Return its current signed HTTPS URL and current response metadata to the resource module.

The adapter never persists the signed URL. Logs and expected errors identify the resource URI and
surface operation without including the URL or its query string.

Focused tests cover current messages, forwarded snapshots, edited messages that retain the attachment,
deleted messages, removed attachments, and mismatched attachment IDs.

## MIME classification

The resource module owns one classification policy shared by all consumers:

- trusted binary signatures take precedence over filename and declared media type;
- a bounded prefix sniff distinguishes known binary formats and NUL-containing content;
- text requires a declared or filename-derived text format plus a successful binary sniff;
- text decoding supports UTF-8 and a UTF-8 BOM;
- invalid UTF-8 is unsupported binary for `read` and `grep`;
- image and PDF classification requires a matching detected signature; and
- materialization accepts every classification because it writes verified bytes without interpreting
  them.

The stored `detectedMediaType` may be filled after the first successful verified read. A later
classification mismatch clears the stale cache reference and returns a typed origin or integrity
failure instead of silently changing the resource type.

## Pull-through cache

All consumers use the same cache-fill operation with an operation-specific byte limit no greater than
512 MiB:

1. Validate the capability URI and load its resource record.
2. Reject a known reported size above the operation limit.
3. Open the current cache reference through `BlobStore`.
4. On a cache miss, refresh the signed origin URL through the surface adapter.
5. Reject a current reported or response size above the operation limit.
6. Stream the response into `BlobStore` with durable resource-owned retention.
7. Count actual bytes and abort once the operation limit is exceeded.
8. Await upload completion and verify SHA-256 and exact byte length.
9. Attach the resulting reference with compare-and-swap semantics.
10. Delete a losing duplicate fill idempotently.
11. Open the verified winning reference for the caller.

The implementation does not call `arrayBuffer()`, convert the complete response to base64, or use
`ReadableStream.tee()` during cache fill.

Concurrent callers in one process share a fill. Cross-process callers may perform duplicate fills;
only one cache reference wins, and the losing completion deletes its blob. The resource module
supervises its local fills and settles them before closing its BlobStore dependency.

A caller must consume or cancel the returned stream and await `BlobRead.completion`. Successful tool
or materialization output requires successful terminal verification.

## Ingress registration

For every visible inbound attachment:

1. Normalize and validate its Discord surface reference.
2. Register or reuse the resource record for that canonical origin.
3. Emit one structured resource part.
4. Add the transcript or projection retention reference.
5. Attempt a streaming eager cache fill when reported size is known and no greater than 25 MiB.
6. Keep unknown-size and larger files origin-backed until a consumer opens them.
7. Continue request composition with the marker if eager caching fails.

Ingress never buffers the complete attachment. The provider materializer may retry an origin-backed
image or PDF under the 25 MiB model limit when it constructs the first model request.

## Model presentation

Provider-facing materialization converts one structured resource part into ordinary AI SDK text and,
when allowed, a byte-backed file part:

| Resource                                                | Provider content                          |
| ------------------------------------------------------- | ----------------------------------------- |
| Verified image at most 25 MiB and supported by provider | Marker followed by byte-backed image part |
| Verified PDF at most 25 MiB and supported by provider   | Marker followed by byte-backed PDF part   |
| Text                                                    | Marker only                               |
| Other binary                                            | Marker only                               |
| Media over 25 MiB                                       | Marker followed by inline-limit guidance  |
| Origin unavailable or cache fill failed                 | Marker followed by access-error guidance  |

The normal marker retains surface attribution:

```text
[discord_attachment uri="resource://r1_abcd..." filename="image.png" mime="image/png" size=321]
```

A file that cannot enter the provider request receives a model-visible expected error such as:

```text
[resource_inline_error uri="resource://r1_abcd..." code="too_large" limit=26214400]
Use resource.materialize to write this resource into the working directory, transform it to a supported size or format, and then consume the transformed file.
```

This error does not fail the whole run. The resource remains available through its capability URI.

Provider rules are intentionally small:

- use the current direct-attachment capability for images and PDFs;
- give Claude Code byte-backed images only;
- omit unsupported file parts while retaining their marker and guidance; and
- let provider-specific limits below 25 MiB remain provider behavior.

The provider path never receives a signed URL. A cached or newly filled resource is read into memory
only after its verified byte length is known to be no greater than 25 MiB.

Text attachments are not downloaded and inserted into the prompt. The agent uses `read`, `grep`, or
`resource.materialize` when it needs their contents.

## Resource module

Add one Core resource module with injected dependencies:

- resource store;
- BlobStore;
- surface origin adapters;
- clock;
- fixed limits; and
- logger.

The external interfaces are:

```ts
type ResourceRegistry = {
  register(
    input: RegisterResourceInput,
  ): Promise<Result<ResourceDescriptor, ResourceRegistrationError>>;
};

type ResourceAccess = {
  describe(uri: string): Result<ResourceDescriptor, ResourceAccessError>;

  open(
    uri: string,
    options: {
      maxBytes: number;
      expected?: "text" | "image" | "pdf" | "any";
      signal?: AbortSignal;
    },
  ): Promise<Result<VerifiedResourceRead, ResourceAccessError>>;

  materialize(
    uri: string,
    targetDirectory: string,
    signal?: AbortSignal,
  ): Promise<Result<MaterializedResource, ResourceAccessError>>;
};
```

`VerifiedResourceRead` contains the descriptor, verified classification, `BlobRefV1`, stream, and
terminal completion. The module owns URI parsing, record lookup, origin refresh, cache fill, byte
limits, MIME classification, stale-cache clearing, and storage error translation.

Define a closed TaggedError union for invalid URI, missing record, unavailable origin, unsupported
classification, size limit, cache failure, integrity failure, and cancellation. Level 1 tools map
expected errors to their existing tool-result conventions. Level 2 materialization maps item errors
into output data. Call-level missing context or unusable cwd remains `Result.err`.

## `read(resource://...)`

Extend the Core `read` adapter in `apps/core/src/tools/fs/fs.ts`. Portable filesystem packages remain
unaware of Core resources. The resource URI branch runs before filesystem, SSH, and restricted-session
path handling.

### Text

- Open with the 512 MiB resource limit and expected text classification.
- Stream through a UTF-8 decoder rather than forming one resource-sized string.
- Preserve existing `start`, `maxLines`, `maxCharacters`, `raw`, and `numbered` behavior.
- Return the resource URI as `resolvedPath`.
- Use the BlobRef digest instead of rereading the complete content solely to hash it.
- Do not write into cwd or load filesystem instructions such as `AGENTS.md`.
- Reject `hashline` because the resource is not an editable filesystem path.

### Images and PDFs

- Preflight known size before downloading.
- Open with the lower of `RESOURCE_MODEL_INLINE_MAX_BYTES` and the existing
  `tools.media.maxInlineBytesPerPart` setting, not the 512 MiB materialization limit.
- Verify the expected image or PDF signature.
- Return the existing attachment-style tool result when the current model capability accepts it.
- Give Claude Code images only.
- Return the existing media-limit guidance for a file above 25 MiB and point to
  `resource.materialize`.

### Other binary files

Return an expected unsupported-media failure with filename, detected media type, and guidance to use
`resource.materialize`.

Restricted sessions may read capability URIs because this branch does not access a filesystem path.

## `grep(resource://...)`

Extend the Core `grep` adapter beside the existing `tool-result://` branch:

- accept one resource URI through the existing `path` field;
- open with the 512 MiB resource limit and expected text classification;
- reject images, PDFs, archives, executables, invalid UTF-8, and other binary content;
- stream the verified resource into an operation-owned private temporary file;
- await terminal read verification before reporting successful matches;
- run the existing ripgrep behavior against that file;
- remove the temporary file after success, failure, or cancellation;
- preserve `default` and `detailed` output modes;
- reject `hashline`;
- report the resource URI as the matched file;
- avoid writing into cwd; and
- avoid applying filesystem extension filters to unrelated files because the URI selects one object.

The implementation does not decode the complete resource into one JavaScript string.

## `resource.materialize`

Add the Level 2 callable:

```text
resource.materialize
```

Public input:

```ts
{
  uris: string[];
}
```

`uris` is the primary positional CLI field. Require between 1 and 32 entries. Process entries
sequentially and preserve input order. The public contract has no destination field.

Trusted requests target their configured cwd. Restricted requests target the existing session-private
mapping of virtual `/tmp`; returned paths use the virtual restricted path representation.

For each URI:

1. Validate the capability URI and load its resource record.
2. Enforce the 512 MiB resource limit and remaining 1 GiB call limit.
3. Resolve it through the pull-through cache.
4. Choose one safe basename from the stored filename.
5. Fall back to `resource-<short-id><extension>` when no safe filename exists.
6. Reject separators, NUL, control characters, `.`, `..`, and overlong UTF-8 names.
7. Open the final destination with exclusive creation and mode `0600`.
8. Return `already_exists` if that path exists.
9. Stream the verified blob into the destination while counting bytes.
10. Await blob read completion and verify actual bytes and SHA-256.
11. Close the file and report success.
12. Remove the file if this operation created it and any later step fails or is cancelled.

The tool does not overwrite, rename, or select a numbered suffix. A concurrent observer may see the
operation-owned file before the call finishes; only a successful result declares it complete.

Result shape:

```ts
type ResourceMaterializeOutput = {
  results: Array<
    | {
        uri: string;
        status: "ok";
        path: string;
        filename: string;
        mimeType?: string;
        bytes: number;
        sha256: string;
      }
    | {
        uri: string;
        status: "error";
        error: {
          code:
            | "invalid_uri"
            | "not_found"
            | "origin_unavailable"
            | "too_large"
            | "batch_limit"
            | "cache_unavailable"
            | "already_exists"
            | "write_failed"
            | "cancelled";
          message: string;
          retryable: boolean;
        };
      }
  >;
};
```

An expected item failure stays inside `Result.ok(output)` and does not skip later items. Cancellation
stops new I/O, records the active item as cancelled, and records every remaining item as cancelled
without starting it. A tool-level `Result.err` is reserved for failure to establish request context or
a target directory allowed by request filesystem policy.

Use a flat sequential Result workflow. Preserve every success and expected failure in input order.

## Deprecated `attachment.download`

Keep `attachment.download` registered with the existing deprecation pattern:

```ts
{
  description:
    "Deprecated: materialize inbound resources. Prefer resource.materialize.",
  hidden: true,
}
```

Remove it from model-facing tool documentation while retaining it in the stable callable catalog.

For resource-backed requests, the deprecated callable:

- discovers resource parts from the current request rather than the entire retained session;
- uses the existing `downloadDir` default and restricted-session mapping;
- materializes every current resource, including images and PDFs;
- delegates byte resolution and writes to the resource module;
- returns `resource://` as `sourceUrl` instead of exposing a signed surface URL;
- preserves the old output shape where its fields still apply; and
- returns a tool failure if any item fails because the old output cannot represent partial failures.

Successful earlier files may remain when a later item fails, matching the existing partial-side-effect
behavior.

When a historical request has only legacy provider file or stored blob parts, keep the existing bounded
legacy implementation. The new resource path does not rewrite those messages.

## Runtime wiring

Runtime composition performs these steps:

1. Construct the resource store from the transcript SQLite database.
2. Register the Discord origin adapter.
3. Inject unscoped registration into Discord request composition.
4. Persist resource references with request transcripts and surface projections.
5. Inject shared resource access into provider materialization, Core `read`, and Core `grep`.
6. Inject the same access into `resource.materialize` and deprecated `attachment.download`.
7. Close the resource store and settle local fills through the Core lifecycle.

## Implementation sequence

1. **Add resource URI, origin, record, and part codecs.**
   Completion criterion: current, malformed, corrupt, and future versions have focused strict-codec
   tests, and URI tests reject every extra URL component.

2. **Add the resource tables and v6 to v7 transcript migration.**
   Completion criterion: registration is stable per canonical origin, restart persistence works,
   retention references survive restart, a zero-reference record stops resolving, failed cache deletes
   retry, successful final-reference cleanup removes the record, and old v6 transcripts remain readable
   after migration.

3. **Add Discord origin resolution.**
   Completion criterion: current, forwarded, edited, deleted, removed, and identity-mismatch cases
   return explicit Results without persisting or logging signed URLs.

4. **Implement bounded pull-through caching.**
   Completion criterion: hits avoid origin reads, misses stream into BlobStore, actual-byte limits abort
   fills, one-process accesses coalesce, cross-process losing blobs are deleted, and final resource
   cleanup deletes the winning cached blob.

5. **Extend event-bus, transcript, projection, and recovery contracts.**
   Completion criterion: resource parts survive Redis encoding, request admission, primary projection,
   transcript persistence, recovery, and lineage comparison while historical blob parts remain valid.

6. **Change Discord ingress composition.**
   Completion criterion: every visible attachment emits one structured resource part, model text never
   gets extracted attachment contents, and ingestion performs no complete-file buffering.

7. **Wire capability-based resource access.**
   Completion criterion: an exact retained URI resolves from any request or session, malformed and
   unknown URIs fail, copied text does not create an automatic provider file part, and access alone does
   not extend retention.

8. **Add bounded provider materialization.**
   Completion criterion: supported images and PDFs at most 25 MiB become byte-backed parts, Claude Code
   receives images only, large and unsupported media remain marker-only with guidance, and provider
   messages contain no signed URLs.

9. **Add `read(resource://...)`.**
   Completion criterion: text, image, PDF, unsupported binary, inline limits, cancellation, restricted
   mode, and hashline rejection pass focused tests without complete large-resource decoding.

10. **Add `grep(resource://...)`.**
    Completion criterion: text search matches existing modes, binary resources fail clearly, temporary
    files are always removed, terminal integrity is checked, and no complete JavaScript string is made.

11. **Add `resource.materialize`.**
    Completion criterion: mixed batches preserve order, safe names are exclusive, conflicts return
    `already_exists`, operation-owned failed files are removed, restricted paths remain private, and
    actual bytes enforce resource and call limits.

12. **Adapt deprecated `attachment.download`.**
    Completion criterion: it is hidden and marked deprecated, current resource calls keep the legacy
    envelope without signed URLs, and historical blob-only calls retain their existing path.

13. **Remove superseded ingress attachment paths.**
    Completion criterion: current Discord ingress no longer injects extracted text, persists signed
    attachment URLs, or creates a second request-owned attachment representation beside a resource
    part.

14. **Update documentation and architecture registrations.**
    Completion criterion: `PROJECT.md`, `MIGRATIONS.md`, tool prompts, stable callable tests, and required
    persistence, blob-open, and exception registrations describe the shipped behavior.

15. **Run final verification.**
    Completion criterion: every focused check, workspace typecheck, architecture check, lint, and
    `bun run check` passes against the final worktree.

## Verification

Run:

1. Focused URI, record, origin, resource-part, and migration codec tests.
2. Focused SQLite registration, retention-reference, cache-CAS, and final-reference cleanup tests.
3. Focused Discord origin resolution and signed-URL redaction tests.
4. Focused bounded streaming tests with unknown, incorrect, short, and oversized lengths.
5. Focused request composition, event-bus, transcript, recovery, and lineage tests.
6. Focused exact-URI access across requests and sessions, malformed and unknown URI failures, text
   cross-reference behavior, and retention non-extension tests.
7. Provider composition tests for supported image, supported PDF, Claude Code image-only, unsupported
   media, 25 MiB boundaries, unknown size, cache failure, and origin failure.
8. Focused resource `read` and `grep` tests.
9. Focused materialization tests for mixed batches, duplicate filenames, existing destinations,
   cancellation, cleanup, restricted paths, and actual-byte batch accounting.
10. Deprecated `attachment.download` tests for current resources and historical blob-backed messages.
11. Core workspace typecheck.
12. Event-bus workspace typecheck.
13. Architecture and lint-rule tests required by SQLite, BlobStore, persistence, and exception changes.
14. `bun run lint`.
15. `bun run check`.

Large-file tests use injected small limits and chunked synthetic streams. They verify bounded behavior
without a 512 MiB fixture or a large normal-suite allocation.

## Acceptance criteria

The work is complete when:

- every Core Discord ingress attachment receives a stable resource URI for its canonical origin;
- structured resource parts survive request delivery, persistence, projection, and recovery;
- images and PDFs no larger than 25 MiB retain direct byte-backed model parts when supported;
- Claude Code receives resource images only;
- larger and unsupported resources remain visible through metadata and materialization guidance;
- text and binary attachment contents do not enter prompts automatically;
- no signed source URL, Discord attachment ID, or BlobStore object ID appears in durable messages,
  model markers, tool results, or ordinary logs;
- pull-through downloads and cache writes enforce the 512 MiB actual-byte limit while streaming;
- model composition never reads more than 25 MiB for one resource into a complete byte array;
- `read` handles resource text, images, and PDFs directly within its media limits;
- `grep` handles resource text only without one complete JavaScript string;
- `resource.materialize` writes selected resources into the cwd allowed by request filesystem policy
  and reports every item;
- materialization never overwrites or renames around an existing file;
- one item failure does not skip later non-cancelled items;
- possession of an exact retained URI grants access without a request, session, or surface check;
- ordinary text can cross-reference a URI without creating provider file parts or extending retention;
- resource metadata is deleted after its final retained transcript or projection reference;
- cached blobs share resource lifetime and are deleted on final-reference cleanup;
- `attachment.download` remains callable, hidden, deprecated, and compatible with historical blob
  messages; and
- every focused and repository check passes.

## Non-goals

This plan does not add:

- Mini Lilac resource support;
- automatic structured resource propagation to native or workflow subagents;
- a resource catalog, glob search, fuzzy search, or directory resources;
- arbitrary HTTP, `file://`, or `data:` downloads;
- provider URL-backed file parts;
- Claude Code PDF or arbitrary-file support;
- provider upload APIs, automatic resizing, media conversion, or oversized-file retries;
- automatic transformation of a large resource before provider consumption;
- resource editing or archive extraction;
- public materialization destination selection;
- overwrite, numbered filename selection, or atomic rename during materialization;
- a cache TTL, global cache byte budget, LRU policy, cache worker, queue, or recovery journal;
- new resource configuration fields; or
- historical attachment rewrites.
