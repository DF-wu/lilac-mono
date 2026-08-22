# Core Unified Blob Storage Clean Break

## Status

This is the active implementation plan for replacing every Core-managed opaque byte store with one
blob storage module. The runtime will support one configured blob adapter backed by either the
local filesystem or an S3-compatible adapter.

This is a clean break. New runtime code reads and writes only versioned blob handles and references. It
does not decode legacy `dataBase64`, inline persisted bytes, Core-owned SQLite BLOBs, or legacy artifact
content files. Operators migrate durable state with a separate offline task before starting the new
runtime.

## Goals

The implementation must:

- keep Core-managed opaque binary content out of Redis streams, Redis dead-letter evidence, and Core
  domain databases;
- replace every Core-managed opaque blob store with one storage module;
- make Discord request composition and generated attachment delivery reference-native;
- replace Core-owned blob bytes with references while preserving ownership metadata and retention;
- support local filesystem and S3-compatible storage through one small interface;
- let Core publish blob handles after a bounded reservation write without waiting for content upload;
- resolve pending uploads with a fixed timeout before forming an agent transcript;
- keep generated output blobs through an arbitrarily long active request and the full sliding Redis
  replay window that follows its final output;
- support durable and absolute-expiry retention without making callers implement cleanup;
- preserve integrity with SHA-256 and byte-length verification;
- keep references independent of the physical adapter;
- provide one offline, manually invoked migration task; and
- fail closed when runtime state is legacy, partially migrated, corrupt, or expired where durability is
  required.

## Scope

This plan changes Core and the workspace packages Core uses. It does not change Mini Lilac.

### Managed blobs

The new module owns opaque bytes whose lifecycle Core controls. The migration inventory and final
architecture checks cover at least:

- request attachments currently serialized into `cmd.request` model messages;
- generated attachment output currently published as `evt.agent.output.response.binary.dataBase64`;
- Discord attachment downloads retained for request composition;
- inline binary and data-URL content in persisted Core transcripts, projections, checkpoints, and
  replay state;
- `core_owned_blobs.bytes` and every Core surface projection that refers to those rows;
- tool-result artifact content used by Core;
- workflow snapshot and result value artifact content;
- Anthropic fallback media cache content;
- opaque source evidence retained by the managed Redis dead-letter path; and
- any other persisted file, database column, or Redis field discovered during implementation whose
  value is opaque application-owned bytes rather than structured domain data or a user-owned file.

Each owning domain keeps its policy and structured metadata. MIME type, filename, request identity,
scope authority, quota accounting, encryption metadata, workflow identity, and presentation metadata do
not move into the blob storage interface.

### Exclusions

The implementation does not turn every byte buffer or filesystem write into a blob. These remain
outside the module:

- user-visible files materialized by `attachment.download`, generated media tools, MCP result
  materialization, or filesystem tools;
- source files, Git objects, worktrees, workspace history, plugin files, and workflow definition files;
- credentials, tokens, PEM files, encryption keys, and other secret configuration;
- vector embeddings and other structured database values that use a SQLite BLOB representation;
- in-memory bytes while downloading, hashing, encrypting, decrypting, inspecting, or sending content;
- transport cryptographic fields such as nonces and authentication tags when they protect metadata
  rather than carry application blob content;
- third-party URLs that Lilac deliberately stores as external references and does not own; and
- Mini Lilac, including its databases, tool-result artifact files, runtime composition, configuration,
  migrations, and tests.

The migration inventory must classify ambiguous cases explicitly. It must not leave another
Core-managed opaque byte store merely because it was not one of the original attachment paths.

## Product decisions

1. There is one active blob adapter per Core data set.
2. A runtime selects exactly one local or S3-compatible adapter in configuration.
3. Blob references do not contain an adapter kind, filesystem path, bucket, prefix, endpoint, signed
   URL, or credentials.
4. The storage module does not keep a logical-store UUID, adapter registry, or database binding. An
   adapter may keep a private format-version marker needed to read its own layout.
5. Local-to-S3 or S3-to-local moves are offline whole-store copies. They preserve object IDs, verify the
   destination against durable references, and switch configuration only after the copy completes.
6. The runtime does not support simultaneous read stores, write-store routing, hot tiering, rolling
   adapter migrations, or per-reference adapter registries.
7. Every normal `startUpload` creates an independently owned object across domain owners, even when
   another domain has the same digest. The implementation may deduplicate physical storage privately
   only when it preserves independent deletion and expiry behavior. The workflow domain may keep one
   object for one content-addressed artifact identity and relate multiple workflow rows to that
   domain-owned object.
8. Domains never share deletion responsibility. If two domains need independent retention, each domain
   owns a separate object. Relations within one domain follow that domain's final-reference rule.
9. TTL is fixed when an object is created. It is either durable or has one absolute `expiresAt` value.
   Changing retention creates a new object and reference.
10. Logical expiry is exact. Physical reclamation is eventual and may use adapter maintenance plus an
    S3 lifecycle rule as a secondary safeguard.
11. Migration is operator-run and offline. Runtime startup never performs legacy blob migration.
12. Legacy Redis work is drained or abandoned under its old versioned namespace. The migration task
    does not translate queued requests, output events, pending entries, or old dead-letter payloads.
13. Core request delivery, not blob storage, owns durable acceptance records, terminal tombstones, and
    the ordering between Redis redelivery and request-blob deletion.
14. Every `cmd.request` carries a producer-generated `requestDeliveryId`. Redis stream IDs remain
    transport metadata and are never the ownership key.
15. A Core request-delivery record is the durable source for publication while `prepared` and the
    durable source for queue or run admission while `accepted`.
16. Generated output blobs are durable while their request can still publish output. Once output
    production closes, the final output `XADD` returns the Redis stream's resulting expiry and the
    request-terminalization transaction assigns every output blob a deletion deadline no earlier than
    that expiry.
17. The output deletion deadline is Core lifecycle metadata, not a mutation of `BlobRefV1.expiresAt`.
    This preserves immutable references. A failed lifecycle update or delete leaves a durable orphan
    rather than expiring replayable content early.

## Module and seam

Add a new workspace package, `packages/blob-storage`, as Core's only external seam for managed opaque
bytes. Callers depend on its reference codec and storage interface. The local and S3 implementations are
adapters behind that seam. Adapter filesystem layout, S3 request construction, temporary objects,
format markers, hashing, integrity checks, expiry layout, and exception translation remain inside the
module.

