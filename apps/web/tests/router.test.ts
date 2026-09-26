import { describe, expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { createAppRouter } from "../src/router";
import { threadIdFromUrl } from "../src/thread-location";

function setup(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, shellComponent: () => null, onChatEnter: () => {} });
  router.update({ isServer: false, origin: "http://localhost" });
  return { router, history };
}

describe("web routes", () => {
  test("invalid workspace parameters fall back to chat", async () => {
    const { router } = setup("/?view=invalid&settings=invalid");
    await router.load();
    expect(router.state.matches.find((match) => match.routeId === "/chat")?.search).toEqual({});
  });

  test("view, external conversation, and settings survive reload and history", async () => {
    const { router, history } = setup("/threads/first?view=archived");
    await router.load();
    expect(router.state.location.search).toEqual({ view: "archived" });
    await router.navigate({
      to: ".",
      search: { view: "others", otherThread: "discord:123", settings: "options" },
    });
    const reload = setup(history.location.href);
    await reload.router.load();
    expect(reload.router.state.location.search).toEqual({
      view: "others",
      otherThread: "discord:123",
      settings: "options",
    });
    history.back();
    await router.load();
    expect(router.state.location.search).toEqual({ view: "archived" });
  });

  test("settings navigation preserves Clerk hashes and draft history state", async () => {
    const { router, history } = setup("/?settings=account#/security");
    await router.load();
    await router.navigate({
      to: "/",
      state: { draftThreadId: "draft:one" },
      search: true,
      hash: true,
    });
    await router.navigate({
      to: ".",
      search: (previous) => ({ ...previous, settings: "options" }),
      state: true,
      hash: true,
    });
    expect(history.location.hash).toBe("#/security");
    expect(history.location.state.draftThreadId).toBe("draft:one");
    expect(router.state.location.search).toEqual({ settings: "options" });
  });

  test("draft promotion preserves settings and the selected view", async () => {
    const { router, history } = setup(
      "/?view=others&otherThread=discord%3A123&settings=core#/security",
    );
    await router.load();
    await router.navigate({
      to: "/",
      state: { draftThreadId: "draft:pending" },
      search: true,
      hash: true,
    });
    await router.navigate({
      to: "/threads/$threadId",
      params: { threadId: "created" },
      search: true,
      hash: true,
    });
    expect(history.location.pathname).toBe("/threads/created");
    expect(history.location.state.draftThreadId).toBeUndefined();
    expect(history.location.hash).toBe("#/security");
    expect(router.state.location.search).toEqual({
      view: "others",
      otherThread: "discord:123",
      settings: "core",
    });
  });

  test("thread paths share the chat layout and preserve browser history", async () => {
    const { router, history } = setup("/threads/first");
    await router.load();
    const layoutId = router.state.matches[1]!.id;
    expect(router.state.matches.at(-1)?.params).toEqual({ threadId: "first" });
    await router.navigate({ to: "/threads/$threadId", params: { threadId: "second" } });
    expect(router.state.matches[1]!.id).toBe(layoutId);
    expect(history.location.pathname).toBe("/threads/second");
    expect(history.location.search).toBe("");
    history.back();
    await router.load();
    expect(router.state.matches.at(-1)?.params).toEqual({ threadId: "first" });
    history.forward();
    await router.load();
    expect(router.state.matches.at(-1)?.params).toEqual({ threadId: "second" });
  });

  test("draft history state survives routing without putting draft IDs in the URL", async () => {
    const { router, history } = setup("/threads/first");
    await router.load();
    await router.navigate({ to: "/", state: { draftThreadId: "draft:one" } });
    await router.navigate({ to: "/", state: { draftThreadId: "draft:two" } });
    expect(history.location.pathname).toBe("/");
    expect(history.location.state.draftThreadId).toBe("draft:two");
    history.back();
    await router.load();
    expect(router.state.location.state.draftThreadId).toBe("draft:one");
  });

  test("legacy thread links redirect to the canonical path", async () => {
    const { router, history } = setup("/?thread=old-thread");
    await router.load();
    expect(history.location.pathname).toBe("/threads/old-thread");
    expect(history.location.search).toBe("");
  });

  test("bootstrap selects decoded thread paths, including old bookmarks", () => {
    expect(threadIdFromUrl(new URL("https://example.test/threads/thread%3Aone"))).toBe(
      "thread:one",
    );
    expect(threadIdFromUrl(new URL("https://example.test/?thread=old"))).toBe("old");
    expect(
      threadIdFromUrl(new URL("https://example.test/design-system?thread=old")),
    ).toBeUndefined();
    expect(threadIdFromUrl(new URL("https://example.test/threads/%E0%A4%A"))).toBeUndefined();
  });
});
