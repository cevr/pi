/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts — review imports
import { describe, expect, it, afterEach, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import {
  createHandoffExtension,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  HANDOFF_CONFIG_SCHEMA,
} from "./index";
import { registerMentionSource } from "@cvr/pi-mentions";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const commands: Array<{ name: string; command: unknown }> = [];
  const handlers: Array<{ event: string; handler: unknown }> = [];
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const sentUserMessages: string[] = [];

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.push({ name, command });
    },
    on(event: string, handler: unknown) {
      handlers.push({ event, handler });
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    events: {
      emit(event: string, payload: unknown) {
        emittedEvents.push({ event, payload });
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    handlers,
    emittedEvents,
    sentUserMessages,
  };
}

const REGULAR_SESSION = {
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

const HANDOFF_SESSION = {
  sessionId: "handoffabcd",
  sessionName: "handoff alpha",
  workspace: "/repo/app",
  filePath: "/sessions/handoff.jsonl",
  startedAt: "2026-03-06T17:00:00.000Z",
  updatedAt: "2026-03-06T17:20:00.000Z",
  firstUserMessage: "resume alpha",
  searchableText: "resume alpha",
  branchCount: 1,
  parentSessionPath: "/sessions/parent.jsonl",
  isHandoffCandidate: true,
};

afterEach(() => {
  // mock.restore() — manual cleanup;
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("handoff extension", () => {
  it("registers mention source, command, tool, and handlers with default config when enabled", async () => {
    const { getMentionSource } = await import("@cvr/pi-mentions");
    let registeredSourceCount = 0;
    let cleanup: (() => void) | undefined;
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const handoffExtension = createHandoffExtension({
      ...DEFAULT_DEPS,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      resolvePrompt: () => "",
      registerMentionSource(source) {
        registeredSourceCount += 1;
        cleanup = registerMentionSource(source);
        return cleanup;
      },
    });
    const harness = createMockExtensionApiHarness();

    handoffExtension(harness.pi);

    try {
      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@cvr/pi-handoff",
        CONFIG_DEFAULTS,
        { schema: HANDOFF_CONFIG_SCHEMA },
      );
      expect(registeredSourceCount).toBe(1);
      const source = getMentionSource("handoff");
      expect(source?.kind).toBe("handoff");
      expect(
        source?.getSuggestions("handoff", {
          cwd: "/repo/app",
          sessions: [REGULAR_SESSION, HANDOFF_SESSION],
        }),
      ).toEqual([
        {
          value: "@handoff/handoffabcd",
          label: "@handoff/handoffabcd",
          description: "handoff alpha",
        },
      ]);
      expect(harness.handlers.map((entry) => entry.event).sort()).toEqual([
        "agent_end",
        "session_before_compact",
        "session_start",
        "session_switch",
      ]);
      expect(harness.commands).toEqual([
        {
          name: "handoff",
          command: expect.any(Object),
        },
      ]);
      expect(harness.tools).toEqual([
        expect.objectContaining({
          name: "handoff",
          label: "Handoff",
        }),
      ]);
    } finally {
      cleanup?.();
    }
  });

  it("registers neither mention source nor command nor tool nor handlers when disabled", () => {
    const registerMentionSourceSpy = mock();
    const resolvePromptSpy = mock(() => "");
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const handoffExtension = createHandoffExtension({
      ...DEFAULT_DEPS,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      registerMentionSource: registerMentionSourceSpy as typeof DEFAULT_DEPS.registerMentionSource,
      resolvePrompt: resolvePromptSpy,
    });
    const harness = createMockExtensionApiHarness();

    handoffExtension(harness.pi);

    expect(registerMentionSourceSpy).not.toHaveBeenCalled();
    expect(resolvePromptSpy).not.toHaveBeenCalled();
    expect(harness.commands).toHaveLength(0);
    expect(harness.tools).toHaveLength(0);
    expect(harness.handlers).toHaveLength(0);
  });

  it("falls back to defaults when schema validation fails and still registers startup capabilities", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-handoff-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-handoff": {
        threshold: 2,
        model: { provider: "", id: "" },
        promptFile: false,
        promptString: 123,
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const registerMentionSourceSpy = mock();
    const resolvePromptSpy = mock(() => "");
    const handoffExtension = createHandoffExtension({
      ...DEFAULT_DEPS,
      registerMentionSource: registerMentionSourceSpy as typeof DEFAULT_DEPS.registerMentionSource,
      resolvePrompt: resolvePromptSpy,
    });
    const harness = createMockExtensionApiHarness();

    handoffExtension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-handoff; falling back to defaults.",
    );
    expect(registerMentionSourceSpy).toHaveBeenCalledTimes(1);
    expect(resolvePromptSpy).toHaveBeenCalledWith(
      CONFIG_DEFAULTS.promptString,
      CONFIG_DEFAULTS.promptFile,
    );
    expect(harness.handlers.map((entry) => entry.event).sort()).toEqual([
      "agent_end",
      "session_before_compact",
      "session_start",
      "session_switch",
    ]);
    expect(harness.commands).toEqual([
      {
        name: "handoff",
        command: expect.any(Object),
      },
    ]);
    expect(harness.tools).toEqual([
      expect.objectContaining({
        name: "handoff",
        label: "Handoff",
      }),
    ]);
  });
});