The public contract is intentionally small:

```ts
type BlobRefV1 = {
  readonly version: 1;
  readonly objectId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly expiresAt?: number;
};

type BlobHandleV1 = {
  readonly version: 1;
  readonly objectId: string;
};

type BlobRetention =
  | { readonly kind: "durable" }
  | { readonly kind: "expires"; readonly expiresAt: number };

type BlobSource = Uint8Array | ReadableStream<Uint8Array>;

type BlobReadComplete = {
  readonly sha256: string;
  readonly byteLength: number;
};

type BlobReadTerminalError =
  | BlobReadCancelled
  | BlobReadSourceFailure
  | BlobIntegrityFailure;

type BlobRead = {
  readonly ref: BlobRefV1;
  readonly stream: ReadableStream<Uint8Array>;
  readonly completion: Promise<Result<BlobReadComplete, BlobReadTerminalError>>;
};

type BlobUpload = {
  readonly handle: BlobHandleV1;
  readonly completion: Promise<Result<BlobRefV1, BlobWriteError>>;
};

type BlobCloseSummary = {
  readonly completedUploads: number;
  readonly interruptedUploads: number;
};

type BlobStore = {
  startUpload(input: {
    readonly source: BlobSource;
    readonly retention: BlobRetention;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<Result<BlobUpload, BlobUploadStartError>>;

  resolve(
    handle: BlobHandleV1,
    options: { readonly timeoutMs: number },
  ): Promise<Result<BlobRefV1, BlobResolveError>>;

  open(ref: BlobRefV1): Promise<Result<BlobRead, BlobReadError>>;

  delete(
    target: BlobHandleV1 | BlobRefV1,
  ): Promise<Result<"deleted" | "absent", BlobDeleteError>>;

  maintain(input?: {
    readonly now?: number;
    readonly limit?: number;
  }): Promise<Result<BlobMaintenanceSummary, BlobMaintenanceError>>;

  close(input: {
    readonly deadlineAtMs: number;
  }): Promise<Result<BlobCloseSummary, BlobCloseError>>;
};
```

The exact TypeScript names may follow package conventions, but the interface and invariants may not grow
adapter-specific branches. Runtime callers do not list objects, construct object IDs, inspect adapter
metadata, refresh TTL, or request signed URLs.

The module also exports strict versioned codecs for `BlobHandleV1` and `BlobRefV1`. Wire boundaries use
handles for pending uploads. Durable content records use resolved references. Neither boundary uses
structural casts.

## Reference contract

- `startUpload` first writes a small durable reservation and returns `BlobHandleV1` without waiting for
  the source stream to finish. Content transfer, hashing, and final publication continue in the
  background.
- The producer-local `BlobUpload.completion` reports the final reference or typed upload failure. A
  different Core process uses `resolve` against the durable reservation instead of depending on that
  promise.
- `resolve` waits for the reservation to become ready, fail, or reach the caller's timeout. It returns a
  typed timeout and does not itself decide whether the caller retries or deletes the upload. Core request
  admission treats its fixed timeout as terminal.
- A ready handle always resolves to the same immutable `BlobRefV1`. A terminally failed or deleted
  handle never becomes ready later.
- Deleting a pending handle fences final publication before removing partial content and technical
  upload state. The uploader may change `pending` to `ready` only while the same reservation generation
  is still current, so the deletion fence wins over a late local write or S3 multipart completion.
- `objectId` is an opaque, non-secret, versioned locator generated by the storage module.
- `sha256` is lowercase hexadecimal SHA-256 of the exact stored byte sequence.
- `byteLength` is the exact stored byte count and is a non-negative safe integer.
- `expiresAt` is an integer Unix epoch time in milliseconds. Its absence means durable retention.
- A reference is adapter-neutral and remains valid after a verified whole-store adapter migration.
- A reference does not grant public access. All adapters remain private and callers use `open` through
  trusted runtime composition.
- An expired reference is unavailable even if physical bytes still exist.
- The outer `open` Result verifies reference shape, logical retention, the adapter layout, and available
  technical metadata. It means that a readable source was established. It does not claim that streamed
  content has passed digest verification.
- Every successful `open` includes a `completion` promise. Once the stream reaches EOF, fails, or is
  canceled, that promise settles exactly once. EOF with the expected SHA-256 and byte length returns
  `Result.ok(BlobReadComplete)`. A source failure, cancellation, short read, long read, digest mismatch,
  or metadata mismatch returns a typed terminal error.
- Callers must consume or cancel the stream and then settle `completion`. They cannot report a successful
  read based only on the outer Result.
- A caller that would cause an irreversible side effect before terminal verification must spool or
  buffer through the Core materialization helper, await a successful `completion`, and only then invoke
  the provider or surface operation.
- A digest, byte-length, object-metadata, or layout mismatch is corruption, not absence.
- `delete` is idempotent. Deleting an absent object succeeds with `"absent"`.
- The module supervises every background upload started by one store instance. `close` rejects new
  uploads and immediately starts cancellation and a durable terminal-fence write for every still-pending
  reservation. It does not give those uploads another settle period because Core has already drained or
  stopped their producers.
- `startUpload` and the beginning of `close` are linearized inside the module. An upload either joins the
  set that close immediately cancels and fences or fails with the typed closed-store error; it cannot
  escape both outcomes.
- Fence writes start without waiting for source cancellation, local I/O cancellation, or S3 multipart
  aborts to settle. Mandatory fences take priority over removal of temporary or remote physical bytes;
  cleanup uses only the time remaining after fences are durable.
- A successful `close` means every supervised upload either completed or has a durable terminal fence
  that prevents later ready publication. Each interrupted `BlobUpload.completion` and cross-process
  `resolve` returns the typed shutdown interruption. `close` is idempotent.
- If an adapter operation cannot be stopped immediately, its late completion remains behind the
  terminal fence and may only remove physical leftovers. It cannot make the handle ready. `close`
  returns by `deadlineAtMs` with a typed deadline or adapter failure if it cannot persist that safety
  state; an error never claims the store drained safely.

Domain metadata such as MIME type and filename sits next to the reference in the owning event or database
record:

```ts
type StoredAttachment = {
  readonly blob: BlobRefV1;
  readonly mimeType: string;
  readonly filename?: string;
};
```

## Result and failure contract

