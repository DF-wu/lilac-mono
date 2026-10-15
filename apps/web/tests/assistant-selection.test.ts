import { expect, test } from "bun:test";
import { createTextSelector, findCitationText } from "../src/assistant-selection";

test("selectors preserve code indentation while matching reflowed whitespace", () => {
  const text = "Before\n  const answer = 42;\nAfter";
  const selector = createTextSelector(text, 6, 27)!;
  expect(selector.text).toBe("\n  const answer = 42;");
  expect(findCitationText("Before  const answer = 42; After", selector)).toEqual({
    start: 6,
    end: 25,
  });
});
test("source drift can relocate unique text, but repeated text needs unambiguous context", () => {
  const selector = createTextSelector("Before claim after", 7, 12)!;
  expect(findCitationText("New text. Before claim after", selector)).toEqual({
    start: 17,
    end: 22,
  });
  expect(findCitationText("Before claim after. Before claim after", selector)).toBeUndefined();
  expect(findCitationText("The only claim changed context", selector)).toEqual({
    start: 9,
    end: 14,
  });
});
test("whitespace-only selections are rejected and context never splits an emoji", () => {
  expect(createTextSelector("  \n ", 0, 4)).toBeUndefined();
  const text = "🚀".repeat(30) + "quote" + "🚀".repeat(30);
  const selector = createTextSelector(text, 60, 65)!;
  expect(selector.prefix).toBe("🚀".repeat(16));
  expect(selector.suffix).toBe("🚀".repeat(16));
});
