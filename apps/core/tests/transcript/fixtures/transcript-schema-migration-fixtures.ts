import { Database } from "bun:sqlite";
import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import type { ModelMessage } from "ai";
import SuperJSON from "superjson";

export const SUPPORTED_TRANSCRIPT_SCHEMA_STARTS = [1, 2, 3, 4, 5] as const;

export type SupportedTranscriptSchemaStart = (typeof SUPPORTED_TRANSCRIPT_SCHEMA_STARTS)[number];

export type TranscriptSchemaMigrationFixture = {
  readonly requestId: string;
  readonly messages: ModelMessage[];
  readonly messagesJson: string;
  readonly contextMetaJson: string;
  readonly providerStateJson: string;
};

function createV2Layout(database: Database): void {
  database.exec(`
    CREATE TABLE core_owned_blobs (
      sha256 TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE core_surface_projections (
      request_client TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      projection_format_version INTEGER NOT NULL,
      canonical_messages_json TEXT NOT NULL,
      source_facts_json TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      PRIMARY KEY (
        request_client, surface_id, session_id, message_id, projection_format_version
      )
    );
    CREATE TABLE core_surface_projection_blobs (
      request_client TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      projection_format_version INTEGER NOT NULL,
      position INTEGER NOT NULL,
      blob_sha256 TEXT NOT NULL REFERENCES core_owned_blobs(sha256) ON DELETE RESTRICT,
      PRIMARY KEY (
        request_client, surface_id, session_id, message_id, projection_format_version, position
      ),
      FOREIGN KEY (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) REFERENCES core_surface_projections (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) ON DELETE CASCADE
    );
    CREATE TABLE core_primary_lineage_manifests (
      request_id TEXT PRIMARY KEY REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
      lineage_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE core_lineage_projection_refs (
      request_id TEXT NOT NULL REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      atom_index INTEGER NOT NULL,
      request_client TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      projection_format_version INTEGER NOT NULL,
      PRIMARY KEY (request_id, segment_index, atom_index),
      FOREIGN KEY (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) REFERENCES core_surface_projections (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) ON DELETE RESTRICT
    );
    CREATE TABLE core_lineage_request_refs (
      request_id TEXT NOT NULL REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      atom_index INTEGER NOT NULL,
      reference_kind TEXT NOT NULL,
      referenced_request_id TEXT NOT NULL REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
      transcript_digest TEXT NOT NULL,
      PRIMARY KEY (request_id, segment_index, atom_index)
    );
    CREATE INDEX idx_core_lineage_request_refs_referenced
      ON core_lineage_request_refs(referenced_request_id);
  `);
}

function createV3Layout(database: Database): void {
  database.exec(`
    CREATE TABLE core_lineage_request_alias_refs (
      request_id TEXT NOT NULL REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      alias_index INTEGER NOT NULL,
      referenced_request_id TEXT NOT NULL REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
      request_client TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      projection_format_version INTEGER NOT NULL,
      PRIMARY KEY (request_id, segment_index, alias_index),
      FOREIGN KEY (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) REFERENCES core_surface_projections (
        request_client, surface_id, session_id, message_id, projection_format_version
      ) ON DELETE RESTRICT
    );
    CREATE INDEX idx_core_lineage_request_alias_refs_projection
      ON core_lineage_request_alias_refs(
        request_client, surface_id, session_id, message_id, projection_format_version
      );
  `);
}

