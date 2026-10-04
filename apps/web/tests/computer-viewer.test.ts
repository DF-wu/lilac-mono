import { expect, test } from "bun:test";
import {
  clampComputerPosition,
  computerFrameUrl,
  decodeComputerState,
} from "../src/computer-viewer";

test("embedded viewer URL carries only the parent origin", () => {
  const url = new URL(
    computerFrameUrl("https://computer.example:17000/lilac-viewer.html", "https://native.example"),
  );
  expect(url.searchParams.get("parentOrigin")).toBe("https://native.example");
  expect([...url.searchParams.keys()]).toEqual(["parentOrigin"]);
  expect(url.hash).toBe("");
});
test("viewer rejects unrelated and invalid frame messages", () => {
  expect(decodeComputerState({ type: "lilac-computer-state", state: "connected" })).toBe(
    "connected",
  );
  expect(decodeComputerState({ type: "other", state: "connected" })).toBeNull();
  expect(decodeComputerState({ type: "lilac-computer-state", state: "controlling" })).toBeNull();
  expect(decodeComputerState(null)).toBeNull();
});
test("dragging and viewport resize retain visible viewer controls", () => {
  expect(clampComputerPosition(1000, 1000, 480, 340, 1280, 800)).toEqual({ x: 792, y: 452 });
  expect(clampComputerPosition(-100, -100, 480, 340, 1280, 800)).toEqual({ x: 8, y: 8 });
  expect(clampComputerPosition(792, 452, 320, 220, 360, 640)).toEqual({ x: 32, y: 412 });
});
