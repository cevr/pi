import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Effect } from "effect";
import { createTaskList } from "@cvr/pi-task-list";
import { TaskListStore } from "@cvr/pi-task-list-store";
import modesExtension, { createModesExtension } from "./index";

afterEach(async () => {
  await TaskListStore.clearRuntimeCache();
});

function createMockExtensionApiHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
  const commands: Array<{ name: string; command: any }> = [];
  const shortcuts: Array<{ key: unknown; options: any }> = [];
  const flags: Array<{ name: string; options: unknown }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const sentMessages: Array<{ message: any; options?: unknown }> = [];
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
  const sessionEntries: unknown[] = [];
  const flagValues = new Map<string, unknown>();
  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "skill"];
  let thinkingLevel = "off";
  let sessionId = 0;

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
    sendUserMessage(content: string, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
    appendEntry() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
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
    getActiveTools: () => activeTools,
    getThinkingLevel: () => thinkingLevel,
    getTool: (name: string) => tools.find((tool) => tool.name === name)?.tool,
    getListener: (event: string) => listeners.find((listener) => listener.event === event),
    setFlag: (name: string, value: unknown) => {
      flagValues.set(name, value);
    },
    setSessionEntries: (entries: unknown[]) => {
      sessionEntries.splice(0, sessionEntries.length, ...entries);
    },
    createContext: (overrides: Record<string, unknown> = {}) => {
      const generatedSessionId = `test-session-${++sessionId}`;
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
          getSessionId: () => generatedSessionId,
        },
        ...overrides,
      };
    },
  };
}

