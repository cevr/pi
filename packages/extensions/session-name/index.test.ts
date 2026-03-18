/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { CONFIG_DEFAULTS, sessionNameExtension } from "./index";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function createMockExtensionApiHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  let sessionName = "";

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(next: string) {
      sessionName = next;
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers, getSessionName: () => sessionName };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("session-name extension", () => {
  it("skips hook registration when disabled in config", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-session-name-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-session-name": { enabled: false },
    });
    setGlobalSettingsPath(settingsPath);
    const harness = createMockExtensionApiHarness();

    sessionNameExtension(harness.pi);

    expect(harness.handlers.size).toBe(0);
  });

  it("registers hooks with default config when enabled", () => {
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
    const harness = createMockExtensionApiHarness();

    sessionNameExtension(harness.pi);

    expect([...harness.handlers.keys()].sort()).toEqual(["input", "session_switch"]);
  });

  it("falls back to defaults when schema validation fails", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-session-name-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-session-name": {
        renameInterval: "fast",
        model: { provider: 123, id: false },
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createMockExtensionApiHarness();
    const model = { id: "fallback-model" } as unknown as Model<Api>;
    const findSpy = mock(() => model);
    const ctx = {
      model,
      modelRegistry: {
        find: findSpy,
        getApiKey: mock(async () => undefined),
      },
    };

    sessionNameExtension(harness.pi);

    expect([...harness.handlers.keys()].sort()).toEqual(["input", "session_switch"]);

    const inputHandler = harness.handlers.get("input");
    expect(inputHandler).toBeDefined();

    for (let i = 0; i < 11; i++) {
      await inputHandler?.({ text: `message body ${i} with enough chars` }, ctx);
      await flushAsyncWork();
    }

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-session-name; falling back to defaults.",
    );
    expect(findSpy).toHaveBeenCalledWith(CONFIG_DEFAULTS.model.provider, CONFIG_DEFAULTS.model.id);
    expect(ctx.modelRegistry.getApiKey).toHaveBeenCalledTimes(2);
    expect(harness.getSessionName()).toBe("");
  });
});
