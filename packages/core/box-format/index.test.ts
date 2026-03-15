// Extracted from index.ts — review imports
import { describe, expect, it } from "bun:test";
import { formatBoxesWindowed, textSection, osc8Link, BoxSection, chromeWidth, visibleWidth, truncateToWidth } from "./index";
import { visibleWidth, truncateToWidth, chromeWidth, formatBoxesWindowed, textSection, osc8Link, BoxSection } from "./index";

describe("visibleWidth", () => {
    it("counts plain text characters", () => {
      expect(visibleWidth("hello")).toBe(5);
      expect(visibleWidth("")).toBe(0);
    });

    it("expands tabs to TAB_WIDTH", () => {
      expect(visibleWidth("\t")).toBe(4);
      expect(visibleWidth("a\tb")).toBe(6); // a + 4 (tab) + b
    });

    it("ignores ANSI SGR sequences", () => {
      expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
      expect(visibleWidth("\x1b[1;32mgreen\x1b[0m")).toBe(5);
    });

    it("ignores OSC 8 hyperlink sequences", () => {
      expect(
        visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
      ).toBe(4);
    });
  });

  describe("truncateToWidth", () => {
    it("returns text unchanged if within width", () => {
      expect(truncateToWidth("hello", 10)).toBe("hello");
    });

    it("truncates and adds ellipsis", () => {
      // "hello world" at width 8: "hello w" (7 visible) + RST + ellipsis
      const result = truncateToWidth("hello world", 8);
      expect(result).toContain("…");
      expect(visibleWidth(result.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(8);
    });

    it("preserves ANSI codes in truncated output", () => {
      const input = "\x1b[31mhello world\x1b[0m";
      const result = truncateToWidth(input, 8);
      expect(result).toContain("\x1b[31m");
      expect(result).toContain("\x1b[0m");
      expect(result).toContain("…");
    });

    it("handles text shorter than ellipsis", () => {
      expect(truncateToWidth("hi", 1)).toBe("…");
    });
  });

  describe("chromeWidth", () => {
    it("returns 2 for no gutter", () => {
      expect(chromeWidth(0)).toBe(2);
    });

    it("returns gutterWidth + 3 for gutter", () => {
      expect(chromeWidth(3)).toBe(6); // "  42 │ " = 3 + 3
      expect(chromeWidth(5)).toBe(8);
    });
  });

  describe("osc8Link", () => {
    it("wraps text in OSC 8 hyperlink", () => {
      const result = osc8Link("https://example.com", "click me");
      expect(result).toBe(
        "\x1b]8;;https://example.com\x07click me\x1b]8;;\x07",
      );
    });

    it("handles empty text", () => {
      const result = osc8Link("https://example.com", "");
      expect(result).toBe("\x1b]8;;https://example.com\x07\x1b]8;;\x07");
    });
  });

  describe("textSection", () => {
    it("creates section with header and text", () => {
      const section = textSection("Title", "line1\nline2");
      expect(section.header).toBe("Title");
      expect(section.blocks).toHaveLength(1);
      expect(section.blocks[0]?.lines).toHaveLength(2);
    });

    it("creates headless section when header is undefined", () => {
      const section = textSection(undefined, "content");
      expect(section.header).toBeUndefined();
    });

    it("sets highlight=true by default", () => {
      const section = textSection("Title", "text");
      expect(section.blocks[0]?.lines[0]?.highlight).toBe(true);
    });

    it("sets highlight=false when dim=true", () => {
      const section = textSection("Title", "text", true);
      expect(section.blocks[0]?.lines[0]?.highlight).toBe(false);
    });
  });

  describe("formatBoxesWindowed", () => {
    it("renders single section with header", () => {
      const sections: BoxSection[] = [
        {
          header: "Test",
          blocks: [{ lines: [{ text: "hello" }] }],
        },
      ];
      const result = formatBoxesWindowed(sections, {}, undefined, 80);
      expect(result).toContain("Test");
      expect(result).toContain("hello");
    });

    it("renders gutter with line numbers", () => {
      const sections: BoxSection[] = [
        {
          header: "File",
          blocks: [
            {
              lines: [
                { gutter: "1", text: "first", highlight: true },
                { gutter: "2", text: "second", highlight: false },
              ],
            },
          ],
        },
      ];
      const result = formatBoxesWindowed(sections, {}, undefined, 80);
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    it("respects maxSections option", () => {
      const sections: BoxSection[] = [
        { header: "A", blocks: [{ lines: [{ text: "a" }] }] },
        { header: "B", blocks: [{ lines: [{ text: "b" }] }] },
        { header: "C", blocks: [{ lines: [{ text: "c" }] }] },
      ];
      const result = formatBoxesWindowed(
        sections,
        { maxSections: 2 },
        undefined,
        80,
      );
      expect(result).toContain("A");
      expect(result).toContain("B");
      expect(result).not.toContain("C");
      expect(result).toContain("… 1 more");
    });

    it("appends notices", () => {
      const sections: BoxSection[] = [
        { header: "Test", blocks: [{ lines: [{ text: "content" }] }] },
      ];
      const result = formatBoxesWindowed(
        sections,
        {},
        ["Notice 1", "Notice 2"],
        80,
      );
      expect(result).toContain("[Notice 1. Notice 2]");
    });
  });
