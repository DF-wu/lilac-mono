import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  advanceHistoryProviderState,
  classifyHistoryProviderFamily,
  hashCanonicalMessagesV1,
  hashExecutionScopeV1,
  preparePlainTextReplayForTarget,
  type ExecutionScopeHashInputV1,
  type TextReplayTarget,
} from "../session-continuation";

const TARGET: TextReplayTarget = {
  providerFamily: "claude-code",
  modelSpecifier: "claude-code/claude-sonnet-4-6",
  maxToolInputChars: 1_000,
  maxToolResultChars: 1_000,
};

describe("session continuation provider contracts", () => {
  it("classifies only the resolved exact provider type", () => {
    expect(classifyHistoryProviderFamily({ type: "claude-code" })).toBe("claude-code");
    expect(classifyHistoryProviderFamily({ type: "anthropic" })).toBe("ai-sdk");
    expect(classifyHistoryProviderFamily({ type: "CLAUDE-CODE" })).toBe("ai-sdk");
    const misleadingDescriptor = {
      type: "openai-compatible",
      id: "claude-code",
      model: "claude-code/claude-sonnet-4-6",
    };
    expect(classifyHistoryProviderFamily(misleadingDescriptor)).toBe("ai-sdk");
  });

  it("advances pure and mixed-family state monotonically", () => {
    const first = advanceHistoryProviderState("empty-history", "ai-sdk");
    const same = advanceHistoryProviderState(first, "ai-sdk");
    const crossed = advanceHistoryProviderState(same, "claude-code");
    expect(first).toEqual({ lastFamily: "ai-sdk", containsCrossFamilyTurns: false });
    expect(same).toEqual({ lastFamily: "ai-sdk", containsCrossFamilyTurns: false });
    expect(crossed).toEqual({ lastFamily: "claude-code", containsCrossFamilyTurns: true });
    expect(advanceHistoryProviderState(crossed, "ai-sdk")).toEqual({
      lastFamily: "ai-sdk",
      containsCrossFamilyTurns: true,
    });
    expect(advanceHistoryProviderState("unknown-populated-history", "claude-code")).toEqual({
      lastFamily: "claude-code",
      containsCrossFamilyTurns: true,
    });
  });
});