describe("modes extension", () => {
  it("registers /spec and /todos commands", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);
    expect(harness.commands.map((command) => command.name)).toEqual(["todos", "spec"]);
  });

  it("registers nothing when disabled by config", () => {
    const harness = createMockExtensionApiHarness();
    const extension = createModesExtension({
      getEnabledExtensionConfig: <T extends Record<string, unknown>>(
        _namespace: string,
        defaults: T,
      ) => ({
        enabled: false,
        config: defaults,
      }),
    });

    extension(harness.pi);
    expect(harness.commands).toHaveLength(0);
    expect(harness.tools).toHaveLength(0);
    expect(harness.listeners).toHaveLength(0);
  });

  it("registers auto, spec, task-list, and execution signal tools", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "modes_enter_spec",
      "modes_spec_ready",
      "modes_task_list_ready",
      "modes_step_done",
      "modes_gate_result",
      "modes_counsel_result",
    ]);
  });

  it("registers shift+tab and --spec", () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);
    expect(harness.shortcuts[0]!.key).toBe(Key.shift("tab"));
    expect(harness.flags[0]).toMatchObject({ name: "spec" });
  });

  it("emits SPEC editor mode and xhigh thinking when shortcut enables spec mode", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);
    await harness.shortcuts[0]!.options.handler(harness.createContext());
    expect(harness.pi.events.emit).toHaveBeenCalledWith("editor:set-mode", { mode: "spec" });
    expect(harness.getThinkingLevel()).toBe("xhigh");
  });

  it("captures a spec when SPEC mode is active", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);
    await harness.shortcuts[0]!.options.handler(harness.createContext());

    const specReady = harness.getTool("modes_spec_ready");
    const result = await specReady.execute("tc-1", { specText: "# Spec\n\nGoals" });

    expect(result.isError).toBeUndefined();
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-review:spec"),
    ).toBe(true);
  });

  it("lets AUTO mode escalate into SPEC mode via tool, records a history entry, and switches to xhigh thinking", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

    const enterSpec = harness.getTool("modes_enter_spec");
    const result = await enterSpec.execute(
      "tc-1",
      { prompt: "Write a PRD for the architecture." },
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(harness.getThinkingLevel()).toBe("xhigh");
    expect(harness.getActiveTools()).toEqual([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "interview",
      "modes_spec_ready",
    ]);
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-transition:spec"),
    ).toBe(true);
    expect(harness.sentUserMessages).toContainEqual({
      content: "Write a PRD for the architecture.",
      options: { deliverAs: "followUp" },
    });
  });

  it("hydrates AUTO mode with medium thinking and starts execution when a task list is captured", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

    expect(harness.getThinkingLevel()).toBe("medium");

    const taskListReady = harness.getTool("modes_task_list_ready");
    const result = await taskListReady.execute("tc-1", {
      planText: "# Task List\n1. Audit\n2. Add tests",
      steps: ["Audit", "Add tests"],
    });

    expect(result.isError).toBeUndefined();
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-plan:task-list"),
    ).toBe(true);
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-execution:start"),
    ).toBe(true);
    expect(harness.getActiveTools()).toContain("modes_step_done");
  });

  it("restores a stored task list on session start when session entries are empty", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-modes-restore-"));
    const runtime = TaskListStore.runtime({ cwd, scope: "session", sessionId: "test-session" });
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* TaskListStore;
        yield* store.save(createTaskList(["Recovered step"]));
      }),
    );

    const ctx = harness.createContext({
      cwd,
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => "test-session",
      },
    });
    for (const listener of harness.listeners.filter(
      (listener) => listener.event === "session_start",
    )) {
      await listener.handler({}, ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(harness.getThinkingLevel()).toBe("medium");
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-execution:start"),
    ).toBe(true);
    expect(harness.getActiveTools()).toContain("modes_step_done");

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("restores project-scoped task lists across session ids", async () => {
    const harness = createMockExtensionApiHarness();
    const extension = createModesExtension({
      getEnabledExtensionConfig: <T extends Record<string, unknown>>(
        _namespace: string,
        defaults: T,
      ) => ({
        enabled: true,
        config: { ...defaults, taskListScope: "project" },
      }),
    });
    extension(harness.pi);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-modes-project-"));
    const runtime = TaskListStore.runtime({ cwd, scope: "project", sessionId: "ignored" });
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* TaskListStore;
        yield* store.save(createTaskList(["Project step"]));
      }),
    );

    const ctx = harness.createContext({
      cwd,
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => "another-session",
      },
    });
    for (const listener of harness.listeners.filter(
      (listener) => listener.event === "session_start",
    )) {
      await listener.handler({}, ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(harness.getThinkingLevel()).toBe("medium");
    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-execution:start"),
    ).toBe(true);
    expect(harness.getActiveTools()).toContain("modes_step_done");

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("does not block tool calls after task-list capture because execution begins immediately", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

    const taskListReady = harness.getTool("modes_task_list_ready");
    await taskListReady.execute("tc-1", { planText: "# Task List\n1. Audit", steps: ["Audit"] });

    const toolCall = harness.getListener("tool_call");
    const reply = toolCall!.handler({ toolName: "read", input: { path: "/tmp/foo" } }, ctx);
    expect(reply).toBeUndefined();
  });

  it("rejects marking a non-active step done after execution starts", async () => {
    const harness = createMockExtensionApiHarness();
    modesExtension(harness.pi);

    const taskListReady = harness.getTool("modes_task_list_ready");
    await taskListReady.execute("tc-1", {
      planText: "# Task List\n1. First\n2. Second",
      steps: ["First", "Second"],
    });

    harness.getListener("session_switch")!.handler({}, harness.createContext());
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "modes",
        data: {
          mode: "Executing",
          todoItems: [
            { id: "1", order: 1, subject: "First", status: "in_progress", blockedBy: [] },
            { id: "2", order: 2, subject: "Second", status: "pending", blockedBy: [] },
          ],
          planFilePath: "/tmp/task-list.md",
          savedTools: ["read", "bash", "edit"],
          currentStep: 1,
          phase: "running",
        },
      },
    ]);
    harness.getListener("session_start")!.handler({}, harness.createContext({ hasUI: false }));

    const stepDone = harness.getTool("modes_step_done");
    const result = await stepDone.execute("tc-2", { step: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Step 1 is currently active");
  });

  it("hydrates legacy AwaitingChoice sessions into executing mode", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "modes",
        data: {
          mode: "AwaitingChoice",
          todoItems: [{ step: 1, text: "Audit the flow", completed: false }],
          planFilePath: "/tmp/task-list.md",
          savedTools: ["read", "bash", "edit"],
          pending: {
            todoItems: [{ step: 1, text: "Audit the flow", completed: false }],
            planFilePath: "/tmp/task-list.md",
            planText: "# Task List\n1. Audit the flow",
          },
        },
      },
    ]);
    modesExtension(harness.pi);

    const ctx = harness.createContext({ hasUI: false });
    const sessionStart = harness.getListener("session_start");
    sessionStart!.handler({}, ctx);

    expect(
      harness.sentMessages.some((entry) => entry.message.customType === "modes-execution:start"),
    ).toBe(false);
    expect(harness.getActiveTools()).toContain("modes_step_done");
  });

  it("renders the task widget when restoring execution", () => {
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
          planFilePath: "/tmp/task-list.md",
          savedTools: ["read", "bash", "edit"],
        },
      },
    ]);
    modesExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

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
});
