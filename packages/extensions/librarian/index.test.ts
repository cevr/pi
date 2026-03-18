/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { Effect, ManagedRuntime, Ref } from "effect";
import { ProcessRunner, type ProcessResult, type SpawnRecord } from "@cvr/pi-process-runner";
import {
  createLibrarianExtension,
  repoFetch,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  LIBRARIAN_CONFIG_SCHEMA,
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

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("librarian extension", () => {
  it("exposes the full repo exploration toolset by default", () => {
    expect(CONFIG_DEFAULTS.extensionTools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "web_search",
      "web_fetch",
    ]);
  });

  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createLibrarianExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
      "@cvr/pi-librarian",
      CONFIG_DEFAULTS,
      { schema: LIBRARIAN_CONFIG_SCHEMA },
    );
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
    const extension = createLibrarianExtension({
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
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-librarian-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-librarian": {
        model: "",
        extensionTools: ["read_github", 123],
        builtinTools: "bash",
        promptFile: 123,
        promptString: false,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createLibrarianExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-librarian; falling back to defaults.",
    );
    expect(resolvePromptSpy).toHaveBeenCalledWith(
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});

describe("repoFetch", () => {
  function makeRuntime(results: Map<string, ProcessResult>) {
    const spawnLog = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const runtime = ManagedRuntime.make(ProcessRunner.layerTest(spawnLog, results));
    return { runtime, spawnLog };
  }

  it("returns path on successful fetch and issues correct command", async () => {
    const results = new Map<string, ProcessResult>([
      ["repo", { exitCode: 0, stdout: "/home/.cache/repo/owner/repo\n", stderr: "" }],
    ]);
    const { runtime, spawnLog } = makeRuntime(results);
    try {
      const result = await repoFetch("owner/repo", runtime);
      expect(result).toBe("/home/.cache/repo/owner/repo");
      const log = Effect.runSync(Ref.get(spawnLog));
      expect(log).toHaveLength(1);
      expect(log[0]!.command).toBe("repo");
      expect(log[0]!.args).toEqual(["fetch", "owner/repo"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns null on non-zero exit code", async () => {
    const results = new Map<string, ProcessResult>([
      ["repo", { exitCode: 1, stdout: "", stderr: "not found" }],
    ]);
    const { runtime } = makeRuntime(results);
    try {
      const result = await repoFetch("bad/spec", runtime);
      expect(result).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("returns null on empty stdout", async () => {
    const results = new Map<string, ProcessResult>([
      ["repo", { exitCode: 0, stdout: "  \n", stderr: "" }],
    ]);
    const { runtime } = makeRuntime(results);
    try {
      const result = await repoFetch("owner/repo", runtime);
      expect(result).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
});
