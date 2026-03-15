// Extracted from index.ts — review imports
import { describe, expect, it } from "bun:test";
import { boxTop, boxRow, boxBorderLR, boxBottom } from "./index";
import { boxTop, boxRow, boxBorderLR, boxBottom } from "./index";

// identity style for testing raw output
const identity = { dim: (s: string) => s };

describe("boxTop", () => {
  it("open variant without header", () => {
    expect(boxTop({ variant: "open", style: identity })).toBe("╭─");
  });

  it("open variant with header", () => {
    expect(
      boxTop({
        variant: "open",
        style: identity,
        header: { text: "title", width: 5 },
      }),
    ).toBe("╭─[title]");
  });

  it("closed variant without header", () => {
    expect(boxTop({ variant: "closed", style: identity, innerWidth: 5 })).toBe("╭─────╮");
  });

  it("closed variant with header", () => {
    expect(
      boxTop({
        variant: "closed",
        style: identity,
        innerWidth: 10,
        header: { text: "hi", width: 2 },
      }),
    ).toBe("╭─hi───────╮");
  });
});

describe("boxRow", () => {
  it("open variant", () => {
    expect(boxRow({ variant: "open", style: identity, inner: "text" })).toBe("│ text");
  });

  it("closed variant", () => {
    expect(boxRow({ variant: "closed", style: identity, inner: "text" })).toBe("│text│");
  });
});

describe("boxBorderLR", () => {
  it("no labels", () => {
    expect(
      boxBorderLR({
        corner: { left: "╭", right: "╮" },
        style: identity,
        innerWidth: 6,
      }),
    ).toBe("╭──────╮");
  });

  it("left label only", () => {
    expect(
      boxBorderLR({
        corner: { left: "╭", right: "╮" },
        style: identity,
        innerWidth: 10,
        left: { text: "L", width: 1 },
      }),
    ).toBe("╭─L────────╮");
  });

  it("right label only", () => {
    expect(
      boxBorderLR({
        corner: { left: "╭", right: "╮" },
        style: identity,
        innerWidth: 10,
        right: { text: "R", width: 1 },
      }),
    ).toBe("╭────────R─╮");
  });

  it("both labels", () => {
    expect(
      boxBorderLR({
        corner: { left: "╭", right: "╮" },
        style: identity,
        innerWidth: 12,
        left: { text: "L", width: 1 },
        right: { text: "R", width: 1 },
      }),
    ).toBe("╭─L────────R─╮");
  });

  it("overflow falls back to plain dashed line", () => {
    expect(
      boxBorderLR({
        corner: { left: "╭", right: "╮" },
        style: identity,
        innerWidth: 4,
        left: { text: "LONG", width: 4 },
        right: { text: "X", width: 1 },
      }),
    ).toBe("╭────╮");
  });
});

describe("boxBottom", () => {
  it("open variant", () => {
    expect(boxBottom({ variant: "open", style: identity })).toBe("╰────");
  });

  it("closed variant without footer", () => {
    expect(boxBottom({ variant: "closed", style: identity, innerWidth: 5 })).toBe("╰─────╯");
  });

  it("closed variant with centered footer", () => {
    expect(
      boxBottom({
        variant: "closed",
        style: identity,
        innerWidth: 10,
        footer: { text: "ok", width: 2 },
      }),
    ).toBe("╰────ok────╯");
  });

  it("footer centering handles odd widths", () => {
    expect(
      boxBottom({
        variant: "closed",
        style: identity,
        innerWidth: 9,
        footer: { text: "ok", width: 2 },
      }),
    ).toBe("╰───ok────╯");
  });
});
