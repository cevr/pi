// Extracted from index.ts — review imports
import { describe, expect, it, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import { createBashTool, createBackgroundState, isPidAlive, cleanupBackgroundProcesses } from "./index";
import { isPidAlive, createBackgroundState, cleanupBackgroundProcesses, createBashTool } from "./index";

type BashToolResult = {
    content: [{ type: "text"; text: string }];
    details?: {
      command: string;
      background?: { id: string; pid: number; logPath: string };
    };
    isError?: boolean;
  };

  const backgroundState = createBackgroundState();
  const tool = createBashTool(backgroundState);
  const mockCtx = {
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => "test-session-id",
    },
  };

  async function execute(
    cmd: string,
    timeout?: number,
  ): Promise<BashToolResult> {
    return (await tool.execute!(
      "test-id",
      { cmd, timeout },
      undefined,
      undefined,
      mockCtx as any,
    )) as BashToolResult;
  }

  afterEach(async () => {
    await cleanupBackgroundProcesses(backgroundState, 100);
  });

  describe("bash tool output formatting", () => {
    describe("command header", () => {
      it("shows command in output header", async () => {
        const result = await execute(`echo "hello world"`);
        expect(result.content[0].text).toMatch(/^\$ echo "hello world"/);
      });

      it("shows full command including args", async () => {
        const result = await execute(`ls -la /tmp`);
        expect(result.content[0].text).toContain("$ ls -la /tmp");
      });
    });

    describe("small output (no truncation)", () => {
      it("shows all output when small", async () => {
        const result = await execute(`printf 'line 1\nline 2\nline 3\n'`);
        const text = result.content[0].text;
        expect(text).toContain("line 1");
        expect(text).toContain("line 2");
        expect(text).toContain("line 3");
        expect(text).not.toContain("truncated");
      });

      it("handles no output gracefully", async () => {
        const result = await execute("true");
        expect(result.content[0].text).toContain("no output");
        expect(result.isError).toBeFalsy();
      });
    });

    describe("large output (truncation)", () => {
      it("shows head + tail for large output", async () => {
        const result = await execute(
          `python3 -c "for i in range(1, 201): print(f'line {i}')"`,
        );
        const text = result.content[0].text;

        expect(text).toContain("line 1");
        expect(text).toContain("line 2");
        expect(text).toContain("line 199");
        expect(text).toContain("line 200");
        expect(text).toContain("truncated");

        const headIndex = text.indexOf("line 1");
        const markerIndex = text.indexOf("truncated");
        const tailIndex = text.indexOf("line 200");
        expect(headIndex).toBeLessThan(markerIndex);
        expect(markerIndex).toBeLessThan(tailIndex);
      }, 10_000);
    });

    describe("exit codes", () => {
      it("shows exit code on failure", async () => {
        await expect(
          execute(
            `python3 -c "import sys; print('some output'); sys.exit(42)"`,
          ),
        ).rejects.toThrow("exit code 42");
      });

      it("no exit code on success", async () => {
        const result = await execute(`echo "success"`);
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).not.toContain("exit code");
      });
    });

    describe("mixed stdout/stderr", () => {
      it("captures both stdout and stderr", async () => {
        const result = await execute(`bash -lc 'echo stdout; echo stderr >&2'`);
        const text = result.content[0].text;
        expect(text).toContain("stdout");
        expect(text).toContain("stderr");
      });
    });

    describe("command chaining policy", () => {
      it("rejects top-level && chains", async () => {
        await expect(execute(`echo one && echo two`)).rejects.toThrow(
          "top-level command chaining with && is not supported",
        );
      });

      it("rejects top-level semicolon chains", async () => {
        await expect(execute(`echo one; echo two`)).rejects.toThrow(
          "top-level command chaining with ; is not supported",
        );
      });

      it("rejects top-level || chains", async () => {
        await expect(execute(`false || echo two`)).rejects.toThrow(
          "top-level command chaining with || is not supported",
        );
      });

      it("allows quoted chain operators", async () => {
        const result = await execute(
          `printf '%s\n' 'one && two; three || four'`,
        );
        expect(result.content[0].text).toContain("one && two; three || four");
      });

      it("allows leading cd normalization", async () => {
        const result = await execute(`cd /tmp && printf 'ok\n'`);
        expect(result.content[0].text).toContain("ok");
      });

      it("still rejects extra chaining after cd normalization", async () => {
        await expect(
          execute(`cd /tmp && echo one && echo two`),
        ).rejects.toThrow(
          "top-level command chaining with && is not supported",
        );
      });
    });

    describe("reversion guards", () => {
      it("shows first lines, not just tail", async () => {
        const result = await execute(
          `python3 -c "for i in range(1, 101): print(f'output line {i}')"`,
        );
        const text = result.content[0].text;
        expect(text).toContain("output line 1");
        expect(text).toContain("output line 2");
        expect(text).toContain("output line 99");
        expect(text).toContain("output line 100");
      }, 10_000);

      it("puts the command header at the start of output", async () => {
        const result = await execute(`echo "test"`);
        const text = result.content[0].text;
        expect(text).toMatch(/^\$ echo "test"/);
        expect(text.slice(0, text.indexOf("\n"))).toBe('$ echo "test"');
      });

      it("keeps head lines before tail lines in truncated output", async () => {
        const result = await execute(
          `python3 -c "for i in range(1, 151): print(f'line {i}')"`,
        );
        const text = result.content[0].text;
        const firstHeadIndex = text.indexOf("line 1");
        const lastTailIndex = text.indexOf("line 150");
        expect(firstHeadIndex).toBeGreaterThan(0);
        expect(firstHeadIndex).toBeLessThan(lastTailIndex);
      }, 10_000);
    });

    describe("edge cases", () => {
      it("handles command with special characters", async () => {
        const result = await execute(
          `printf '%s\n' "special: 'quotes' and "double" and $var"`,
        );
        expect(result.content[0].text).toContain("special");
      });

      it("handles very long single line", async () => {
        const result = await execute(`python3 -c "print('x' * 10000)"`);
        expect(result.content[0].text).toContain("xxxxx");
      }, 10_000);

      it("handles many short lines", async () => {
        const result = await execute(
          `python3 -c "for _ in range(500): print('x')"`,
        );
        expect(result.content[0].text).toContain("truncated");
      }, 10_000);
    });

    describe("background commands", () => {
      it("returns immediately and writes output to a log file", async () => {
        const startedAt = Date.now();
        const result = await execute(
          `python3 -c "import time; print('ready', flush=True); time.sleep(60)" &`,
        );

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(result.details?.background?.pid).toBeTruthy();
        expect(result.details?.background?.id).toMatch(/^bg-/);
        expect(result.details?.background?.logPath).toBeTruthy();
        expect(result.content[0].text).toContain("started background process");

        await new Promise((resolve) => setTimeout(resolve, 150));
        const logText = fs.readFileSync(
          result.details!.background!.logPath,
          "utf-8",
        );
        expect(logText).toContain("ready");
      }, 10_000);

      it("kills background commands during cleanup", async () => {
        const result = await execute(
          `python3 -c "import time; time.sleep(60)" &`,
        );
        const pid = result.details!.background!.pid;

        expect(isPidAlive(pid)).toBe(true);
        await cleanupBackgroundProcesses(backgroundState, 100);
        expect(isPidAlive(pid)).toBe(false);
      }, 10_000);
    });
  });
