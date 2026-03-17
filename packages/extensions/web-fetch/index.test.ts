import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import {
  WebFetchRequestError,
  WebFetchService,
  type WebFetchLayerTestResponse,
} from "@cvr/pi-web-fetch-core";
import { ManagedRuntime } from "effect";
import {
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  WEB_FETCH_CONFIG_SCHEMA,
  createWebFetchExtension,
  createWebFetchTool,
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

function makeRuntime(responses: Map<string, WebFetchLayerTestResponse>) {
  return ManagedRuntime.make(WebFetchService.layerTest(responses));
}

afterEach(() => {
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("web-fetch extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createWebFetchExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
      "@cvr/pi-web-fetch",
      CONFIG_DEFAULTS,
      { schema: WEB_FETCH_CONFIG_SCHEMA },
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
    const extension = createWebFetchExtension({
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
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-web-fetch-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-web-fetch": {
        defaultTimeoutSecs: 0,
        maxTimeoutSecs: 0,
        maxResponseBytes: -1,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createWebFetchExtension({
      ...DEFAULT_DEPS,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-web-fetch; falling back to defaults.",
    );
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
  });
});

describe("web_fetch tool", () => {
  it("returns text from a WebFetchService runtime", async () => {
    const runtime = makeRuntime(
      new Map([
        [
          "https://example.com/docs",
          {
            _tag: "Text",
            text: "# Docs\n\nHello world.",
            url: "https://example.com/docs",
            title: "https://example.com/docs (text/html)",
            mimeType: "text/html",
            format: "markdown",
          },
        ],
      ]),
    );

    try {
      const tool = createWebFetchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { url: "https://example.com/docs" }, undefined);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("# Docs");
      expect(result.details.format).toBe("markdown");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns image content from a WebFetchService runtime", async () => {
    const runtime = makeRuntime(
      new Map([
        [
          "https://example.com/image.png",
          {
            _tag: "Image",
            data: "iVBORw==",
            url: "https://example.com/image.png",
            title: "https://example.com/image.png (image/png)",
            mimeType: "image/png",
          },
        ],
      ]),
    );

    try {
      const tool = createWebFetchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { url: "https://example.com/image.png" }, undefined);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("image");
      expect(result.content[0].mimeType).toBe("image/png");
    } finally {
      await runtime.dispose();
    }
  });

  it("surfaces typed service errors as tool errors", async () => {
    const runtime = makeRuntime(
      new Map([
        [
          "https://example.com/file.pdf",
          new WebFetchRequestError({
            url: "https://example.com/file.pdf",
            message: "request failed",
          }),
        ],
      ]),
    );

    try {
      const tool = createWebFetchTool(CONFIG_DEFAULTS, runtime);
      const result = await (tool as any).execute("call-1", { url: "https://example.com/file.pdf" }, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("request failed");
    } finally {
      await runtime.dispose();
    }
  });
});
