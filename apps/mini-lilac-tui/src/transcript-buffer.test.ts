import { describe, expect, it } from "bun:test";

import { createBufferedChunkOutput } from "./transcript-buffer";

describe("createBufferedChunkOutput", () => {
  it("coalesces a large replay into one transcript publication", () => {
    const publications: number[] = [];
    const buffer = createBufferedChunkOutput(
      "child",
      [{ id: "prompt", kind: "user", tone: "accent", text: "Inspect" }],
      (entries) => publications.push(entries.length),
    );

    const id = buffer.output.append({
      kind: "assistant",
      tone: "normal",
      text: "",
      streaming: true,
    });
    for (let index = 0; index < 10_000; index += 1) buffer.output.appendText(id, "x");
    buffer.output.finish(id);

    expect(publications).toEqual([]);
    buffer.flush();
    expect(publications).toEqual([2]);
    expect(buffer.snapshot()[1]).toMatchObject({ text: "x".repeat(10_000), streaming: false });
    buffer.dispose();
  });

  it("publishes an active transcript after the frame delay", async () => {
    const publications: string[] = [];
    const publication = Promise.withResolvers<void>();
    const buffer = createBufferedChunkOutput("child", [], (entries) => {
      publications.push(entries[0]?.text ?? "");
      publication.resolve();
    });

    buffer.output.append({ kind: "assistant", tone: "normal", text: "working" });
    expect(publications).toEqual([]);
    await publication.promise;

    expect(publications).toEqual(["working"]);
    buffer.dispose();
  });

  it("removes an entry and keeps later indexes writable", () => {
    const buffer = createBufferedChunkOutput("child", [], () => {});
    const first = buffer.output.append({ kind: "assistant", tone: "normal", text: "remove" });
    const second = buffer.output.append({ kind: "assistant", tone: "normal", text: "keep" });

    buffer.output.remove(first);
    buffer.output.appendText(second, " updated");

    expect(buffer.snapshot()).toEqual([
      { id: second, kind: "assistant", tone: "normal", text: "keep updated" },
    ]);
    buffer.dispose();
  });
});
