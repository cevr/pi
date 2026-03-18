/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import {
  createSearchSessionsExtension,
  CONFIG_DEFAULTS,
  DEFAULT_EXTENSION_DEPS,
  SEARCH_SESSIONS_CONFIG_SCHEMA,
} from "./index";

const tmpdir = os.tmpdir();

const SESSION_FIXTURE = {
  sessionId: "alpha1234",
  sessionName: "alpha work",
  workspace: "/repo/app",
  filePath: "/sessions/alpha.jsonl",
  startedAt: "2026-03-06T17:00:00.000Z",
  updatedAt: "2026-03-06T17:10:00.000Z",
  firstUserMessage: "alpha task",
  searchableText: "alpha task",
  branchCount: 1,
  isHandoffCandidate: false,
};

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

describe("search-sessions extension", () => {
  it("registers mention source and tool with default config when enabled", () => {
    const registerMentionSourceSpy = mock();
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createSearchSessionsExtension({
      registerMentionSource:
        registerMentionSourceSpy as typeof DEFAULT_EXTENSION_DEPS.registerMentionSource,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_EXTENSION_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_EXTENSION_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(registerMentionSourceSpy).toHaveBeenCalledTimes(1);
    const source = registerMentionSourceSpy.mock.calls[0]?.[0];
    expect(source?.kind).toBe("session");
    expect(
      source?.getSuggestions("alpha", {
        cwd: "/repo/app",
        sessions: [SESSION_FIXTURE],
      }),
    ).toEqual([
      {
        value: "@session/alpha1234",
        label: "@session/alpha1234",
        description: "alpha work",
      },
    ]);
    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
      "@cvr/pi-search-sessions",
      CONFIG_DEFAULTS,
      { schema: SEARCH_SESSIONS_CONFIG_SCHEMA },
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });

  it("registers neither mention source nor tool when disabled", () => {
    const registerMentionSourceSpy = mock();
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createSearchSessionsExtension({
      registerMentionSource:
        registerMentionSourceSpy as typeof DEFAULT_EXTENSION_DEPS.registerMentionSource,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_EXTENSION_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_EXTENSION_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(registerMentionSourceSpy).not.toHaveBeenCalled();
    expect(withPromptPatchSpy).not.toHaveBeenCalled();
    expect(harness.tools).toHaveLength(0);
  });

  it("falls back to defaults when schema validation fails and still registers", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-search-sessions-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-search-sessions": {
        maxResults: 0,
        sessionsDir: "",
        rgTimeoutMs: "fast",
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const registerMentionSourceSpy = mock();
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createSearchSessionsExtension({
      ...DEFAULT_EXTENSION_DEPS,
      registerMentionSource:
        registerMentionSourceSpy as typeof DEFAULT_EXTENSION_DEPS.registerMentionSource,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_EXTENSION_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-search-sessions; falling back to defaults.",
    );
    expect(registerMentionSourceSpy).toHaveBeenCalledTimes(1);
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "search_sessions" });
  });
});