All expected failures use `better-result` `Result` values with domain-owned `TaggedError` variants. The
storage package distinguishes at least:

- invalid configuration, input, reference, or retention;
- invalid or unsupported adapter layout;
- upload reservation failure, terminal upload failure, resolve timeout, or shutdown interruption;
- object absence or expiry;
- object integrity or metadata corruption;
- stream cancellation, incomplete consumption, or a terminal read failure;
- adapter unavailability, authentication, authorization, throttling, timeout, and I/O failure; and
- a primary operation plus cleanup failure when both outcomes matter.

Filesystem, Bun S3 client, stream, and crypto exceptions are translated once at the adapter seam.
Unexpected defects remain `Panic` values and are not converted into ordinary storage failures. Callers
settle tagged failures at the existing request, surface, workflow, cache, or startup policy boundary.
Persisted or wire Results use boundary-owned codecs when a Result itself crosses that boundary.

## Adapter bookkeeping

The storage module does not know which Core database or Redis delivery owns an object. It does not keep a
logical-store identity, per-object adapter field, reference registry, or database binding. Core config
selects one adapter, and domain records store adapter-neutral references.

An adapter may keep a private format-version marker under its root or prefix so it can reject an
unsupported physical layout. That marker identifies a layout version, not a deployment or data set. If
an operator points Core at the wrong valid bucket, prefix, or directory, referenced reads fail as absent
or corrupt. The offline copy procedure verifies every durable reference before configuration switches.
The pending, ready, interrupted, failed, and deleted reservation states are technical upload facts only.
They never contain a request delivery ID, Redis stream ID, admission state, terminal tombstone, or domain
owner.

## Configuration

Add the top-level `blobStorage` configuration directly to config version 2. A v2 config may omit the
field and receive the local default rooted below the runtime data directory, or configure the local or
S3-compatible adapter explicitly.

Config version 1 keeps its frozen input shape. Universal parsing gives v1 the same effective local
default as an omitted v2 `blobStorage` field, so existing v1 deployments do not break. A v1 config cannot
set blob storage options, choose S3, or override the local root. The operator must move to config v2 to
do that. This plan does not add config version 3.

The configurable v2 shapes are:

```yaml
configVersion: 2

blobStorage:
  kind: local
  root: /var/lib/lilac/blobs
```

```yaml
configVersion: 2

blobStorage:
  kind: s3
  bucket: lilac
  prefix: production/blobs
  endpoint: https://s3.example.com
  region: us-east-1
  accessKeyIdEnv: LILAC_S3_ACCESS_KEY_ID
  secretAccessKeyEnv: LILAC_S3_SECRET_ACCESS_KEY
  # sessionTokenEnv: LILAC_S3_SESSION_TOKEN
  # forcePathStyle: true
```

Credentials are read only from the named environment variables. Literal credentials are rejected by the
config codec. The bucket must already exist. Runtime startup does not create buckets or modify bucket
lifecycle policy.

The S3-compatible adapter uses Bun's installed `S3Client`. It does not add the AWS SDK or another S3
client dependency.

## Adapter behavior

### Local filesystem

The local adapter:

- uses a private root with directories no broader than mode `0700` and files mode `0600`;
- rejects symlink traversal, non-file objects, escaped roots, and unsafe object IDs;
- durably writes a bounded pending reservation before returning a handle;
- streams writes to a same-filesystem temporary object while computing SHA-256 and byte length;
- syncs and atomically renames completed objects before marking the handle ready;
- stores ready or terminal-failure state so another Core process can resolve the handle;
- immediately starts a durable interrupted fence for each pending reservation during close while
  concurrently canceling its supervised source read;
- stores bounded technical metadata needed for integrity and expiry next to the object;
- never exposes its physical path through a blob reference; and
- removes expired objects in bounded maintenance batches without fixed waits.

### S3 compatible

The S3 adapter:

- keeps every object private and never publishes a presigned URL;
- supports custom endpoint, region, bucket, prefix, session token, and path-style addressing;
- writes a small pending reservation before returning a handle;
- computes SHA-256 and byte length locally rather than treating ETag as a content digest;
- records bounded technical metadata needed to verify the object against its reference;
- uses opaque versioned keys with separate durable and expiry-partitioned layouts;
- marks the handle ready only after the completed object and its integrity metadata are visible;
- stores terminal upload failure state so another Core process does not wait until timeout for a known
  failure;
- immediately starts a durable interrupted fence for each pending reservation during close while
  concurrently aborting its supervised multipart work;
- uses a reservation-generation check so a delete or shutdown fence wins over late multipart
  completion, then removes any completed object that lost that check;
- resolves ambiguous writes by inspecting the exact generated key and metadata;
- paginates maintenance work and deletion; and
- treats provider lifecycle policies as physical cleanup assistance, not as logical TTL enforcement.

The adapters produce the same `BlobRefV1` values for a store copied key-for-key. Adapter-specific metadata
must therefore be reproducible during a whole-store copy.

## Retention and ownership

The storage module owns upload state, byte integrity, and physical expiry. The domain that stores a
handle or reference owns the reason the object exists.

- Durable references remain readable until their owner removes them.
- Expiring references become unavailable exactly at `expiresAt`.
- Maintenance eventually deletes expired content and technical metadata.
- Read paths may opportunistically delete an expired object, but availability does not depend on that
  cleanup succeeding.
- Domain quota, scope, and retention policies remain in the owning module.
- The store has no global reference-count table and no generic ownership database.
- Durable orphan cleanup is an explicit audit or operator task. Runtime write ordering makes an orphan
  safer than a live reference to missing content.

Asynchronous request publication uses reservation first, content completion later:

1. `startUpload` durably reserves an object ID and starts background transfer.
2. Core commits the handle and complete request envelope in a `prepared` request-delivery record.
3. Core publishes that prepared envelope with its producer-generated `requestDeliveryId` without waiting
   for content completion.
4. The consumer resolves the handles and verifies their final references before durable admission.
5. If preparing or publishing fails conclusively, Core deletes the pending handles. An ambiguous publish
   is retried idempotently from the prepared record.

Other durable domain writes resolve and verify an upload before committing `BlobRefV1` in their owning
database. They never persist a pending handle where the domain contract requires ready content.

Delete ordering is reference first, object second:

1. Remove or replace the owning reference transactionally.
2. Delete the now-unowned object.
3. Treat an ambiguous or failed delete as an orphan cleanup problem.

