/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { ProcessRunner, type ProcessResult, type SpawnRecord } from "@cvr/pi-process-runner";
import { Effect, ManagedRuntime, Ref } from "effect";
import {
  createGrepExtension,
  createGrepTool,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  GREP_CONFIG_SCHEMA,
} from "./index";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const listeners = new Map<string, Function[]>();

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  } as unknown as ExtensionAPI;

  return { pi, tools, listeners };
}

function makeProcessRuntime(results: Map<string, ProcessResult>) {
  const spawnLog = Ref.makeUnsafe<Array<SpawnRecord>>([]);
  const runtime = ManagedRuntime.make(ProcessRunner.layerTest(spawnLog, results));
  return { runtime, spawnLog };
}

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("grep extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createGrepExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-grep", CONFIG_DEFAULTS, {
      schema: GREP_CONFIG_SCHEMA,
    });
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "grep" });
  });

  it("registers no extension tool when disabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createGrepExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(withPromptPatchSpy).not.toHaveBeenCalled();
    expect(harness.tools).toHaveLength(0);
  });

  it("falls back to defaults for invalid config and still registers", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-grep-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-grep": {
        maxTotalMatches: 0,
        maxPerFile: 0,
        maxLineChars: 0,
        contextLines: -1,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createGrepExtension({
      ...DEFAULT_DEPS,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-grep; falling back to defaults.",
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "grep" });
  });
});

describe("grep tool", () => {
  it("searches a file path without using the file as cwd", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-grep-file-"));
    const filePath = path.join(dir, "notes.txt");
    fs.writeFileSync(filePath, "png-bytes\n");
    const results = new Map<string, ProcessResult>([
      [
        "rg",
        {
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: "match",
            data: {
              path: { text: path.basename(filePath) },
              line_number: 1,
              lines: { text: "png-bytes\n" },
            },
          })}\n`,
          stderr: "",
        },
      ],
    ]);
    const { runtime, spawnLog } = makeProcessRuntime(results);

    try {
      const tool = createGrepTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute(
        "call-1",
        { pattern: "png", path: filePath },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("notes.txt:1: png-bytes");
      expect(result.details?.fileGroups).toEqual([
        {
          path: "notes.txt",
          absolutePath: filePath,
          matches: [{ lineNum: 1, text: "png-bytes", isContext: false }],
          hitLimit: false,
        },
      ]);

      const log = Effect.runSync(Ref.get(spawnLog));
      expect(log).toHaveLength(1);
      expect(log[0]?.cwd).toBe(dir);
      expect(log[0]?.args.at(-1)).toBe(filePath);
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses image files and tells the caller to use read", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-grep-image-"));
    const filePath = path.join(dir, "clipboard-image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { runtime, spawnLog } = makeProcessRuntime(new Map());

    try {
      const tool = createGrepTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute(
        "call-2",
        { pattern: "png", path: filePath },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("grep can't search image files");
      expect(result.content[0]?.text).toContain(filePath);
      expect(result.content[0]?.text).toContain("use read");
      expect(Effect.runSync(Ref.get(spawnLog))).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses binary files and tells the caller to use read", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-grep-binary-"));
    const filePath = path.join(dir, "artifact.bin");
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const { runtime, spawnLog } = makeProcessRuntime(new Map());

    try {
      const tool = createGrepTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute(
        "call-3",
        { pattern: "png", path: filePath },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("grep can't search binary files");
      expect(result.content[0]?.text).toContain(filePath);
      expect(result.content[0]?.text).toContain("use read");
      expect(Effect.runSync(Ref.get(spawnLog))).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});
