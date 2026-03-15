// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import {
  findSessionFile,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  createReadSessionExtension,
  READ_SESSION_CONFIG_SCHEMA,
} from "./index";

const tmpdir = os.tmpdir();
const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-session-"));
  tmpRoots.push(dir);
  return dir;
}

function writeSessionJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

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
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findSessionFile", () => {
  it("finds sessions by filename first", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(sessionsDir, "2026", "2026-03-06T17-00-00-000Z_alpha-session.jsonl");
    writeSessionJsonl(filePath, [
      {
        type: "session",
        id: "alpha-session",
        timestamp: "2026-03-06T17:00:00.000Z",
        cwd: "/repo/app",
      },
    ]);

    expect(findSessionFile("alpha-session", sessionsDir)).toBe(filePath);
  });

  it("falls back to parsing headers when filenames do not include the session id", () => {
    const sessionsDir = makeTmpDir();
    const filePath = path.join(sessionsDir, "nested", "session-log.jsonl");
    writeSessionJsonl(filePath, [
      {
        type: "session",
        id: "beta-session",
        timestamp: "2026-03-06T17:10:00.000Z",
        cwd: "/repo/app",
      },
    ]);

    expect(findSessionFile("beta-session", sessionsDir)).toBe(filePath);
  });
});

describe("read-session extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createReadSessionExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
      "@cvr/pi-read-session",
      CONFIG_DEFAULTS,
      { schema: READ_SESSION_CONFIG_SCHEMA },
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
    const extension = createReadSessionExtension({
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
    const dir = makeTmpDir();
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-read-session": {
        model: "",
        sessionsDir: "",
        maxChars: 0,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createReadSessionExtension({
      ...DEFAULT_DEPS,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-read-session; falling back to defaults.",
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});
