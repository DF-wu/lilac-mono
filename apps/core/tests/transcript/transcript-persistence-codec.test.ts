import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SuperJSON from "superjson";
import type { ModelMessage } from "ai";

import {
  coreLineageManifestRowCodecCases,
  coreSurfaceProjectionRowCodecCases,
  decodeCoreLineageManifestRow,
  decodeCoreSurfaceProjectionRow,
  decodeTranscriptCompactionContext,
  decodeTranscriptMessages,
  decodeTranscriptProviderState,
  decodeTranscriptRow,
  transcriptCompactionContextCodecCases,
  transcriptProviderStateCodecCases,
  transcriptRowCodecCases,
} from "../../src/transcript/transcript-persistence-codec";
import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";
import {
  createTranscriptSchemaMigrationFixture,
  SUPPORTED_TRANSCRIPT_SCHEMA_STARTS,
} from "./fixtures/transcript-schema-migration-fixtures";

function expectCatalog(
  catalog: Readonly<
    Record<
      string,
      { readonly input: object; readonly outcome: "ok" | "error"; readonly provenance?: string }
    >
  >,
  decode: (input: never) => {
    readonly status: "ok" | "error";
    readonly value?: { readonly provenance: string };
  },
): void {
  for (const fixture of Object.values(catalog)) {
    const decoded = decode(fixture.input as never);
    expect(decoded.status).toBe(fixture.outcome);
    if (decoded.status === "ok") expect(decoded.value?.provenance).toBe(fixture.provenance);
  }
}

describe("transcript persistence codecs", () => {
  it("covers current, legacy, missing, unsupported, malformed, and corrupt transcript values", () => {
    expectCatalog(transcriptCompactionContextCodecCases, decodeTranscriptCompactionContext);
    expectCatalog(transcriptProviderStateCodecCases, decodeTranscriptProviderState);
    expectCatalog(transcriptRowCodecCases, decodeTranscriptRow);
    expectCatalog(coreSurfaceProjectionRowCodecCases, decodeCoreSurfaceProjectionRow);
    expectCatalog(coreLineageManifestRowCodecCases, decodeCoreLineageManifestRow);
  });

  for (const startVersion of SUPPORTED_TRANSCRIPT_SCHEMA_STARTS) {
    it(`migrates an independent schema-v${startVersion} fixture without rewriting serialized fields on read`, async () => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), `lilac-transcript-schema-v${startVersion}-`),
      );
      const dbPath = path.join(dir, "transcripts.db");
      const fixture = createTranscriptSchemaMigrationFixture(dbPath, startVersion);
      const store = new SqliteTranscriptStore(dbPath);
      const inspection = new Database(dbPath, { strict: true });
      try {
        const afterMigration = inspection
          .query<
            {
              messages_json: string;
              context_meta_json: string;
              provider_state_json: string;
            },
            [string]
          >(
            `SELECT messages_json, context_meta_json, provider_state_json
             FROM request_transcripts WHERE request_id = ?`,
          )
          .get(fixture.requestId);
        expect(afterMigration).toEqual({
          messages_json: fixture.messagesJson,
          context_meta_json: fixture.contextMetaJson,
          provider_state_json: fixture.providerStateJson,
        });

        const read = store.getRequestTranscript({ requestId: fixture.requestId });
        expect(read.status).toBe("ok");
        if (read.status === "ok") {
          expect(read.value?.messages).toEqual(fixture.messages);
          expect(read.value?.contextMeta).toEqual({ type: "compaction", formatVersion: 1 });
          expect(read.value?.providerState).toEqual({
            lastFamily: "ai-sdk",
            containsCrossFamilyTurns: false,
          });
        }

        const afterRead = inspection
          .query<
            {
              messages_json: string;
              context_meta_json: string;
              provider_state_json: string;
            },
            [string]
          >(
            `SELECT messages_json, context_meta_json, provider_state_json
             FROM request_transcripts WHERE request_id = ?`,
          )
          .get(fixture.requestId);
        expect(afterRead).toEqual(afterMigration);
        expect(
          inspection
            .query("SELECT version FROM transcript_schema_migrations ORDER BY version")
            .all(),
        ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
      } finally {
        inspection.close();
        store.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("decodes literal plain JSON and SuperJSON message bytes", () => {
    const messages = [{ role: "assistant", content: "literal" }] satisfies ModelMessage[];
    const plain = '[{"role":"assistant","content":"literal"}]';
    const superJson = SuperJSON.stringify(messages);
    for (const raw of [plain, superJson]) {
      const decoded = decodeTranscriptMessages({ raw, schemaVersion: 5, recordId: "literal" });
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") expect(decoded.value.value).toEqual(messages);
    }
  });

  it("returns malformed metadata as an error without rewriting persisted bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-codec-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    expect(
      store.saveRequestTranscript({
        requestId: "no-rewrite",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "stored" }],
      }).status,
    ).toBe("ok");
    const db = new Database(dbPath);
    const malformed = '{"type":"compaction"';
    db.run("UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = ?", [
      malformed,
      "no-rewrite",
    ]);

    const read = store.getRequestTranscript({ requestId: "no-rewrite" });
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.error._tag).toBe("MalformedSerialization");
    const persisted = db
      .query<{ context_meta_json: string }, [string]>(
        "SELECT context_meta_json FROM request_transcripts WHERE request_id = ?",
      )
      .get("no-rewrite");
    expect(persisted?.context_meta_json).toBe(malformed);

    db.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