function createV4Layout(database: Database): void {
  database.exec(`
    CREATE TABLE core_primary_claude_bindings (
      request_client TEXT NOT NULL CHECK (request_client = 'discord'),
      session_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
      provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
      lineage_version INTEGER NOT NULL CHECK (lineage_version = 1),
      atom_count INTEGER NOT NULL CHECK (atom_count > 0),
      prefix_digest TEXT NOT NULL,
      canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count > 0),
      execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
      execution_scope_hash TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      native_cwd TEXT NOT NULL,
      native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
      native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
      native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
      last_model_specifier TEXT NOT NULL,
      last_reasoning TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (request_client, session_id, provider_id)
    );
    CREATE TABLE core_primary_claude_attempts (
      product TEXT NOT NULL CHECK (product = 'core-primary'),
      request_client TEXT NOT NULL CHECK (request_client = 'discord'),
      session_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      source_lineage_version INTEGER CHECK (source_lineage_version = 1),
      source_atom_count INTEGER CHECK (source_atom_count > 0),
      source_prefix_digest TEXT,
      source_canonical_message_count INTEGER CHECK (source_canonical_message_count > 0),
      execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
      execution_scope_hash TEXT NOT NULL,
      request_id TEXT NOT NULL,
      attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
      candidate_session_id TEXT NOT NULL,
      source_session_id TEXT,
      expected_binding_revision INTEGER CHECK (expected_binding_revision > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
      terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
      terminal_lineage_version INTEGER CHECK (terminal_lineage_version = 1),
      terminal_atom_count INTEGER CHECK (terminal_atom_count > 0),
      terminal_prefix_digest TEXT,
      terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count > 0),
      native_cwd TEXT,
      native_last_modified REAL CHECK (native_last_modified >= 0),
      native_context_tokens INTEGER CHECK (native_context_tokens >= 0),
      native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0),
      last_model_specifier TEXT,
      last_reasoning TEXT,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index)
    );
    CREATE INDEX idx_core_primary_claude_attempts_owner
      ON core_primary_claude_attempts(request_client, session_id, provider_id, updated_ts);
  `);
}

export function createTranscriptSchemaMigrationFixture(
  dbPath: string,
  startVersion: SupportedTranscriptSchemaStart,
): TranscriptSchemaMigrationFixture {
  const database = new Database(dbPath, { create: true, strict: true });
  const requestId = `schema-v${startVersion}`;
  const messages = [
    { role: "user", content: `fixture input v${startVersion}` },
    { role: "assistant", content: `fixture output v${startVersion}` },
  ] satisfies ModelMessage[];
  const messagesJson = SuperJSON.stringify(messages);
  const contextMetaJson = SuperJSON.stringify({ type: "compaction", formatVersion: 1 });
  const providerStateJson = SuperJSON.stringify({
    lastFamily: "ai-sdk",
    containsCrossFamilyTurns: false,
  });

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE transcript_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_ts INTEGER NOT NULL
      );
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL,
        context_meta_json TEXT,
        provider_state_json TEXT,
        stable_named_request_client TEXT${startVersion >= 2 ? ", transcript_digest TEXT" : ""}
      );
    `);
    for (let version = 1; version <= startVersion; version += 1) {
      database.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        version,
        version,
      ]);
    }
    database.run(
      `INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text,
        messages_json, context_meta_json, provider_state_json, stable_named_request_client
        ${startVersion >= 2 ? ", transcript_digest" : ""}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${startVersion >= 2 ? ", ?" : ""})`,
      [
        requestId,
        `session-v${startVersion}`,
        "discord",
        1,
        2,
        "fixture-model",
        `fixture final v${startVersion}`,
        messagesJson,
        contextMetaJson,
        providerStateJson,
        null,
        ...(startVersion >= 2 ? [hashCanonicalMessagesV1(messages).hash] : []),
      ],
    );
    if (startVersion >= 2) createV2Layout(database);
    if (startVersion >= 3) createV3Layout(database);
    if (startVersion >= 4) createV4Layout(database);
    if (startVersion >= 5) {
      database.run(
        `ALTER TABLE core_primary_claude_bindings
         ADD COLUMN terminal_request_id TEXT
           REFERENCES request_transcripts(request_id) ON DELETE CASCADE`,
      );
    }
  } finally {
    database.close();
  }

  return { requestId, messages, messagesJson, contextMetaJson, providerStateJson };
}
