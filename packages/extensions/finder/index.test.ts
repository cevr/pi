/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { PiSpawnService, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "@cvr/pi-spawn";
import {
  createFinderExtension,
  createFinderTool,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  FINDER_CONFIG_SCHEMA,
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
  const listeners: Record<string, Function[]> = {};

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      (listeners[event] ??= []).push(handler);
    },
  } as unknown as ExtensionAPI;

  return { pi, tools, listeners };
}

function createRuntime(spawnImpl: (config: PiSpawnConfig) => PiSpawnResult) {
  return ManagedRuntime.make(
    Layer.succeed(PiSpawnService, {
      spawn: (config: PiSpawnConfig) => Effect.succeed(spawnImpl(config)),
    }),
  );
}

function makeAssistantResult(text: string): PiSpawnResult {
  return {
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
    stderr: "",
    usage: zeroUsage(),
    stopReason: "stop",
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "session-1" },
    ...overrides,
  } as any;
}

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("finder extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createFinderExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-finder", CONFIG_DEFAULTS, {
      schema: FINDER_CONFIG_SCHEMA,
    });
    expect(resolvePromptSpy).toHaveBeenCalledWith(
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });

  it("registers no tools when disabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createFinderExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(resolvePromptSpy).not.toHaveBeenCalled();
    expect(withPromptPatchSpy).not.toHaveBeenCalled();
    expect(harness.tools).toHaveLength(0);
  });

  it("falls back to defaults for invalid config and still registers", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-finder-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-finder": {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "grep",
        promptFile: 123,
        promptString: false,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createFinderExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-finder; falling back to defaults.",
    );
    expect(resolvePromptSpy).toHaveBeenCalledWith(
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});

describe("createFinderTool", () => {
  it("rejects empty queries before spawning", async () => {
    const runtime = createRuntime(() => {
      throw new Error("should not spawn for empty queries");
    });

    try {
      const tool = createFinderTool({}, runtime);
      const result = await (tool as any).execute(
        "call-1",
        { query: "   " },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Finder query must be non-empty.");
    } finally {
      await runtime.dispose();
    }
  });

  it("trims the query and includes bash in default search tools", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeAssistantResult("Found matches.");
    });

    try {
      const tool = createFinderTool({}, runtime);
      const result = await (tool as any).execute(
        "call-1",
        { query: "  find JWT validation  " },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.task).toBe("find JWT validation");
      expect(calls[0]!.builtinTools).toEqual(CONFIG_DEFAULTS.builtinTools);
      expect(calls[0]!.extensionTools).toEqual(CONFIG_DEFAULTS.extensionTools);
      expect(CONFIG_DEFAULTS.builtinTools).toContain("bash");
      expect(CONFIG_DEFAULTS.extensionTools).toContain("bash");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Found matches.");
    } finally {
      await runtime.dispose();
    }
  });
});