describe("canonical head hash v1", () => {
  const fixture = (): ModelMessage[] => [
    { role: "system", content: "policy", providerOptions: { x: { cache: "drop" } } },
    {
      role: "user",
      content: [
        { type: "text", text: "hello", providerOptions: { x: { debug: true } } },
        {
          type: "file",
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          filename: "plot.png",
          providerOptions: { x: { id: "drop" } },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "secret", providerOptions: { x: { signature: "drop" } } },
        { type: "text", text: "checking" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { z: 1, a: { b: 2 } },
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_file",
          output: { type: "error-json", value: { z: 2, a: 1 } },
        },
        { type: "custom", kind: "openai.compaction", providerOptions: { x: { raw: "drop" } } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "bash",
          output: { type: "execution-denied", reason: "blocked" },
        },
      ],
    },
  ];

  it("matches the literal canonical serialization and hash fixture", () => {
    const result = hashCanonicalMessagesV1(fixture());
    expect(result.serialized).toBe(
      '{"messages":[{"content":[{"text":"policy","type":"text"}],"role":"system"},{"content":[{"text":"hello","type":"text"},{"filename":"plot.png","identity":{"algorithm":"sha256","digest":"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81","kind":"content"},"mediaType":"image/png","type":"file"}],"role":"user"},{"content":[{"text":"checking","type":"text"},{"input":{"entries":[{"key":"a","value":{"entries":[{"key":"b","value":{"type":"number","value":2}}],"type":"object"}},{"key":"z","value":{"type":"number","value":1}}],"type":"object"},"providerExecuted":true,"toolCallId":"call-1","toolName":"read_file","type":"tool-call"},{"outcome":"error","output":{"entries":[{"key":"a","value":{"type":"number","value":1}},{"key":"z","value":{"type":"number","value":2}}],"type":"object"},"providerExecuted":false,"toolCallId":"call-1","toolName":"read_file","type":"tool-result"}],"role":"assistant"},{"content":[{"outcome":"denied","output":{"type":"string","value":"blocked"},"providerExecuted":false,"toolCallId":"call-2","toolName":"bash","type":"tool-result"}],"role":"tool"}],"version":1}',
    );
    expect(result.hash).toBe("2fb314c246f6996e4783647edef2a9ff5110bd0406f4b9ec76a9f9c5424b5d25");
    expect(result.serialized).not.toContain("secret");
    expect(result.serialized).not.toContain("drop");
    expect(result.serialized).not.toContain("1,2,3");
  });

  it("is invariant to object key order and decorations, but sensitive to semantics", () => {
    const left: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "run",
            input: { b: 2, a: 1 },
            providerOptions: { test: { cache: "left" } },
          },
        ],
      },
    ];
    const right: ModelMessage[] = [
      {
        role: "assistant",
        providerOptions: { test: { requestId: "ignored" } },
        content: [
          {
            type: "reasoning",
            text: "ignored",
          },
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "run",
            input: { a: 1, b: 2 },
          },
        ],
      },
    ];
    expect(hashCanonicalMessagesV1(left).hash).toBe(hashCanonicalMessagesV1(right).hash);
    right[0] = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName: "run", input: { a: 2, b: 2 } }],
    };
    expect(hashCanonicalMessagesV1(left).hash).not.toBe(hashCanonicalMessagesV1(right).hash);

    const png: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: "YWJj", mediaType: "image/png", filename: "a" }],
      },
    ];
    const jpeg: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: "YWJj", mediaType: "image/jpeg", filename: "a" }],
      },
    ];
    expect(hashCanonicalMessagesV1(png).hash).not.toBe(hashCanonicalMessagesV1(jpeg).hash);
    expect(hashCanonicalMessagesV1(png).hash).not.toBe(
      hashCanonicalMessagesV1([
        {
          role: "user",
          content: [{ type: "file", data: "ZGVm", mediaType: "image/png", filename: "a" }],
        },
      ]).hash,
    );
    expect(hashCanonicalMessagesV1(png).projection).toEqual(
      hashCanonicalMessagesV1([
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([97, 98, 99]),
              mediaType: "image/png",
              filename: "a",
            },
          ],
        },
      ]).projection,
    );
    expect(hashCanonicalMessagesV1(png).hash).not.toBe(
      hashCanonicalMessagesV1([
        {
          role: "user",
          content: [{ type: "file", data: "YWJj", mediaType: "image/png", filename: "b" }],
        },
      ]).hash,
    );
  });

  it("includes approval identity and prevents swapped approval attribution collisions", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "x", toolName: "one", input: {} },
        { type: "tool-call", toolCallId: "y", toolName: "two", input: {} },
        { type: "tool-approval-request", approvalId: "approval-x", toolCallId: "x" },
        { type: "tool-approval-request", approvalId: "approval-y", toolCallId: "y" },
      ],
    };
    const left: ModelMessage[] = [
      assistant,
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "approval-x", approved: true },
          { type: "tool-approval-response", approvalId: "approval-y", approved: false },
        ],
      },
    ];
    const right: ModelMessage[] = [
      assistant,
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "approval-y", approved: true },
          { type: "tool-approval-response", approvalId: "approval-x", approved: false },
        ],
      },
    ];
    const leftResult = hashCanonicalMessagesV1(left);
    expect(leftResult.hash).not.toBe(hashCanonicalMessagesV1(right).hash);
    expect(leftResult.serialized).toContain('"approvalId":"approval-x"');
    expect(leftResult.serialized).toContain('"approvalId":"approval-y"');
  });

  it("keeps provider references distinct from raw file content", () => {
    const providerReference = { openai: "file-1" };
    const referenceMessage: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: providerReference, mediaType: "application/pdf" }],
      },
    ];
    const rawContentMessage: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: Buffer.from(JSON.stringify(providerReference)).toString("base64"),
            mediaType: "application/pdf",
          },
        ],
      },
    ];

    const reference = hashCanonicalMessagesV1(referenceMessage);
    expect(reference.hash).not.toBe(hashCanonicalMessagesV1(rawContentMessage).hash);
    expect(reference.serialized).toContain('"kind":"reference"');
  });

  it("keeps tool-result file IDs distinct from inline file data", () => {
    const resultWith = (
      item:
        | { readonly type: "file-id"; readonly fileId: string; readonly mediaType: string }
        | { readonly type: "file-data"; readonly data: string; readonly mediaType: string },
    ): ModelMessage[] => [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "file",
            toolName: "read_file",
            output: { type: "content", value: [item] },
          },
        ],
      },
    ];
    const fileId = hashCanonicalMessagesV1(
      resultWith({ type: "file-id", fileId: "YWJj", mediaType: "application/pdf" }),
    );
    const fileData = hashCanonicalMessagesV1(
      resultWith({ type: "file-data", data: "YWJj", mediaType: "application/pdf" }),
    );

    expect(fileId.hash).not.toBe(fileData.hash);
    expect(fileId.serialized).toContain('"value":"reference"');
    expect(fileData.serialized).toContain('"value":"content"');
  });

  it("hashes repeated references by JSON value and cannot collide with literal marker objects", () => {
    const shared = { value: 1 };
    const aliased: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "run",
            input: { a: shared, b: shared },
          },
        ],
      },
    ];
    const persistedShape: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "run",
            input: { a: { value: 1 }, b: { value: 1 } },
          },
        ],
      },
    ];
    const literalMarker: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "run",
            input: { a: { value: 1 }, b: { $ref: "$.a" } },
          },
        ],
      },
    ];
    expect(hashCanonicalMessagesV1(aliased).hash).toBe(
      hashCanonicalMessagesV1(persistedShape).hash,
    );
    expect(hashCanonicalMessagesV1(aliased).hash).not.toBe(
      hashCanonicalMessagesV1(literalMarker).hash,
    );

    const specialKey: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "run",
            input: Object.fromEntries([["__proto__", { value: 1 }]]),
          },
        ],
      },
    ];
    expect(hashCanonicalMessagesV1(specialKey).hash).not.toBe(
      hashCanonicalMessagesV1([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call", toolName: "run", input: {} }],
        },
      ]).hash,
    );
    expect(hashCanonicalMessagesV1(specialKey).serialized).toContain('"key":"__proto__"');
  });

  it("fails closed for non-JSON canonical tool values", () => {
    const invalid: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "run",
            input: { invalid: undefined },
          },
        ],
      },
    ];
    expect(() => hashCanonicalMessagesV1(invalid)).toThrow();
  });
});