No runtime operation deletes an object while a committed owner still refers to it.

## Reference-native messages and canonical identity

AI SDK `ModelMessage` is an in-process provider contract, not the persisted or Redis contract. Add
separate strict codecs for Redis messages with `BlobHandleV1` and durable messages with `BlobRefV1`.
Resolution happens at Core request admission. Hydration into AI SDK file parts happens only immediately
before a provider, surface upload, inspection, or user-file materialization needs bytes.

The new request and output shapes are conceptually:

```ts
type BusFilePartV2 = {
  readonly type: "blob";
  readonly blob: BlobHandleV1;
  readonly mediaType: string;
  readonly filename?: string;
};

type StoredFilePartV1 = {
  readonly type: "blob";
  readonly blob: BlobRefV1;
  readonly mediaType: string;
  readonly filename?: string;
};

type AgentBinaryOutputV2 = {
  readonly blob: BlobHandleV1;
  readonly mimeType: string;
  readonly filename?: string;
};
```

The implementation must:

- add required producer-generated `requestDeliveryId` to the versioned `cmd.request` contract;
- replace `cmd.request.messages` with the strict handle-bearing bus-message codec;
- replace `evt.agent.output.response.binary.dataBase64` with the versioned handle shape;
- reject base64, `Uint8Array`, `ArrayBuffer`, and managed data URLs at Redis decoding boundaries;
- perform only structural request and lineage decoding at the Redis boundary because pending handles do
  not yet have content digests;
- resolve every request handle with one package-owned 60-second overall timeout for that delivery;
- rebuild reference-bearing messages and run content-dependent lineage validation after resolution but
  before the prepared-to-accepted transaction;
- persist only resolved references in the accepted work item and canonical transcript;
- hydrate resolved request blobs at the agent-runner/provider seam;
- resolve output handles and hydrate their resolved references at the Discord or other surface upload
  seam;
- enforce existing per-part and total media limits while streaming or before provider invocation; and
- avoid logging references together with sensitive domain metadata when existing logging policy would
  hide the original payload.

Canonical message hashing runs only after handles resolve. It must normalize byte-backed and
reference-backed binary content to one content
atom containing SHA-256, byte length, media type, and relevant filename semantics. `objectId` and
`expiresAt` do not affect content identity. The Core transcript digest version and lineage codecs are
bumped. The manual migrator computes the same atom from legacy bytes and rebuilds affected lineage and
projection digests rather than preserving a hash of a base64 serialization.

## Domain integration

### Redis event bus

- Redis event values contain structured event data and blob handles or resolved references, never
  managed opaque bytes, base64 payloads, or data URLs.
- New request and output contracts use new versioned physical namespaces. Old stream entries and groups
  remain inert and are never decoded by the new runtime.
- The producer generates a UUID `requestDeliveryId` before storage reservation or Redis publication. The
  strict request wire contract carries it. Redis assigns its own stream ID, but that ID never owns Core
  request state.
- Core persists a `prepared` request-delivery record keyed by `requestDeliveryId`. It contains the
  complete metadata-only request envelope and durable request-owned blob handles needed to publish or
  republish the request.
- Request publication is idempotent by `requestDeliveryId`. One Redis atomic operation creates or
  observes the single stream entry associated with that ID and returns its Redis stream ID. A crash after
  `XADD` but before Core records publication is recovered by replaying `prepared`; Redis returns the
  existing entry rather than adding a duplicate.
- Core records the returned Redis stream ID in the prepared record before releasing the Redis
  idempotency entry. A failed Core write retains that entry for replay. A failed later cleanup can leave
  one small orphaned Redis entry, but cannot create a duplicate request or lose admitted work.
- Core startup republishes prepared records whose publication outcome is absent or ambiguous. A known
  publication failure terminalizes the record and deletes its handles.
- Every request handle has durable request-owned retention. The actual upload continues in the
  background after publication and remains owned while the request is prepared, retrying, parked,
  accepted, or running.
- On delivery, Core loads the record by `requestDeliveryId` before resolving a handle. A `terminal`
  record returns `commit` without hydration. An `accepted` record also returns `commit` because that
  record is already the durable work source.
- For a `prepared` record, Core waits up to 60 seconds overall for its handles to resolve. A timeout or
  terminal upload failure produces the explicit request failure, changes the record to `terminal`,
  fences and deletes its handles, and returns `commit`.
- After every handle resolves successfully, one SQLite transaction replaces the handles with resolved
  references, stores all queue or run admission facts, and changes `prepared` to `accepted`. The
  accepted record itself is the durable work item. In-memory session queues are projections of accepted
  records, not the source of truth.
- Startup resumes every accepted nonterminal record. A crash after the accepted transaction but before
  in-memory enqueue therefore cannot lose the request. The first delivery returns `commit` only after
  this transaction succeeds.
- A failure to commit accepted admission returns a retry or park disposition, leaves the record prepared,
  and retains its handles. No accepted marker can exist without durable work.
- Every redelivery checks the durable record before resolving or opening a blob. Accepted and terminal
  states skip hydration and duplicate application.
- Terminal success, failure, cancellation, or explicit abandonment transactionally changes the record
  to `terminal` and, when the request produced output, records the output `deleteAfter` deadline. It does
  this before detaching request-input handles or resolved references. Physical deletion of request-input
  blobs happens only after that transaction commits. A concurrent redelivery therefore observes either
  `accepted` or `terminal` and never needs the deleted input blob. Output lifecycle records remain until
  their later replay-deadline cleanup completes.
- The event bus reports a successful Redis commit to the Core request-delivery module after
  `managed.commit` succeeds. A terminal tombstone is eligible for metadata cleanup only after that
  transport-committed fact is durable. If this post-commit observation is lost, the small tombstone is
  retained; blob safety does not depend on cleaning it up.
- Parking for a non-upload intake failure is not terminal and does not shorten request blob lifetime.
- Each output `XADD` returns both its stream ID and a conservative absolute replay deadline calculated
  from the Redis server clock after resetting the stream's sliding 24-hour expiry.
- Core creates durable request-owned output lifecycle records before publishing their handles. Output
  objects remain durable while the request is active, regardless of how long it runs or how often later
  output extends the stream lifetime.
- After output production closes and the final output write succeeds, the request-terminalization
  transaction records that write's replay deadline as `deleteAfter` for every output object owned by
  the request. No later output write is allowed for a terminal request. Request-delivery maintenance
  deletes those objects only at or after the deadline.
