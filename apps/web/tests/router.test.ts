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
