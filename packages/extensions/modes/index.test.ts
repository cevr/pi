import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import modesExtension from "./index";

function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const commands: Array<{ name: string; command: any }> = [];
  const shortcuts: Array<{ key: unknown; options: any }> = [];
  const flags: Array<{ name: string; options: unknown }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const sentMessages: Array<{ message: any; options?: unknown }> = [];
  const sentUserMessages: Array<{ message: string; options?: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sessionEntries: unknown[] = [];
  const flagValues = new Map<string, unknown>();
  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "skill"];

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: any) {
      commands.push({ name, command });
    },
    registerShortcut(key: unknown, options: any) {
      shortcuts.push({ key, options });
    },
    registerFlag(name: string, options: unknown) {
      flags.push({ name, options });
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    sendMessage(message: any, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: string, options?: unknown) {
      sentUserMessages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getFlag(name: string) {
      return flagValues.get(name) ?? false;
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
    getCommand: (name: string) => commands.find((command) => command.name === name),
    getListener: (event: string) => listeners.find((listener) => listener.event === event),
    setFlag: (name: string, value: unknown) => {
      flagValues.set(name, value);
    },
    setSessionEntries: (entries: unknown[]) => {
      sessionEntries.splice(0, sessionEntries.length, ...entries);
    },
    createContext: (overrides: Record<string, unknown> = {}) => {
      const theme = {
        fg: (_tone: string, text: string) => text,
        strikethrough: (text: string) => text,
      };
      const ui = {
        notify: mock(() => {}),
        setStatus: mock(() => {}),
        setWidget: mock(() => {}),
        select: mock(async () => undefined),
        editor: mock(async () => undefined),
        theme,
      };
      return {
        cwd: "/tmp",
        hasUI: true,
        ui,
        sessionManager: {
          getEntries: () => sessionEntries,
        },
        ...overrides,
      };
    },
  };
}

describe("modes extension", () => {
  it("registers /plan and /todos commands", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const names = harness.commands.map((command) => command.name);
    expect(names).toContain("plan");
    expect(names).toContain("todos");
  });

  it("registers shift+tab shortcut", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    expect(harness.shortcuts).toHaveLength(1);
    expect(harness.shortcuts[0]!.key).toBe(Key.shift("tab"));
  });

  it("emits PLAN editor mode when shortcut enables planning", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    await harness.shortcuts[0]!.options.handler(harness.createContext());

    expect(harness.pi.events.emit).toHaveBeenCalledWith("editor:set-mode", { mode: "plan" });
  });

  it("registers --plan flag", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    expect(harness.flags).toHaveLength(1);
    expect(harness.flags[0]!.name).toBe("plan");
  });

  it("registers event handlers for tool_call, context, before_agent_start, turn_end, agent_end, session_start", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const events = harness.listeners.map((listener) => listener.event);
    expect(events).toContain("tool_call");
    expect(events).toContain("context");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_start");
  });

  it("does not register any tools", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    expect(harness.tools).toHaveLength(0);
  });

  it("auto-executes after plan extraction when no UI is available", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext({ hasUI: false });
    await harness.shortcuts[0]!.options.handler(ctx);

    const agentEnd = harness.getListener("agent_end");
    expect(agentEnd).toBeDefined();

    agentEnd!.handler(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Plan:\n1. Audit the flow\n2. Add tests" }],
          },
        ],
      },
      ctx,
    );

    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-todo-list")).toBe(
      true,
    );
    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-execute")).toBe(
      true,
    );
  });

  it("auto-executes after bullet-plan extraction when no UI is available", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext({ hasUI: false });
    await harness.shortcuts[0]!.options.handler(ctx);

    const agentEnd = harness.getListener("agent_end");
    expect(agentEnd).toBeDefined();

    agentEnd!.handler(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Plan:\n- Audit the flow\n- Improve coverage" }],
          },
        ],
      },
      ctx,
    );

    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-todo-list")).toBe(
      true,
    );
    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-execute")).toBe(
      true,
    );
  });

  it("restores an awaiting choice session and re-prompts on session start", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "modes",
        data: {
          mode: "AwaitingChoice",
          todoItems: [{ step: 1, text: "Audit the flow", completed: false }],
          planFilePath: "/tmp/plan.md",
          savedTools: ["read", "bash", "edit"],
          pending: {
            todoItems: [{ step: 1, text: "Audit the flow", completed: false }],
            planFilePath: "/tmp/plan.md",
            planText: "Plan:\n1. Audit the flow",
          },
        },
      },
    ]);
    modesExtension(harness.pi);

    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, harness.createContext({ hasUI: false }));

    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-execute")).toBe(
      true,
    );
    expect(harness.getActiveTools()).toEqual(["read", "bash", "edit"]);
  });
});