- A crash after the final `XADD` but before terminalization leaves the request accepted and every output
  object durable. Recovery reads the output stream's absolute Redis expiry before retrying the terminal
  transaction. If the stream is gone, cleanup may start immediately; if Redis is unavailable or the
  expiry is uncertain, the object stays durable. Safety never depends on guessing a deadline from the
  blob's reservation time.
- Consumers do not delete an output object merely because one delivery completed.
- Managed dead-letter records keep bounded structured metadata in Redis. Any retained source evidence is
  an expiring blob reference. Dead-letter finalization never copies source blob bytes into Redis.
- The active Redis delivery reliability plan's controlled-reference evidence uses this package and its
  reference codec.

### Discord request composition

- The Discord bridge downloads an attachment directly into the blob store rather than base64-encoding
  it for the bus.
- Discord attachment metadata rows gain a nullable strict blob reference and cache timestamp. They never
  gain a byte column or persisted signed CDN URL.
- A usable cached reference avoids a second Discord download. An absent, expired, or integrity-failed
  expiring cache entry is treated as a cache miss and replaced.
- Discord download-cache objects use fixed expiring retention. The initial policy is 24 hours and is
  package-owned rather than a new user setting.
- The 24-hour cache reference is never published as the lifetime authority for `cmd.request`. Before
  publication, request composition starts a durable request-owned upload, records its handle in the
  prepared request-delivery record, and publishes that handle without waiting for upload completion.
- On a cache hit, the background request upload copies from the verified cache object. On a cache miss,
  the Discord response stream feeds the durable request upload and may be teed into the expiring cache.
  Cache population never delays request publication after both storage reservations exist.
- If Core needs the attachment durably for a transcript or surface projection, Core creates its own
  separately owned durable object before committing its reference. Request delivery and transcript
  retention do not share deletion ownership.
- Pruning a Discord attachment row attempts to delete its cache object. TTL remains the crash-safe
  cleanup mechanism.

### Generated attachments and surface output

- Attachment tools and tool-server attachment operations start durable background uploads, attach their
  handles to the active request's output lifecycle record, and publish the handles after reservation.
- Surface subscribers resolve handles with a bounded timeout and then use the verified Core
  materialization helper. They do not begin an irreversible upload until resolution and the read's
  terminal outcome confirm digest and byte length.
- Request terminalization applies the Core-owned replay deadline after the final output `XADD`; it does
  not change an already resolved blob reference. This keeps early output readable throughout an
  arbitrarily long active request and for the complete sliding replay window afterward.
- User-requested downloaded or generated destination files remain ordinary user-visible files after
  materialization.
- Missing, expired, or corrupt output content produces the existing typed surface delivery failure. The
  consumer does not look for legacy `dataBase64`.

### Core transcripts and owned blobs

- Transcript persistence accepts only the versioned stored-message representation.
- Inline managed bytes and data URLs are forbidden in current transcript, checkpoint, projection, and
  lineage records.
- Replace `core_owned_blobs` byte storage with reference-only ownership metadata. The new schema stores a
  stable owner ID, strict `BlobRefV1`, media type, filename, timestamps, and existing projection
  relationships.
- Do not key ownership solely by SHA-256. Equal content may have separate lifecycle owners.
- Admission verifies the referenced object before committing a projection.
- Replay and projection read the domain metadata and use verified materialization only at the final
  consumer seam.
- Retention removes the database ownership relation before deleting the object.
- Transcript blob metrics count referenced byte lengths from metadata. They do not scan or load content.

The transcript persistence schema moves from 5 to 6. Runtime schema 6 creation contains no legacy byte
table. Runtime startup rejects an existing schema 5 database with the exact manual migration command.
Only the offline migrator knows how to decode and transform schema 5 blob state.

### Tool-result artifacts

- `ToolResultArtifactStore` keeps its URI, scope checks, request and tool metadata, quotas, paging,
  encryption policy, and public interface semantics.
- Content persistence delegates to `BlobStore`. Existing content encryption occurs before
  `startUpload`, and decryption occurs after `open`, so the generic store remains an opaque-byte module.
- Tool artifact metadata changes to a new strict version that contains `BlobRefV1` instead of a content
  path. Metadata itself remains structured domain state.
- Artifact TTL and the blob reference expiry are identical.
- Scope quota and eviction remove metadata ownership before deleting content.
- Core composes its tool-result artifact store with the blob store.
- The clean-break migration discards legacy tool-result artifacts instead of copying them. They are
  transient and can be recreated by rerunning the producing tool call.

### Workflow value artifacts

- Workflow snapshot and result values retain their current canonical JSON codec, size checks, content
  identity, and workflow error contract.
- Encoded value bytes are stored through `BlobStore` with durable retention.
- Workflow persistence replaces bare artifact IDs with a strict domain reference containing the
  workflow artifact identity and `BlobRefV1`.
- Reads verify both the blob integrity contract and the workflow value codec/content hash.
- Workflow schema 26 is created directly for fresh databases. An existing schema 25 database requires
  the offline blob migration before the runtime will open it.
- The workflow domain owns one durable blob per distinct content-addressed workflow artifact identity.
  Migration copies each distinct artifact once and relates every referencing workflow row to that one
  artifact record. Workflow cleanup deletes the blob only after the final relation to that artifact
  record has been removed.

### Anthropic fallback media cache

- Cache content uses `BlobStore` with the existing six-hour TTL.
- The cache index keeps only cache keys, content metadata, and blob references.
- Missing, expired, or corrupt blobs are ordinary cache misses and may be removed opportunistically.
- The manual migration discards the legacy fallback cache instead of copying it because it is
  reconstructible and short-lived.

### Other discovered managed blobs

Implementation begins with an inventory of Core production paths and the workspace packages they invoke.
Each discovered Core-managed blob must either be routed through `BlobStore` or added to the exclusions
above with an explicit product reason before the plan can finish. A local helper that merely wraps another
private byte directory does not satisfy this requirement.

## Manual migration task

Add one root task:

```text
bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data
```

The operator stops Core before running the command. The command first performs a read-only preflight. It
prints a bounded report containing durable source kinds, record counts, byte totals, target adapter kind,
required free local space when knowable, discarded transient state, and blockers. If preflight succeeds,
the same invocation immediately applies the migration. It does not ask
the operator to run an apply or cleanup mode.

