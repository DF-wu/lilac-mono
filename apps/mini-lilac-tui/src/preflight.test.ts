import { describe, expect, it } from "bun:test";

import { selectChoice, type Choice, type PreflightIO } from "./preflight";

const CHOICES: readonly Choice[] = [
  { id: "a", label: "Alpha", hint: undefined, isDefault: false },
  { id: "b", label: "Beta", hint: undefined, isDefault: true },
  { id: "c", label: "Gamma", hint: undefined, isDefault: false },
];

describe("selectChoice", () => {
  function stubIo(answers: string[]): PreflightIO & { writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      write: (text) => {
        writes.push(text);
      },
      question: async () => answers.shift() ?? "",
    };
  }

  it("returns a preselected choice without prompting", async () => {
    const io = stubIo([]);
    const choice = await selectChoice(io, "Model", CHOICES, "c");
    expect(choice.status).toBe("ok");
    if (choice.status === "ok") expect(choice.value.id).toBe("c");
    expect(io.writes).toEqual([]);
  });

  it("returns an owned failure when a preselected id is unknown", async () => {
    const io = stubIo([]);
    const choice = await selectChoice(io, "Model", CHOICES, "zzz");
    expect(choice.status).toBe("error");
  });

  it("renders choices and retries invalid input until a valid selection is entered", async () => {
    const io = stubIo(["b", "9", "1"]);
    const choice = await selectChoice(io, "Model", CHOICES, undefined);
    expect(choice.status).toBe("ok");
    if (choice.status === "ok") expect(choice.value.id).toBe("a");
    expect(io.writes[0]).toContain("* 2. Beta");
    expect(io.writes.filter((write) => write === "Invalid selection, try again.\n")).toHaveLength(
      2,
    );
  });

  it("uses the default choice on empty input", async () => {
    const io = stubIo([""]);
    const choice = await selectChoice(io, "Model", CHOICES, undefined);
    expect(choice.status).toBe("ok");
    if (choice.status === "ok") expect(choice.value.id).toBe("b");
  });
});
