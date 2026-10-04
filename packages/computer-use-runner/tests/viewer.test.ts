import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../lilac-viewer.js", import.meta.url), "utf8").replace(
  /^import RFB[^\n]+\n/,
  "",
);

test("embedded VNC authenticates once, defaults to view-only, and accepts input changes only from its parent", () => {
  let receive: (event: object) => void = () => {};
  const sent: object[] = [];
  const instances: FakeRfb[] = [];
  const parent = {
    postMessage: (message: object, origin: string) => sent.push({ message, origin }),
  };
  class FakeRfb {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = true;
    listeners = new Map<string, () => void>();
    constructor(
      readonly target: object,
      readonly url: string,
      readonly options: object,
    ) {
      instances.push(this);
    }
    addEventListener(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
  }
  runInNewContext(source, {
    RFB: FakeRfb,
    URL,
    URLSearchParams,
    parent,
    location: {
      search: "?parentOrigin=https%3A%2F%2Fnative.example",
      href: "https://viewer.example/lilac-viewer.html?parentOrigin=https%3A%2F%2Fnative.example",
      protocol: "https:",
    },
    document: { getElementById: () => ({}) },
    window: {
      addEventListener: (_: string, handler: typeof receive) => {
        receive = handler;
      },
    },
  });
  const connect = { type: "lilac-computer-connect", password: "fixture" };
  receive({ source: parent, origin: "https://other.example", data: connect });
  receive({ source: {}, origin: "https://native.example", data: connect });
  expect(instances).toHaveLength(0);
  const send = (data: object) =>
    receive({ source: parent, origin: "https://native.example", data });
  send(connect);
  send(connect);
  expect(instances).toHaveLength(1);
  const rfb = instances[0]!;
  expect(rfb.url).toBe("wss://viewer.example/websockify");
  expect(rfb.options).toEqual({ credentials: { password: "fixture" } });
  expect(rfb.viewOnly).toBe(true);
  expect(rfb.scaleViewport).toBe(true);
  expect(rfb.resizeSession).toBe(false);
  send({ type: "lilac-computer-input", enabled: true });
  expect(rfb.viewOnly).toBe(false);
  send({ type: "lilac-computer-input", enabled: "true" });
  expect(rfb.viewOnly).toBe(false);
  send({ type: "lilac-computer-input", enabled: false });
  expect(rfb.viewOnly).toBe(true);
  rfb.listeners.get("connect")!();
  expect(sent.at(-1)).toEqual({
    message: { type: "lilac-computer-state", state: "connected" },
    origin: "https://native.example",
  });
});