For inspection without mutation, the operator may run:

```text
bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data --dry-run
```

The command:

- accepts only the exact supported legacy Core schemas and metadata versions;
- validates the target adapter configuration and physical layout;
- copies current durable Core transcript, Core-owned, and workflow artifact bytes;
- computes and verifies SHA-256 and byte length before writing each reference;
- creates one workflow-owned blob per distinct content-addressed workflow artifact identity;
- rewrites affected transcript, lineage, projection, and workflow schemas with current
  codecs;
- performs each database rewrite in a transaction after the objects needed by that database verify;
- removes replaced legacy durable byte columns and content files as part of the same invocation;
- discards legacy Core tool-result artifacts and Anthropic fallback cache files instead of migrating
  them;
- does not migrate Discord cache content because new downloads populate those references after cutover;
- does not migrate Redis requests, outputs, pending entries, or dead-letter payloads; and
- reports the source and typed failure, exits nonzero, and leaves Core stopped when any operation fails.

The command is not atomic across the object store and multiple databases, and it adds no migration
recovery subsystem. The operator owns the stop and backup procedure. If migration starts and then fails,
the operator restores the backup before rerunning the command. The runtime opens only when every required
database has the current schema. A later referenced read reports an absent or corrupt object if the
operator configured the wrong otherwise-valid storage location.

The migration output does not print payloads, credentials, signed URLs, or sensitive paths beyond
operator-supplied roots. The migration guide tells the operator that legacy Redis namespaces remain inert
and may be removed separately after any required audit export.

## Runtime startup and cutover

Startup order is:

1. Parse the universal blob storage configuration.
2. Open the adapter and validate its configuration and layout version.
3. Open durable metadata stores without running legacy blob migrations.
4. Verify current schema versions.
5. Initialize domain modules that depend on `BlobStore`.
6. Start bus subscriptions, request intake, scheduled work, and maintenance.

If any legacy or partially migrated state is present, startup stops before external work begins and names
the single migration command. Startup does not offer an apply flag or invoke migration itself. There is
no feature flag, compatibility reader, background copier, dual-write period, or fallback to legacy
storage.

During graceful shutdown, Core stops request ingress and output producers first, then drains agent and
relay work only until an internal settle cutoff that is earlier than the existing hard shutdown
deadline. Core reserves a package-owned cleanup slice; it is not a new configuration option. When work
drains or reaches that cutoff, Core stops consumers that could start another blob operation and
immediately calls `BlobStore.close` with the hard absolute deadline. The store therefore receives real
time for fence persistence and cleanup. A store is composed and closed once by its Core runtime owner;
leaf domains never close it.

The deployment procedure is:

1. Upgrade a v1 configuration to v2 if S3 or an explicit local root is desired. Keep v1 unchanged when
   the inherited local default is sufficient.
2. Stop Core and drain accepted legacy requests and output delivery where possible.
3. Back up the data directory and databases.
4. Run the migration command once.
5. Start Core and verify attachment, transcript, workflow, and artifact reads.

## Failure behavior

- A request attachment reservation or prepared-record write failure prevents request publication.
- A background request upload failure after publication becomes an explicit terminal request failure.
- A 60-second request resolve timeout terminalizes the request without admitting work and fences its
  pending handles before deletion.
- An unavailable transient Discord cache object causes a redownload; a failed redownload prevents
  publication.
- A missing, expired, or corrupt durable transcript or workflow object is an integrity failure and is
  never treated as empty content.
- An unavailable generated output object produces an explicit surface delivery failure.
- Failure to persist an output replay deadline leaves the output blob durable, reports the lifecycle
  failure, and lets startup recover the terminal request. It never substitutes a reservation-time
  expiry.
- A transient cache or expired tool artifact keeps its existing unavailable semantics.
- A request-delivery record lookup or acceptance write failure parks the Redis entry and retains every
  request-owned blob. The handler does not hydrate or delete through an uncertain record state.
- A post-commit observation failure cannot undo a successful Redis acknowledgment. It returns a typed
  Core bookkeeping failure to the observer boundary and leaves the durable tombstone in place for safe
  later reconciliation or retention.
- S3 authentication, authorization, configuration, and layout failures stop startup when the store is
  required.
- Maintenance failure is reported and retried by the existing scheduling policy. It does not change
  logical expiry.
- A database-reference commit failure after upload resolution triggers best-effort object deletion and
  returns the domain write failure.
- A physical delete failure after reference removal reports an orphan without restoring the reference.
- Blob-store close reports a typed shutdown failure if it cannot durably fence a pending upload. Core
  preserves that cleanup failure without hiding an earlier `Panic` and does not report the store as
  safely drained.
- Reaching the hard shutdown deadline while a fence write is incomplete returns the typed close-deadline
  failure. Physical cleanup may remain for maintenance, but a successful close is impossible without
  every mandatory fence.
- No error path serializes fallback bytes into Redis or SQLite.

## Security and privacy

- Blob storage is private. The module does not create public ACLs or signed URLs.
- Object IDs are unguessable for normal writes but are not authorization tokens.
- S3 credentials stay in environment variables and never enter config output, references, logs, Redis,
  migration output, or databases.
- Existing tool-artifact encryption and scope authorization remain in their domain module.
- Storage logs contain operation, adapter kind, bounded object identity, byte counts, retention class,
  latency, and tagged failures. They do not contain payloads or sensitive filenames.
- Local permissions and symlink checks preserve the current artifact-store safety guarantees.
- Migration reports and errors identify records without printing content.

## Architecture enforcement

Update architecture registration and syntax checks so that:

- production modules obtain `BlobStore` through composition rather than constructing adapters locally;
- only `packages/blob-storage` imports Bun S3 storage operations for managed blobs;
- current event-bus schemas cannot contain managed `dataBase64`, raw byte arrays, or data URLs;
- current Core persistence codecs cannot store managed inline bytes;
- domain databases cannot add managed byte columns as substitutes for blob references;
- `packages/blob-storage` cannot import request, delivery, Redis, transcript, workflow, or surface
  ownership modules;
- only the Core runtime owner closes its composed blob store; leaf domains cannot own adapter shutdown;
- adapter exceptions are captured at the storage seam and expected failures remain Results;
- provider and surface hydration is localized to named materialization modules; and
- legacy blob decoders are imported only by the manual migration task.