describe("execution scope hash v1", () => {
  const scope: ExecutionScopeHashInputV1 = {
    canonicalCwd: "/srv/lilac/project",
    providerIdentity: "provider:claude-local",
    nativeStorageNamespaceIdentity: "home:/srv/lilac/.claude",
    nativeExecutableConfigIdentity: "claude:/usr/bin/claude:config-v2",
    profile: "coding",
    safetyMode: "confirm-writes",
    effectiveAuthorityFingerprint: "auth:abc123",
    systemPolicyFingerprint: "policy:def456",
    effectiveToolMcpAuthorityFingerprint: "tools:789abc",
  };

  it("matches the literal scope serialization and hash fixture", () => {
    const result = hashExecutionScopeV1(scope);
    expect(result.serialized).toBe(
      '{"scope":{"canonicalCwd":"/srv/lilac/project","effectiveAuthorityFingerprint":"auth:abc123","effectiveToolMcpAuthorityFingerprint":"tools:789abc","nativeExecutableConfigIdentity":"claude:/usr/bin/claude:config-v2","nativeStorageNamespaceIdentity":"home:/srv/lilac/.claude","profile":"coding","providerIdentity":"provider:claude-local","safetyMode":"confirm-writes","systemPolicyFingerprint":"policy:def456"},"version":1}',
    );
    expect(result.hash).toBe("f01802ed31f8e0b4044b09bea7910078209f1a922dc8c143eb72abbf45b0bb4f");
    expect(hashExecutionScopeV1({ ...scope, profile: "review" }).hash).not.toBe(result.hash);
  });
});

