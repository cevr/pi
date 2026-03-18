/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSystemPromptExtension, CONFIG_DEFAULTS, DEFAULT_DEPS } from "./index";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function createMockExtensionApiHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("system-prompt extension", () => {
  it("registers before_agent_start with default config when enabled", () => {
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
    const harness = createMockExtensionApiHarness();
    const resolvePromptSpy = mock(
      (promptString: string, promptFile: string) =>
        promptString || (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
    );
    const extension = createSystemPromptExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
    });

    extension(harness.pi);

    expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
    expect(resolvePromptSpy).toHaveBeenNthCalledWith(
      1,
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
  });

  it("registers no handlers when disabled", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-system-prompt": { enabled: false },
    });
    setGlobalSettingsPath(settingsPath);
    const harness = createMockExtensionApiHarness();
    const resolvePromptSpy = mock(() => "body");
    const extension = createSystemPromptExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
    });

    extension(harness.pi);

    expect(harness.handlers.size).toBe(0);
    expect(resolvePromptSpy).not.toHaveBeenCalled();
  });

  it("falls back to defaults when config is invalid and still registers before_agent_start", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-system-prompt": {
        identity: "",
        harness: "",
        promptFile: 123,
        promptString: false,
        harnessDocsPromptFile: null,
        harnessDocsPromptString: 42,
      },
    });
    setGlobalSettingsPath(settingsPath);
    spyOn(console, "error").mockImplementation(() => {});
    const harness = createMockExtensionApiHarness();
    const resolvePromptSpy = mock(
      (promptString: string, promptFile: string) =>
        promptString || (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
    );
    const extension = createSystemPromptExtension({
      ...DEFAULT_DEPS,
      resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
    });

    extension(harness.pi);

    expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
    expect(resolvePromptSpy).toHaveBeenNthCalledWith(
      1,
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
  });
});
