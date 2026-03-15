// Extracted from index.ts — review imports
import { describe, expect, it, test, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTaskTool } from "./index";

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

  describe("task extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = mock(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const tool = { name: "Task" } as ToolDefinition;
      const createTaskToolSpy = mock(() => tool);
      const withPromptPatchSpy = mock((nextTool: ToolDefinition) => nextTool);
      const extension = createTaskExtension({
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@cvr/pi-task",
        CONFIG_DEFAULTS,
        { schema: TASK_CONFIG_SCHEMA },
      );
      expect(createTaskToolSpy).toHaveBeenCalledWith({
        builtinTools: CONFIG_DEFAULTS.builtinTools,
        extensionTools: CONFIG_DEFAULTS.extensionTools,
      });
      expect(withPromptPatchSpy).toHaveBeenCalledWith(tool);
      expect(harness.tools).toHaveLength(1);
    });

    it("registers no tools when disabled", () => {
      const getEnabledExtensionConfigSpy = mock(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const createTaskToolSpy = mock(
        () => ({ name: "Task" }) as ToolDefinition,
      );
      const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
      const extension = createTaskExtension({
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(createTaskToolSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-task-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@cvr/pi-task": {
          builtinTools: ["read", 123],
          extensionTools: "finder",
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const tool = { name: "Task" } as ToolDefinition;
      const createTaskToolSpy = mock(() => tool);
      const withPromptPatchSpy = mock((nextTool: ToolDefinition) => nextTool);
      const extension = createTaskExtension({
        ...DEFAULT_DEPS,
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@cvr/pi-config] invalid config for @cvr/pi-task; falling back to defaults.",
      );
      expect(createTaskToolSpy).toHaveBeenCalledWith({
        builtinTools: CONFIG_DEFAULTS.builtinTools,
        extensionTools: CONFIG_DEFAULTS.extensionTools,
      });
      expect(withPromptPatchSpy).toHaveBeenCalledWith(tool);
      expect(harness.tools).toHaveLength(1);
    });
  });
