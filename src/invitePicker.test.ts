import { describe, expect, it } from "vitest";
import { groupLabel, mergeSelection } from "./invitePicker";

describe("groupLabel", () => {
  it("maps the LCU catch-all group to 未分組", () => {
    expect(groupLabel("**Default")).toBe("未分組");
  });

  it("passes a normal group name through unchanged", () => {
    expect(groupLabel("ARAM 好友")).toBe("ARAM 好友");
  });

  it("trims whitespace around the name", () => {
    expect(groupLabel("  ARAM 好友 ")).toBe("ARAM 好友");
  });

  it("recognizes **Default even with surrounding whitespace", () => {
    expect(groupLabel(" **Default ")).toBe("未分組");
  });
});

describe("mergeSelection", () => {
  it("keeps saved entries that are missing from the shown list", () => {
    // "a" is shown again, so it re-enters via selectedShown; kept entries go first.
    expect(mergeSelection(["a", "x"], ["a", "b"], ["a"])).toEqual(["x", "a"]);
  });

  it("drops a shown entry that was deselected", () => {
    expect(mergeSelection(["a", "b"], ["a", "b"], ["a"])).toEqual(["a"]);
  });

  it("adds a newly selected entry, ordered as shown", () => {
    // b stays ticked; c is newly ticked; selection reads in shown order,
    // not in the order the user clicked.
    expect(mergeSelection(["b"], ["a", "b", "c"], ["c", "b"])).toEqual(["b", "c"]);
  });

  it("dedupes repeated saved entries", () => {
    expect(mergeSelection(["a", "a"], ["b"], ["a"])).toEqual(["a"]);
  });

  it("keeps the saved list unchanged when nothing is shown", () => {
    expect(mergeSelection(["a", "b"], [], [])).toEqual(["a", "b"]);
  });
});
