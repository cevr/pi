import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { ProcessRunner, type ProcessResult, type SpawnRecord } from "@cvr/pi-process-runner";
import { Effect, ManagedRuntime, Ref } from "effect";
import {
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  WEB_SEARCH_CONFIG_SCHEMA,
  createWebSearchExtension,
  createWebSearchRuntime,
  createWebSearchTool,
  searchParallel,
} from "./index";

const tmpdir = os.tmpdir();
const touchedKeys = new Set<string>();

function setEnv(key: string, value: string | undefined) {
  touchedKeys.add(key);
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function makePackageRoot(): { root: string; nested: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-runtime-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cvr/pi", private: true }, null, 2) + "\n",
  );
  const nested = path.join(root, "packages", "extensions", "web-search");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested };
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

function makeWebSearchRuntime(start: string, results: Map<string, ProcessResult>) {
  const spawnLog = Ref.makeUnsafe<Array<SpawnRecord>>([]);
  const runtime = createWebSearchRuntime(start, ProcessRunner.layerTest(spawnLog, results));
  return { runtime, spawnLog };
}

afterEach(() => {
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  for (const key of touchedKeys) {
    delete process.env[key];
  }
  touchedKeys.clear();
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
    expect(harness.listeners.get("session_shutdown")).toHaveLength(1);
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

describe("web_search runtime wiring", () => {
  it("returns a generic setup message when PARALLEL_API_KEY is missing", async () => {
    const { nested } = makePackageRoot();
    setEnv("PARALLEL_API_KEY", undefined);
    const { runtime } = makeWebSearchRuntime(nested, new Map());

    try {
      const tool = createWebSearchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { objective: "test" }, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "PARALLEL_API_KEY not set. add it to your environment or the repo .env file.",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reads PARALLEL_API_KEY from repo .env through the runtime wiring", async () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\n");
    setEnv("PARALLEL_API_KEY", undefined);
    const response = { results: [{ url: "https://example.com", title: "Example", excerpts: [] }] };
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 0, stdout: JSON.stringify(response), stderr: "" }],
    ]);
    const { runtime, spawnLog } = makeWebSearchRuntime(nested, results);

    try {
      const tool = createWebSearchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { objective: "test" }, undefined);

      expect(result.isError).toBeUndefined();
      const log = Effect.runSync(Ref.get(spawnLog));
      expect(log).toHaveLength(1);
      expect(log[0]!.args).toContain("x-api-key: from-dotenv");
    } finally {
      await runtime.dispose();
    }
  });

  it("prefers shell PARALLEL_API_KEY over repo .env through the runtime wiring", async () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\n");
    setEnv("PARALLEL_API_KEY", "from-shell");
    const response = { results: [{ url: "https://example.com", title: "Example", excerpts: [] }] };
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 0, stdout: JSON.stringify(response), stderr: "" }],
    ]);
    const { runtime, spawnLog } = makeWebSearchRuntime(nested, results);

    try {
      const tool = createWebSearchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { objective: "test" }, undefined);

      expect(result.isError).toBeUndefined();
      const log = Effect.runSync(Ref.get(spawnLog));
      expect(log).toHaveLength(1);
      expect(log[0]!.args).toContain("x-api-key: from-shell");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("searchParallel", () => {
  it("returns parsed data on successful curl and issues correct command", async () => {
    const response = { results: [{ url: "https://example.com", title: "Example", excerpts: [] }] };
    const results = new Map<string, ProcessResult>([
      ["curl", { exitCode: 0, stdout: JSON.stringify(response), stderr: "" }],
    ]);
    const { runtime, spawnLog } = makeProcessRuntime(results);
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
    const { runtime } = makeProcessRuntime(results);
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
    const { runtime } = makeProcessRuntime(results);
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