describe("preparePlainTextReplayForTarget", () => {
  it("pairs parallel ordinary results by ID while retaining text placement and call order", () => {
    const replay = preparePlainTextReplayForTarget(
      [
        { role: "user", content: "run both" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Before" },
            { type: "tool-call", toolCallId: "a", toolName: "first", input: { order: 1 } },
            { type: "tool-call", toolCallId: "b", toolName: "second", input: { order: 2 } },
            { type: "text", text: "After" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "b",
              toolName: "second",
              output: { type: "text", value: "B" },
            },
            {
              type: "tool-result",
              toolCallId: "a",
              toolName: "first",
              output: { type: "text", value: "A" },
            },
          ],
        },
      ],
      TARGET,
    );
    expect(replay).toHaveLength(2);
    expect(replay[1]?.role).toBe("assistant");
    const content = replay[1]?.content;
    if (typeof content !== "string") throw new Error("expected text-only replay");
    expect(content.indexOf("Before")).toBeLessThan(content.indexOf('tool="first"'));
    expect(content.indexOf('tool="first"')).toBeLessThan(content.indexOf('tool="second"'));
    expect(content.indexOf('tool="second"')).toBeLessThan(content.indexOf("After"));
    expect(content).toContain('<activity tool="first" outcome="success">');
    expect(content).toContain('<historical-result truncated="false">A</historical-result>');
    expect(content).not.toContain("toolCallId");
  });

  it("lowers sequential inline, error, denial, orphan, duplicate, and provider-executed activity", () => {
    const replay = preparePlainTextReplayForTarget(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "dup",
              toolName: "built_in",
              input: { n: 1 },
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "dup",
              toolName: "built_in",
              output: { type: "error-text", value: "failed" },
            },
            { type: "text", text: "middle" },
            {
              type: "tool-call",
              toolCallId: "dup",
              toolName: "built_in",
              input: { n: 2 },
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "dup",
              toolName: "built_in",
              output: { type: "execution-denied", reason: "no" },
            },
            {
              type: "tool-result",
              toolCallId: "orphan",
              toolName: "orphan",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
      TARGET,
    );
    const text = replay[0]?.content;
    if (typeof text !== "string") throw new Error("expected assistant text");
    expect(text).toContain('<activity tool="built_in" outcome="error">');
    expect(text).toContain('<activity tool="built_in" outcome="denied">');
    expect(text).toContain('<activity tool="orphan" outcome="success">');
    expect(text).toContain("middle");
    expect(replay.every((message) => message.role === "assistant")).toBe(true);
  });

  it("keeps mismatched result names separate instead of silently pairing by ID", () => {
    const replay = preparePlainTextReplayForTarget(
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "same-id", toolName: "expected", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "same-id",
              toolName: "actual",
              output: { type: "text", value: "result" },
            },
          ],
        },
      ],
      TARGET,
    );
    const text = replay[0]?.content;
    if (typeof text !== "string") throw new Error("expected assistant text");
    expect(text).toContain('<activity tool="expected" outcome="unknown">');
    expect(text).toContain('<activity tool="actual" outcome="success">');
    expect(text).not.toContain('<activity tool="expected" outcome="success">');
  });

  it("degrades malformed tool parts without crashing, leaking payloads, or inventing denial", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "malformed-call", toolName: "temporary", input: {} },
          { type: "tool-call", toolCallId: "valid-malformed", toolName: "temporary", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "malformed-call",
            toolName: "result-name",
            output: { type: "text", value: "temporary" },
          },
          {
            type: "tool-approval-response",
            approvalId: "malformed-approval",
            approved: false,
            reason: "not an actual approval after mutation",
          },
        ],
      },
    ];
    const assistant = messages[0];
    const tool = messages[1];
    if (assistant?.role !== "assistant" || typeof assistant.content === "string") {
      throw new Error("expected assistant parts");
    }
    if (tool?.role !== "tool") throw new Error("expected tool parts");
    const call = assistant.content[0];
    const validMalformedCall = assistant.content[1];
    const result = tool.content[0];
    const approval = tool.content[1];
    if (
      call?.type !== "tool-call" ||
      validMalformedCall?.type !== "tool-call" ||
      result?.type !== "tool-result"
    ) {
      throw new Error("expected tool protocol parts");
    }
    if (approval?.type !== "tool-approval-response") throw new Error("expected approval part");
    const circularInput: Record<string, unknown> = { command: "run" };
    circularInput["media"] = {
      type: "image-data",
      data: "CIRCULAR_INPUT_IMAGE_SECRET",
      mediaType: "image/png",
    };
    circularInput["self"] = circularInput;
    Reflect.deleteProperty(call, "toolName");
    Reflect.set(call, "input", circularInput);
    Reflect.deleteProperty(validMalformedCall, "toolName");
    Reflect.set(validMalformedCall, "input", {
      providerMetadata: { vendor: { secret: "INPUT_METADATA_SECRET" } },
      media: {
        type: "image-data",
        data: "INPUT_IMAGE_PAYLOAD_SECRET",
        filename: "input.png",
        mediaType: "image/png",
      },
      safe: "retained input fact",
    });
    Reflect.set(result, "output", {
      type: "future-output",
      data: "FILE_PAYLOAD_SECRET",
      providerOptions: { vendor: { secret: "PROVIDER_OPTION_SECRET" } },
      nested: {
        data: "NESTED_PAYLOAD_SECRET",
        providerMetadata: { vendor: { secret: "PROVIDER_METADATA_SECRET" } },
        safe: "retained fact",
      },
      media: {
        type: "image-data",
        data: "IMAGE_PAYLOAD_SECRET",
        filename: "diagram.png",
        mediaType: "image/png",
      },
    });
    Reflect.set(approval, "type", "future-approval-response");

    const replay = preparePlainTextReplayForTarget(messages, TARGET);
    const text = replay[0]?.content;
    if (typeof text !== "string") throw new Error("expected assistant text");
    expect(text).toContain('<activity tool="unknown" outcome="unknown">');
    expect(text).toContain('<activity tool="result-name" outcome="unknown">');
    expect(text).toContain("Circular value omitted");
    expect(text).toContain("retained fact");
    expect(text).toContain("retained input fact");
    expect(text).toContain("Historical file: name=");
    expect(text).toContain("not an actual approval after mutation");
    expect(text).not.toContain('outcome="denied"');
    expect(text).not.toContain("FILE_PAYLOAD_SECRET");
    expect(text).not.toContain("NESTED_PAYLOAD_SECRET");
    expect(text).not.toContain("IMAGE_PAYLOAD_SECRET");
    expect(text).not.toContain("PROVIDER_OPTION_SECRET");
    expect(text).not.toContain("INPUT_METADATA_SECRET");
    expect(text).not.toContain("INPUT_IMAGE_PAYLOAD_SECRET");
    expect(text).not.toContain("CIRCULAR_INPUT_IMAGE_SECRET");
    expect(text).not.toContain("PROVIDER_METADATA_SECRET");
  });

  it("renders approval denial and orphan approval protocol as historical activity", () => {
    const replay = preparePlainTextReplayForTarget(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "write",
              toolName: "write_file",
              input: { path: "a" },
            },
            {
              type: "tool-approval-request",
              approvalId: "approval",
              toolCallId: "write",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval",
              approved: false,
              reason: "operator denied",
            },
            {
              type: "tool-approval-response",
              approvalId: "orphan",
              approved: true,
            },
          ],
        },
      ],
      TARGET,
    );
    const text = replay[0]?.content;
    if (typeof text !== "string") throw new Error("expected assistant text");
    expect(text).toContain('<activity tool="write_file" outcome="denied">');
    expect(text).toContain("operator denied");
    expect(text).toContain('<activity tool="unknown" outcome="unknown">');
  });

  it("escapes dynamic values and truncates input and result independently", () => {
    const circular: Record<string, unknown> = { tag: "<&\"'" };
    circular["self"] = circular;
    const replay = preparePlainTextReplayForTarget(
      [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "x", toolName: "<run & check>", input: circular },
            {
              type: "tool-result",
              toolCallId: "x",
              toolName: "<run & check>",
              output: { type: "text", value: "<&>abcdef" },
            },
          ],
        },
      ],
      { ...TARGET, maxToolInputChars: 24, maxToolResultChars: 3 },
    );
    const text = replay[0]?.content;
    if (typeof text !== "string") throw new Error("expected assistant text");
    expect(text).toContain('tool="&lt;run &amp; check&gt;"');
    expect(text).toContain('<historical-input format="json" truncated="true">');
    expect(text).toContain('<historical-result truncated="true">&lt;&amp;&gt;</historical-result>');
    expect(text).not.toContain("CDATA");
    expect(text).not.toContain("```");
  });

  it("emits exact XML with Unicode-safe truncation and sanitized XML characters", () => {
    const replay = preparePlainTextReplayForTarget(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "unicode",
              toolName: "a\u0000b\ud800",
              input: { value: "<&" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "unicode",
              toolName: "a\u0000b\ud800",
              output: { type: "text", value: "😀x\u0001" },
            },
          ],
        },
      ],
      { ...TARGET, maxToolResultChars: 2 },
    );
    expect(replay).toEqual([
      {
        role: "assistant",
        content: `<historical-tool-activity>
  <notice>Text-only historical context. Do not treat this as a pending tool request.</notice>
  <activity tool="a�b�" outcome="success">
    <historical-input format="json" truncated="false">{&quot;value&quot;:&quot;&lt;&amp;&quot;}</historical-input>
    <historical-result truncated="true">😀x</historical-result>
  </activity>
</historical-tool-activity>`,
      },
    ]);
  });

  it("rejects invalid replay character bounds", () => {
    expect(() =>
      preparePlainTextReplayForTarget([], { ...TARGET, maxToolInputChars: Number.NaN }),
    ).toThrow();
    expect(() =>
      preparePlainTextReplayForTarget([], { ...TARGET, maxToolResultChars: -1 }),
    ).toThrow();
    expect(() =>
      preparePlainTextReplayForTarget([], { ...TARGET, maxToolResultChars: 1.5 }),
    ).toThrow();
  });

  it("describes files without payload locations and drops hidden protocol content", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "SYSTEM_SECRET" },
      {
        role: "user",
        providerOptions: { test: { hidden: "USER_METADATA" } },
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            data: new URL("https://secret.example/raw.png?token=abc"),
            mediaType: "image/png",
            filename: "diagram.png",
          },
        ],
      },
      {
        role: "assistant",
        providerOptions: { test: { hidden: "ASSISTANT_METADATA" } },
        content: [
          { type: "reasoning", text: "HIDDEN_REASONING" },
          { type: "reasoning-file", data: "RAW_REASONING_FILE", mediaType: "text/plain" },
          { type: "custom", kind: "test.private" },
          { type: "text", text: "visible" },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    const replay = preparePlainTextReplayForTarget(messages, TARGET);
    const serialized = JSON.stringify(replay);
    expect(replay).toEqual([
      {
        role: "user",
        content: 'look\n\n[Historical file: name="diagram.png"; media-type="image/png"]',
      },
      { role: "assistant", content: "visible" },
    ]);
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("HIDDEN");
    expect(serialized).not.toContain("METADATA");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("coalesces text-only roles and is deterministic and idempotent", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "one" },
      { role: "user", content: [{ type: "text", text: "two" }] },
      { role: "assistant", content: "three" },
      { role: "assistant", content: [{ type: "text", text: "four" }] },
    ];
    const first = preparePlainTextReplayForTarget(input, TARGET);
    const second = preparePlainTextReplayForTarget(input, TARGET);
    expect(first).toEqual([
      { role: "user", content: "one\n\ntwo" },
      { role: "assistant", content: "three\n\nfour" },
    ]);
    expect(second).toEqual(first);
    expect(preparePlainTextReplayForTarget(first, TARGET)).toEqual(first);
    expect(
      first.every(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string",
      ),
    ).toBe(true);
  });
});
