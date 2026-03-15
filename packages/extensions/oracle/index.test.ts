// Extracted from index.ts — review imports
import { describe, expect, it, test, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import {
  createOracleExtension,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  ORACLE_CONFIG_SCHEMA,
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

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  return { pi, tools };
}

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("oracle extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createOracleExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-oracle", CONFIG_DEFAULTS, {
      schema: ORACLE_CONFIG_SCHEMA,
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
    const extension = createOracleExtension({
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
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-oracle-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-oracle": {
        model: "",
        extensionTools: ["read", 123],
        builtinTools: "bash",
        promptFile: 123,
        promptString: false,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const resolvePromptSpy = mock(() => "system prompt");
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createOracleExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-oracle; falling back to defaults.",
    );
    expect(resolvePromptSpy).toHaveBeenCalledWith(
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});
