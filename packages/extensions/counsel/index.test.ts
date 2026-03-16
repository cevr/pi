import { describe, expect, it, mock } from "bun:test";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  createCounselExtension,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  COUNSEL_CONFIG_SCHEMA,
  detectModelFamily,
} from "./index";

function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const listeners: Array<{ event: string; handler: Function }> = [];

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
  } as any;

  return { pi, tools, listeners };
}

describe("counsel extension", () => {
  it("registers the tool with default config when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const readPrinciplesSpy = mock(() => "");
    const extension = createCounselExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      readPrinciples: readPrinciplesSpy,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-counsel", CONFIG_DEFAULTS, {
      schema: COUNSEL_CONFIG_SCHEMA,
    });
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
    expect(harness.tools).toHaveLength(1);
    expect(harness.tools[0]).toMatchObject({ name: "counsel" });
  });

  it("registers no tools when disabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const readPrinciplesSpy = mock(() => "");
    const extension = createCounselExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      readPrinciples: readPrinciplesSpy,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(withPromptPatchSpy).not.toHaveBeenCalled();
    expect(harness.tools).toHaveLength(0);
  });

  it("registers session_shutdown listener when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const readPrinciplesSpy = mock(() => "");
    const extension = createCounselExtension({
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      readPrinciples: readPrinciplesSpy,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    const shutdownListeners = harness.listeners.filter((l) => l.event === "session_shutdown");
    expect(shutdownListeners).toHaveLength(1);
  });
});

describe("detectModelFamily", () => {
  it("detects anthropic from provider", () => {
    expect(detectModelFamily("anthropic", "claude-opus-4-6")).toBe("anthropic");
  });

  it("detects openai from provider", () => {
    expect(detectModelFamily("openai-responses", "gpt-5.4")).toBe("openai");
  });

  it("detects anthropic from model id when provider is a gateway", () => {
    expect(detectModelFamily("openrouter", "anthropic/claude-opus-4-6")).toBe("anthropic");
  });

  it("detects openai from model id when provider is a gateway", () => {
    expect(detectModelFamily("openrouter", "openai/gpt-5.4")).toBe("openai");
  });

  it("detects openai from o1/o3 model ids", () => {
    expect(detectModelFamily("openrouter", "openai/o3-pro")).toBe("openai");
    expect(detectModelFamily("openrouter", "openai/o1-preview")).toBe("openai");
  });

  it("returns null for unknown provider and model", () => {
    expect(detectModelFamily("some-gateway", "some-model")).toBeNull();
  });

  it("returns null for undefined inputs", () => {
    expect(detectModelFamily(undefined, undefined)).toBeNull();
  });

  it("prefers model id over provider for classification", () => {
    // openrouter hosting an anthropic model
    expect(detectModelFamily("openrouter", "anthropic/claude-3-opus")).toBe("anthropic");
    // openrouter hosting an openai model
    expect(detectModelFamily("openrouter", "openai/gpt-4o")).toBe("openai");
  });
});
