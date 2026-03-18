/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { createReadExtension, CONFIG_DEFAULTS, DEFAULT_DEPS, READ_CONFIG_SCHEMA } from "./index";

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

describe("read extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createReadExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-read", CONFIG_DEFAULTS, {
      schema: READ_CONFIG_SCHEMA,
    });
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "read" });
  });

  it("registers no extension tool when disabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createReadExtension({
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
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-read-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-read": {
        maxLines: 0,
        maxFileBytes: 0,
        maxLineBytes: 0,
        maxDirEntries: 0,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createReadExtension({
      ...DEFAULT_DEPS,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-read; falling back to defaults.",
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "read" });
  });
});
