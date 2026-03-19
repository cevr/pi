import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, mock } from "bun:test";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { PiSpawnService, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "@cvr/pi-spawn";
import {
  createCounselExtension,
  createCounselTool,
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

function createRuntime(spawnImpl: (config: PiSpawnConfig) => PiSpawnResult) {
  return ManagedRuntime.make(
    Layer.succeed(PiSpawnService, {
      spawn: (config: PiSpawnConfig) => Effect.succeed(spawnImpl(config)),
    }),
  );
}

function makeAssistantResult(text: string): PiSpawnResult {
  return {
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
    stderr: "",
    usage: zeroUsage(),
    stopReason: "stop",
  };
}

function makeFailedResult(errorMessage: string, overrides: Partial<PiSpawnResult> = {}): PiSpawnResult {
  return {
    exitCode: 1,
    messages: [{ role: "assistant", content: [{ type: "text", text: errorMessage }] } as any],
    stderr: "",
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage,
    ...overrides,
  };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "counsel-test-"));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    model: { provider: "openai-responses", id: "gpt-5.4" },
    sessionManager: { getSessionId: () => "session-1" },
    ...overrides,
  } as any;
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

  it("detects openai from o-series model ids", () => {
    expect(detectModelFamily("openrouter", "openai/o3-pro")).toBe("openai");
    expect(detectModelFamily("requesty", "o3")).toBe("openai");
    expect(detectModelFamily("openrouter", "openai/o1-preview")).toBe("openai");
  });

  it("detects openai from codex model ids", () => {
    expect(detectModelFamily("requesty", "codex-mini-latest")).toBe("openai");
  });

  it("detects from api when provider and model id are ambiguous", () => {
    expect(detectModelFamily("requesty", "assistant", "openai-codex-responses")).toBe("openai");
    expect(detectModelFamily("portkey", "sonnet-4", "anthropic-messages")).toBe("anthropic");
  });

  it("detects from model name and base url as fallbacks", () => {
    expect(detectModelFamily("requesty", "assistant", undefined, "GPT-5 via proxy")).toBe("openai");
    expect(detectModelFamily("gateway", "assistant", undefined, "Sonnet 4 via proxy")).toBe(
      "anthropic",
    );
    expect(
      detectModelFamily(
        "gateway",
        "assistant",
        undefined,
        undefined,
        "https://api.anthropic.com/v1",
      ),
    ).toBe("anthropic");
  });

  it("detects more openai api and model aliases", () => {
    expect(detectModelFamily("azure", "assistant", "azure-openai-responses")).toBe("openai");
    expect(detectModelFamily("gateway", "o4-mini")).toBe("openai");
    expect(detectModelFamily("gateway", "computer-use-preview")).toBe("openai");
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

describe("createCounselTool", () => {
  it("uses pi-spawn transport defaults with a persisted session file", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeAssistantResult("Looks good.");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.promptViaStdin).toBeUndefined();
      expect(typeof calls[0]!.sessionPath).toBe("string");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(`Session: ${calls[0]!.sessionPath}`);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the anthropic counsel model when the parent model is openai", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeAssistantResult("Looks good.");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(calls[0]!.model).toBe(CONFIG_DEFAULTS.oppositeModels.openai);
    } finally {
      await runtime.dispose();
    }
  });

  it("detects openai parents from api metadata when provider and id are ambiguous", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeAssistantResult("Looks good.");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx({
          model: {
            provider: "requesty",
            id: "assistant",
            api: "openai-codex-responses",
            name: "Assistant via proxy",
            baseUrl: "https://gateway.example.com/v1",
          },
        }),
      );

      expect(calls[0]!.model).toBe(CONFIG_DEFAULTS.oppositeModels.openai);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the openai counsel model when the parent model is anthropic", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeAssistantResult("Looks good.");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx({ model: { provider: "anthropic", id: "claude-opus-4-6" } }),
      );

      expect(calls[0]!.model).toBe(CONFIG_DEFAULTS.oppositeModels.anthropic);
    } finally {
      await runtime.dispose();
    }
  });

  it("includes parent model metadata when detection is ambiguous", async () => {
    const runtime = createRuntime(() => {
      throw new Error("should not spawn when model detection fails");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx({
          model: {
            provider: "gateway",
            id: "assistant",
            api: "custom-api",
            name: "Helper",
            baseUrl: "https://gateway.example.com/v1",
          },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Current model metadata was ambiguous");
      expect(result.content[0].text).toContain('provider="gateway"');
      expect(result.content[0].text).toContain('id="assistant"');
      expect(result.content[0].text).toContain('api="custom-api"');
    } finally {
      await runtime.dispose();
    }
  });

  it("returns only the session path, not the full review text", async () => {
    const runtime = createRuntime(() => makeAssistantResult("Detailed review body."));

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Session: ");
      expect(result.content[0].text).not.toContain("Detailed review body.");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects empty prompts with an actionable retry message", async () => {
    const runtime = createRuntime(() => {
      throw new Error("should not spawn when prompt is empty");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "   " },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Counsel prompt must be non-empty");
      expect(result.content[0].text).toContain("Do not skip counsel");
    } finally {
      await runtime.dispose();
    }
  });

  it("retries once with a reduced prompt when the first attempt fails with malformed input", async () => {
    await withTempDir(async (dir) => {
      const relativeFile = "review-target.ts";
      fs.writeFileSync(path.join(dir, relativeFile), "export const answer = 42;\n", "utf-8");
      const calls: PiSpawnConfig[] = [];
      const runtime = createRuntime((config) => {
        calls.push(config);
        return calls.length === 1
          ? makeFailedResult("invalid input: malformed request body")
          : makeAssistantResult("Approve");
      });

      try {
        const tool = createCounselTool({}, runtime, () => "");
        const result = await (tool as any).execute(
          "call-1",
          { prompt: "Review this change.", files: [relativeFile] },
          undefined,
          undefined,
          makeCtx({ cwd: dir }),
        );

        expect(calls).toHaveLength(2);
        expect(calls[0]!.task).toContain("## Inline File Context");
        expect(calls[0]!.task).toContain("export const answer = 42;");
        expect(calls[1]!.task).toContain("## Reliability Mode");
        expect(calls[1]!.task).not.toContain("export const answer = 42;");
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe(`Session: ${calls[1]!.sessionPath}`);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("does not retry config failures and returns an agent-usable next step", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeFailedResult("unauthorized: invalid api key");
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(calls).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Counsel failed after 1 attempt");
      expect(result.content[0].text).toContain("Fix the counsel model or provider configuration");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns a retry-oriented failure message after both attempts fail", async () => {
    const calls: PiSpawnConfig[] = [];
    const runtime = createRuntime((config) => {
      calls.push(config);
      return makeFailedResult(
        calls.length === 1 ? "invalid input: malformed request body" : "still malformed",
      );
    });

    try {
      const tool = createCounselTool({}, runtime, () => "");
      const result = await (tool as any).execute(
        "call-1",
        { prompt: "Review this change." },
        undefined,
        undefined,
        makeCtx(),
      );

      expect(calls).toHaveLength(2);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Counsel failed after 2 attempts");
      expect(result.content[0].text).toContain("Do not skip counsel");
      expect(result.content[0].text).toContain(String(calls[0]!.sessionPath));
      expect(result.content[0].text).toContain(String(calls[1]!.sessionPath));
    } finally {
      await runtime.dispose();
    }
  });
});
