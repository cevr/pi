import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import planModeExtension from "./index";

function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const commands: Array<{ name: string; command: unknown }> = [];
  const shortcuts: Array<{ key: unknown; options: unknown }> = [];
  const flags: Array<{ name: string; options: unknown }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const sentUserMessages: string[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "skill"];

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.push({ name, command });
    },
    registerShortcut(key: unknown, options: unknown) {
      shortcuts.push({ key, options });
    },
    registerFlag(name: string, options: unknown) {
      flags.push({ name, options });
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    getFlag(_name: string) {
      return false;
    },
    events: {
      emit: mock(() => {}),
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    shortcuts,
    flags,
    listeners,
    sentMessages,
    sentUserMessages,
    appendedEntries,
    getActiveTools: () => activeTools,
  };
}

describe("plan-mode extension", () => {
  it("registers /plan and /todos commands", () => {
    const h = createMockExtensionApiHarness();
    planModeExtension(h.pi);

    const names = h.commands.map((c) => c.name);
    expect(names).toContain("plan");
    expect(names).toContain("todos");
  });

  it("registers ctrl+alt+p shortcut", () => {
    const h = createMockExtensionApiHarness();
    planModeExtension(h.pi);

    expect(h.shortcuts).toHaveLength(1);
  });

  it("registers --plan flag", () => {
    const h = createMockExtensionApiHarness();
    planModeExtension(h.pi);

    expect(h.flags).toHaveLength(1);
    expect(h.flags[0].name).toBe("plan");
  });

  it("registers event handlers for tool_call, context, before_agent_start, turn_end, agent_end, session_start", () => {
    const h = createMockExtensionApiHarness();
    planModeExtension(h.pi);

    const events = h.listeners.map((l) => l.event);
    expect(events).toContain("tool_call");
    expect(events).toContain("context");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_start");
  });

  it("does not register any tools (plan mode is commands/shortcuts only)", () => {
    const h = createMockExtensionApiHarness();
    planModeExtension(h.pi);

    expect(h.tools).toHaveLength(0);
  });
});
