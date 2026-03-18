import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import modesExtension from "./index";

function createMockExtensionApiHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
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
    registerTool(tool: any) {
      tools.push({ name: tool.name, tool });
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
    getTool: (name: string) => tools.find((tool) => tool.name === name)?.tool,
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

  it("registers signal tools", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "modes_plan_ready",
      "modes_step_done",
      "modes_gate_result",
      "modes_counsel_result",
    ]);
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

  it("registers event handlers for tool_call, context, before_agent_start, session_start", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const events = harness.listeners.map((listener) => listener.event);
    expect(events).toContain("tool_call");
    expect(events).toContain("context");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("session_start");
    expect(events).not.toContain("agent_end");
    expect(events).not.toContain("turn_end");
  });

  it("plan signal captures the plan and auto-executes with no UI", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext({ hasUI: false });
    await harness.shortcuts[0]!.options.handler(ctx);

    const planReady = harness.getTool("modes_plan_ready");
    expect(planReady).toBeDefined();

    const result = await planReady.execute("tc-1", {
      planText: "## Plan\n1. Audit the flow\n2. Add tests",
      steps: ["Audit the flow", "Add tests"],
    });

    expect(result.isError).toBeUndefined();
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-todo-list"),
    ).toBe(true);
    expect(harness.sentMessages.some((entry) => entry.message.customType === "modes-execute")).toBe(
      true,
    );
  });

  it("blocks further tool calls while awaiting choice", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    ctx.ui.select = mock(async () => new Promise<undefined>(() => {}));
    await harness.shortcuts[0]!.options.handler(ctx);

    const planReady = harness.getTool("modes_plan_ready");
    await planReady.execute("tc-1", {
      planText: "## Plan\n1. Audit the flow",
      steps: ["Audit the flow"],
    });

    const toolCall = harness.getListener("tool_call");
    const reply = toolCall!.handler({ toolName: "read", input: { path: "/tmp/foo" } }, ctx);
    expect(reply).toMatchObject({ block: true });
  });

  it("rejects marking a non-active step done", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext({ hasUI: false });
    await harness.shortcuts[0]!.options.handler(ctx);

    const planReady = harness.getTool("modes_plan_ready");
    await planReady.execute("tc-1", {
      planText: "## Plan\n1. First\n2. Second",
      steps: ["First", "Second"],
    });

    const stepDone = harness.getTool("modes_step_done");
    const result = await stepDone.execute("tc-2", { step: 2 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Step 1 is currently active");
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
    expect(harness.getActiveTools()).toContain("modes_step_done");
  });

  it("renders the extracted task widget when restoring execution", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "modes",
        data: {
          mode: "Executing",
          todoItems: [
            { id: "1", order: 1, subject: "First", status: "completed", blockedBy: [] },
            { id: "2", order: 2, subject: "Second", status: "in_progress", blockedBy: [] },
            { id: "3", order: 3, subject: "Third", status: "pending", blockedBy: ["2"] },
          ],
          planFilePath: "/tmp/plan.md",
          savedTools: ["read", "bash", "edit"],
        },
      },
    ]);
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "modes",
      "📋 3 tasks (1 done, 1 in progress, 1 open)",
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("modes-todos", [
      "✔ First",
      "◼ Second",
      "◻ Third › blocked by #2",
    ]);
  });

  it("restores the persisted gate phase on session start", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "modes",
        data: {
          mode: "Executing",
          todoItems: [
            { id: "1", order: 1, subject: "First", status: "completed", blockedBy: [] },
            { id: "2", order: 2, subject: "Second", status: "in_progress", blockedBy: [] },
          ],
          planFilePath: "/tmp/plan.md",
          savedTools: ["read", "bash", "edit"],
          currentStep: 2,
          phase: "gating",
        },
      },
    ]);
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "modes",
      "📋 2 tasks (1 done, 1 in progress) ⚙ gate",
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("modes-todos", ["✔ First", "◼ Second (gate)"]);
  });
});
