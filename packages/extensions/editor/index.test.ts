import { describe, expect, it } from "bun:test";
import { Layer, ManagedRuntime } from "effect";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { formatModelDisplay, getGitDiffStats } from "./index";

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

  describe("getGitDiffStats", () => {
    function makeGitRuntime(diffStat: string) {
      return ManagedRuntime.make(
        GitClient.layerTest({ diffStat }),
      );
    }

    it("returns empty string without runtime", async () => {
      expect(await getGitDiffStats("/tmp")).toBe("");
    });

    it("returns formatted stats from git diff --stat output", async () => {
      // git diff --stat output: last line is summary, no trailing newline
      const runtime = makeGitRuntime(
        " src/foo.ts | 10 ++++---\n src/bar.ts | 5 ++--\n 2 files changed, 8 insertions(+), 5 deletions(-)",
      );
      try {
        const result = await getGitDiffStats("/tmp", runtime);
        expect(result).toBe("2 files changed +8 -5");
      } finally {
        await runtime.dispose();
      }
    });

    it("returns empty string on empty diff", async () => {
      const runtime = makeGitRuntime("");
      try {
        const result = await getGitDiffStats("/tmp", runtime);
        expect(result).toBe("");
      } finally {
        await runtime.dispose();
      }
    });

    it("handles insertions-only summary", async () => {
      const runtime = makeGitRuntime(
        " src/new.ts | 20 +++++++++++\n 1 file changed, 20 insertions(+)",
      );
      try {
        const result = await getGitDiffStats("/tmp", runtime);
        expect(result).toBe("1 files changed +20");
      } finally {
        await runtime.dispose();
      }
    });
  });
});
