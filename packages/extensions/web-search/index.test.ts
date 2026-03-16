// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { Effect, ManagedRuntime, Ref } from "effect";
import { ProcessRunner, type ProcessResult, type SpawnRecord } from "@cvr/pi-process-runner";
import {
  createWebSearchExtension,
  searchParallel,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  WEB_SEARCH_CONFIG_SCHEMA,
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

describe("web-search extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createWebSearchExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
      "@cvr/pi-web-search",
      CONFIG_DEFAULTS,
      { schema: WEB_SEARCH_CONFIG_SCHEMA },
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
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createWebSearchExtension({
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
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-web-search-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-web-search": {
        defaultMaxResults: 0,
        endpoint: "",
        curlTimeoutSecs: "fast",
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createWebSearchExtension({
      ...DEFAULT_DEPS,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-web-search; falling back to defaults.",
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});

describe("searchParallel", () => {
  function makeRuntime(results: Map<string, ProcessResult>) {
    const spawnLog = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const runtime = ManagedRuntime.make(ProcessRunner.layerTest(spawnLog, results));
    return { runtime, spawnLog };
  }

  it("returns parsed data on successful curl and issues correct command", async () => {
    const response = { results: [{ url: "https://example.com", title: "Example", excerpts: [] }] };
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 0, stdout: JSON.stringify(response), stderr: "" }],
    ]);
    const { runtime, spawnLog } = makeRuntime(results);
    try {
      const { data, error } = await searchParallel(
        "test-key",
        { objective: "test" },
        "https://api.test/search",
        30,
        undefined,
        runtime,
      );
      expect(error).toBeUndefined();
      expect(data?.results).toHaveLength(1);
      expect(data?.results[0]?.title).toBe("Example");
      // verify correct curl invocation
      const log = Effect.runSync(Ref.get(spawnLog));
      expect(log).toHaveLength(1);
      expect(log[0]!.command).toBe("curl");
      expect(log[0]!.args).toContain("https://api.test/search");
      expect(log[0]!.args).toContain("x-api-key: test-key");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns error on non-zero exit code", async () => {
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 7, stdout: "", stderr: "connection refused" }],
    ]);
    const { runtime } = makeRuntime(results);
    try {
      const { data, error } = await searchParallel(
        "test-key",
        { objective: "test" },
        "https://api.test/search",
        30,
        undefined,
        runtime,
      );
      expect(data).toBeUndefined();
      expect(error).toContain("search failed");
      expect(error).toContain("connection refused");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns error on invalid JSON response", async () => {
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 0, stdout: "not json {{{", stderr: "" }],
    ]);
    const { runtime } = makeRuntime(results);
    try {
      const { data, error } = await searchParallel(
        "test-key",
        { objective: "test" },
        "https://api.test/search",
        30,
        undefined,
        runtime,
      );
      expect(data).toBeUndefined();
      expect(error).toContain("invalid response from Parallel API");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns error when runtime is not provided", async () => {
    const { error } = await searchParallel(
      "test-key",
      { objective: "test" },
      "https://api.test/search",
      30,
    );
    expect(error).toBe("ProcessRunner runtime not available");
  });
});