Tests exercise the storage module through its external interface. Adapter-specific tests remain inside
the package. Old tests that assert private filesystem layouts or inline bus base64 are replaced by
reference-level tests.

## Implementation phases

### Phase 1: storage contract and adapters

- Add `packages/blob-storage`, the reference codec, tagged failures, the local adapter, the S3
  adapter, and an in-memory test adapter.
- Implement durable and expiring layouts, streaming hash/length verification, idempotent deletion,
  supervised background uploads, bounded close, bounded maintenance, and adapter layout validation.
- Add `blobStorage` to config v2 parsing and give config v1 the same universal local default without
  adding it to the frozen v1 input shape.

### Phase 2: composition and message contracts

- Compose one blob store into Core, its surface bridge, and its tool server.
- Add handle-bearing bus-message codecs, reference-bearing persistence codecs, and
  resolution/hydration/materialization modules.
- Version the request and binary-output bus shapes and physical namespaces.
- Return the conservative Redis-server replay deadline from each output `XADD` operation.
- Add producer-generated request delivery IDs and idempotent Redis request publication by that ID.
- Add the transport post-commit observation needed to mark a Core request-delivery record acknowledged
  after Redis commit succeeds.
- Update canonical hashing and lineage versions.

### Phase 3: domain persistence

- Replace Discord download caching with expiring references.
- Add durable Core request-delivery `prepared`, `accepted`, and `terminal` records keyed by
  producer-generated request delivery ID.
- Make prepared records the recoverable publication source and accepted records the recoverable queue or
  run work source.
- Add request-owned output lifecycle records that remain durable while active and receive the final
  output stream replay deadline at terminalization.
- Replace Core transcript and owned-blob bytes with durable references.
- Move tool-result content behind the blob storage seam while retaining domain policy and encryption.
- Move workflow value content behind the seam and update workflow persistence.
- Move Anthropic fallback cache content behind the seam.
- Route dead-letter source evidence through expiring references.

### Phase 4: manual migration and clean cut

- Add the single preflight-and-apply command plus its optional `--dry-run` mode.
- Add exact legacy readers that are reachable only from the migration task.
- Add runtime startup rejection and operator guidance.
- Document Redis draining and abandonment behavior.

### Phase 5: enforcement and removal

- Remove runtime legacy decoders, `dataBase64` event fields, Core-owned byte operations, and private blob
  directories.
- Add architecture checks for the new seam.
- Complete the Core managed-blob inventory and resolve every finding.
- Update durable architecture and migration documentation.

## Expected files

Primary additions and changes include:

- a new `packages/blob-storage/` workspace package and focused tests;
- `packages/utils/core-config.ts`, `packages/utils/core-config/`, the example Core config, and config tests;
- `packages/event-bus/lilac-spec.ts`, Redis bus codecs/namespaces, dead-letter integration, and tests;
- Core runtime composition under `apps/core/src/runtime/`;
- Discord request composition, attachment metadata persistence, bus subscription, and attachment tools
  under `apps/core/src/surface/`, `apps/core/src/tools/`, and `apps/core/src/tool-server/`;
- Core transcript store and persistence codecs under `apps/core/src/transcript/`;
- Core request-delivery persistence and bus-agent-runner admission under
  `apps/core/src/surface/bridge/`;
- Core tool-result artifact integration under `apps/core/src/artifacts/`, with changes to
  `packages/tool-results/` only where the Core-facing storage seam requires them;
- workflow artifact store, codecs, migrations, and consumers under `apps/core/src/workflow/`;
- Anthropic fallback media cache code under `apps/core/src/surface/bridge/bus-agent-runner/`;
- a new migration entry point under `scripts/` and root `package.json` tasks;
- architecture manifests and checks under `scripts/architecture/`;
- `PROJECT.md`, `MIGRATIONS.md`, and `docs/core-config-migrations.md`; and
- focused Core, event-bus, storage, artifact, workflow, and migration tests.

The exact file list may shrink or move as implementation reveals current ownership, but the seam and
scope above do not change.

## Test matrix

### Storage interface

- `startUpload` returns a durable handle after reservation while a controlled source remains blocked;
- producer-local completion and cross-process `resolve` produce the same final reference;
- `resolve` waits for a progressing upload, succeeds when it becomes ready, and returns a typed timeout
  when the configured wait elapses;
- deleting a pending handle prevents its background uploader from publishing a ready object;
- `close` stops new uploads and immediately starts cancellation and fencing for every pending upload;
- a concurrent `startUpload` and `close` either supervises and settles that upload or returns the typed
  closed-store error;
- with a blocked source and a deliberately slow fence write, invoking `close` starts cancellation and
  the fence write before the controlled hard deadline; releasing the fence before that deadline durably
  marks the reservation interrupted and settles local completion and cross-process resolution with the
  typed shutdown error;
- if that controlled fence remains blocked through the hard deadline, `close` returns the typed
  close-deadline failure without claiming a safe drain or using a fixed wait;
- repeated `close` calls are idempotent and never restart a canceled upload;
- byte and streaming uploads produce exact digest, byte length, retention, and readable content;
- expected digest or byte-length mismatch publishes no reference;
- malformed references and retention values fail with tagged errors;
- durable and expiring objects use independent lifecycle semantics;
- logical expiry applies before physical cleanup;
- partial and cancelled reads release resources;
- delete is idempotent;
- ambiguous write inspection returns the one valid object or a tagged failure;
- corrupt content or technical metadata fails integrity checks;
- outer `open` success never substitutes for the typed terminal read outcome;
- successful EOF settles `completion` with the verified digest and byte length;
- source failure, cancellation, incomplete consumption, and integrity mismatch settle `completion` with
  the expected tagged error;
- maintenance is bounded, paginated, restartable, and independent of fixed waits; and
- two equal payloads can be deleted or expired independently.

### Local adapter

- temporary writes are never returned as committed objects;
- restart cleanup handles abandoned temporary objects;
- atomic rename, permissions, symlink rejection, root containment, and layout-version checks are
  enforced; and
- copying every object key to another adapter preserves references.

### S3 adapter

- focused integration tests run against an S3-compatible test server;
- custom endpoint, region, prefix, credentials, session token, and path-style behavior work;
- objects remain private;
- ETag is never accepted as SHA-256;
- paginated expiry cleanup works across partitions;
- throttling, timeouts, authorization failures, missing objects, and ambiguous PUT responses map to the
  correct tagged errors;
