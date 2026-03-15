// Extracted from index.ts — review imports
import { describe, expect, it } from "bun:test";
import { windowItems, show } from "./index";
import { windowItems, show } from "./index";

describe("windowItems", () => {
    it("returns all items when no excerpts", () => {
      const items = ["a", "b", "c"];
      const result = windowItems(items, [], (n) => `...${n}...`);
      expect(result.items).toEqual(["a", "b", "c"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      const result = windowItems(
        [],
        [{ focus: 0, context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual([]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("extracts head excerpt", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: "head", context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b", "...3..."]);
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("extracts tail excerpt", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: "tail", context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["...3...", "d", "e"]);
      expect(result.skippedRanges).toEqual([[0, 3]]);
    });

    it("extracts symmetric excerpt around index", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: 2, context: 1 }],
        (n) => `...${n}...`,
      );
      // focus=2, context=1 → range [1,3] → keeps b,c,d, skips 1 at start and 1 at end
      expect(result.items).toEqual(["...1...", "b", "c", "d", "...1..."]);
      expect(result.skippedRanges).toEqual([
        [0, 1],
        [4, 5],
      ]);
    });

    it("merges overlapping excerpts", () => {
      const items = ["a", "b", "c", "d", "e", "f"];
      const result = windowItems(
        items,
        [
          { focus: 1, context: 1 }, // [0, 2]
          { focus: 3, context: 1 }, // [2, 4]
        ],
        (n) => `...${n}...`,
      );
      // merged to [0, 4], leaving [5, 6]
      expect(result.items).toEqual(["a", "b", "c", "d", "e", "...1..."]);
      expect(result.skippedRanges).toEqual([[5, 6]]);
    });

    it("merges adjacent excerpts", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [
          { focus: 0, context: 0 }, // [0, 0]
          { focus: 1, context: 0 }, // [1, 1]
        ],
        (n) => `...${n}...`,
      );
      // adjacent [0,0] and [1,1] merge to [0,1]
      expect(result.items).toEqual(["a", "b", "...3..."]);
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("clamps head context to available items", () => {
      const items = ["a", "b"];
      const result = windowItems(
        items,
        [{ focus: "head", context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("clamps tail context to available items", () => {
      const items = ["a", "b"];
      const result = windowItems(
        items,
        [{ focus: "tail", context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("clamps symmetric context to bounds", () => {
      const items = ["a", "b", "c"];
      const result = windowItems(
        items,
        [{ focus: 0, context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b", "c"]);
      expect(result.skippedRanges).toEqual([]);
    });
  });

  describe("show", () => {
    it("returns empty for empty text", () => {
      const result = show("", [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines).toEqual([]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("returns all lines when no excerpts", () => {
      const result = show("a\nb\nc", [], 80);
      // Text.render() pads each line to width
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("a");
      expect(result.visualLines[1]?.trim()).toBe("b");
      expect(result.visualLines[2]?.trim()).toBe("c");
      expect(result.skippedRanges).toEqual([]);
    });

    it("applies head excerpt to visual lines", () => {
      const text = "line1\nline2\nline3\nline4\nline5";
      const result = show(text, [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("line1");
      expect(result.visualLines[1]?.trim()).toBe("line2");
      expect(result.visualLines[2]).toBe("... (3 lines) ...");
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("uses singular 'line' for single skipped line", () => {
      const text = "line1\nline2\nline3";
      const result = show(text, [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("line1");
      expect(result.visualLines[1]?.trim()).toBe("line2");
      expect(result.visualLines[2]).toBe("... (1 line) ...");
    });

    it("wraps long lines at width", () => {
      const longLine = "a".repeat(100);
      const result = show(longLine, [], 50);
      // Text.render() wraps at 50 chars
      expect(result.visualLines.length).toBeGreaterThan(1);
    });
  });
