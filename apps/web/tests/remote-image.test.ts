import { expect, test } from "bun:test";
import { activityFileTarget } from "../src/file-target";
import { remoteImageUrl } from "../src/remote-image";

test("remote tool images become preview resources rather than filesystem paths", () => {
  const url = "https://pbs.twimg.com/media/example.png?name=large&format=png";
  expect(activityFileTarget(url, "image/png")).toEqual({
    type: "resource",
    name: "example.png",
    mediaType: "image/png",
    href: `/api/remote-image?url=${encodeURIComponent(url)}`,
  });
  expect(activityFileTarget("/tmp/image.png", "image/png")).toEqual({
    type: "path",
    path: "/tmp/image.png",
    name: "image.png",
  });
  expect(activityFileTarget("/tmp/file.txt", "text/plain").type).toBe("path");
});

test("local, managed, and embedded images keep their URLs", () => {
  for (const url of [
    "/assets/lilac.svg",
    "/api/resources/image",
    "data:image/png;base64,AA==",
    "blob:https://example.com/image",
  ])
    expect(remoteImageUrl(url)).toBe(url);
});
