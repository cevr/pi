import { describe, expect, it } from "bun:test";
import { formatModelDisplay } from "./index";

describe("editor extension", () => {
  describe("formatModelDisplay", () => {
    it("formats model display string correctly", () => {
      expect(formatModelDisplay("anthropic", "claude-sonnet-4-20250514")).toBe(
        "(anthropic) claude-sonnet-4-20250514",
      );

      expect(formatModelDisplay("openai", "gpt-4o")).toBe("(openai) gpt-4o");

      expect(formatModelDisplay("openrouter", "z-ai/glm-5")).toBe("(openrouter) z-ai/glm-5");

      expect(formatModelDisplay(undefined, "some-model")).toBe("some-model");
    });
  });
});