- a delete or shutdown fence that wins against a controlled late multipart completion keeps the handle
  terminal and eventually removes the physical object; and
- a key-for-key local/S3 copy preserves references.

### Redis and surfaces

- current Redis request and output events contain handles and no managed base64 or bytes;
- `cmd.request` carries a producer-generated `requestDeliveryId` and pending blob handles rather than a
  Redis stream ID or unresolved content metadata;
- current consumers reject legacy event shapes;
- new physical namespaces ignore old events and groups;
- a controlled attachment upload can remain blocked while the prepared request is published with its
  handle;
- a crash after `prepared` commit but before Redis publication is recovered by startup publication;
- a crash after Redis `XADD` but before publication recording retries the same `requestDeliveryId` and
  observes the original stream entry rather than creating another;
- delivery while upload is pending blocks for at most 60 seconds, terminalizes on timeout, and admits no
  work;
- delivery unblocks and admits work when every upload becomes ready before the 60-second timeout;
- content-dependent lineage validation runs after handles resolve and before accepted admission;
- a crash before the prepared-to-accepted transaction leaves the request prepared and redeliverable;
- a crash after the accepted transaction but before in-memory enqueue resumes the durable accepted work
  at startup without requiring blob hydration or Redis redelivery;
- Discord cache hit, cache miss, expiry, redownload, and integrity failure follow the defined policy;
- a durable request-owned blob remains readable while `cmd.request` is parked beyond 24 hours and is
  deleted only after terminalization or explicit abandonment;
- when handler acceptance succeeds but Redis commit fails, terminalization persists a tombstone before
  deleting the request blob, and redelivery observes that tombstone, skips `BlobStore.open`, does not
  apply the request again, and commits the pending Redis entry;
- an accepted but nonterminal redelivery also skips hydration and duplicate application;
- a terminal tombstone is not eligible for metadata cleanup until successful Redis commit has been
  observed durably;
- Core creates its own durable owner before committing a transcript projection;
- an output produced more than 24 hours before a long-running request finishes remains readable while
  the request is active;
- each output `XADD` returns a Redis-server replay deadline, and after the final write every output blob
  remains readable through at least that deadline before request-owned cleanup deletes it;
- a crash before the terminal output deadline is recorded leaves the output durable and is recovered
  without early deletion; and
- dead-letter evidence uses an expiring reference without copying bytes into Redis.

### Persistence and artifacts

- current transcript, checkpoint, projection, lineage, workflow, tool-artifact, and cache codecs accept
  references and reject inline managed bytes;
- canonical content identity is stable across legacy-byte migration and current references;
- missing durable objects fail closed;
- transcript and workflow deletion preserve safe reference-first ordering;
- tool-artifact encryption, scope checks, paging, TTL, quota, eviction, and unavailable behavior remain
  unchanged at their public interface;
- workflow rows sharing one content-addressed artifact keep one workflow-owned blob until their final
  relation disappears; and
- the fallback cache treats missing or expired content as a miss.

### Migration

- `--dry-run` is read-only;
- the normal command preflights and applies in one invocation;
- runtime startup rejects each supported legacy state with the exact command;
- a complete migration preserves every durable payload byte-for-byte;
- invalid target adapter configuration or layout fails before mutation;
- transient tool-result and fallback-cache state is discarded;
- a failure reports the source and typed reason without claiming automatic resume or rollback; and
- a partial failure leaves Core unable to start until the operator restores a backup and reruns the
  command.

## Validation

Implementation must run:

- focused `packages/blob-storage` tests and typecheck;
- local adapter tests on the supported host platforms;
- S3-compatible integration tests;
- focused event-bus, Core surface, transcript, tool-result, workflow, and migration tests;
- architecture checks for Result handling, persistence codecs, imports, and the blob-storage seam;
- config drift, versioning, unknown-key, and template tests;
- the root typecheck and full repository test suite at the completed boundary;
- lint, format, and `git diff --check`; and
- an independent correctness review focused on missing-live-object prevention, expiry, terminal read
  settlement, supervised upload shutdown, output replay retention, redelivery-aware request cleanup,
  migration failure reporting, Redis payload exclusion, and unsupported multi-store claims.

## Exit criteria

1. No current Core Redis event or dead-letter evidence stores Core-managed opaque bytes or base64
   content.
2. No current Core domain database stores Core-managed opaque attachment or artifact bytes.
3. No private Core runtime directory remains an alternative managed blob content store.
4. Discord request composition and generated output use `BlobHandleV1` on Redis and resolve to
   `BlobRefV1` before durable content admission or irreversible materialization.
5. Core transcripts, projections, and owned blobs persist references only and hydrate at the final seam.
6. Tool-result, workflow, fallback-cache, and dead-letter content use the shared storage module.
7. Local and S3-compatible adapters pass the same storage-interface contract tests.
8. Durable and expiring retention behave as specified, including logical expiry before cleanup.
9. References contain no adapter details and remain valid after a verified whole-store adapter copy.
10. The storage package contains no logical-store UUID, adapter registry, or domain database binding.
11. Runtime startup has no legacy reader, dual write, or automatic blob migration path.
12. One normal offline command preflights, copies and verifies durable bytes, rewrites schemas, removes
    replaced legacy storage, and reports completion or failure. `--dry-run` is the only alternate mode.
13. Legacy Redis work is never reinterpreted by the new runtime.
14. Every Core-owned opaque blob location is migrated or explicitly documented as an exclusion.
15. `PROJECT.md`, `MIGRATIONS.md`, and the config migration guide describe the shipped contracts and
    operator cutover.
16. Request-blob deletion cannot make a pending Redis redelivery hydrate a dead reference. Durable
    accepted and terminal records short-circuit redelivery before blob access.
17. Prepared records recover publication, accepted records recover admitted work, and crash tests prove
    both sides of each state transition without relying on Redis-assigned IDs.
18. Request publication waits for durable handle reservation and the prepared record, not content upload.
    Admission waits for handle resolution with the fixed timeout and never writes an accepted record for
    unresolved content.
19. Output blobs remain durable throughout an active request and are not deleted until the Redis-server
    replay deadline returned by the final output write has passed.
20. `BlobStore.close` starts cancellation and mandatory fence writes immediately, before its hard
    deadline. A successful close leaves no supervised upload able to publish `ready`; a durable
    interrupted or deleted fence wins over late local and S3 completion.
