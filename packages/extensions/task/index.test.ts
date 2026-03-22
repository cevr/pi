/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createTaskExtension, CONFIG_DEFAULTS, DEFAULT_DEPS, TASK_CONFIG_SCHEMA } from "./index";
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function createMockExtensionApiHarness() {
  const tools: ToolDefinition[] = [];
  const listeners: Record<string, Function[]> = {};
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const emittedEvents: Array<{ channel: string; data: unknown }> = [];

  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      (listeners[event] ??= []).push(handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
    events: {
      emit(channel: string, data: unknown) {
        emittedEvents.push({ channel, data });
      },
      on() {
        return () => {};
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    listeners,
    sentMessages,
    emittedEvents,
    getTool(name: string) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }
      return tool;
    },
  };
}

afterEach(() => {
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
});

describe("task extension", () => {
  it("registers task, result, and steer tools when enabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const createTaskRunnerSpy = mock((..._args: any[]) => {
      throw new Error("not used in registration test");
    });
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith("@cvr/pi-task", CONFIG_DEFAULTS, {
      schema: TASK_CONFIG_SCHEMA,
    });
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "Task",
      "get_task_result",
      "steer_task",
    ]);
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(3);
    expect(harness.listeners.context).toHaveLength(1);
    expect(harness.listeners.session_switch).toHaveLength(1);
    expect(harness.listeners.session_shutdown).toHaveLength(1);
  });

  it("registers no tools when disabled", () => {
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: false,
        config: defaults,
      }),
    );
    const createTaskRunnerSpy = mock((..._args: any[]) => {
      throw new Error("not used");
    });
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(withPromptPatchSpy).not.toHaveBeenCalled();
    expect(harness.tools).toHaveLength(0);
  });

  it("includes progress stats in get_task_result for background tasks", async () => {
    const record = {
      id: "task-1",
      description: "bg task",
      prompt: "do the thing",
      status: "running",
      startedAt: 1,
      messages: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      output: "working",
      outputFilePath: "/tmp/task.output.jsonl",
      sessionFilePath: "/tmp/task.session.jsonl",
      progress: {
        phase: "tool",
        turnCount: 2,
        activeTools: [{ toolCallId: "tool-1", toolName: "read", label: "read(demo.txt)" }],
        textDelta: "halfway there",
      },
    };
    const handle = {
      id: "task-1",
      result: Promise.resolve(record),
      getRecord: () => record,
      wait: async () => record,
      steer: async () => true,
      abort: async () => {},
      dispose: () => {},
      onToolActivity: () => () => {},
      onTextDelta: () => () => {},
      onSessionCreated: () => () => {},
      onCompletion: () => () => {},
    };
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const createTaskRunnerSpy = mock(() => handle);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    const taskTool = harness.getTool("Task");
    await taskTool.execute(
      "tc-1",
      { prompt: "do the thing", description: "bg task", background: true },
      undefined,
      undefined,
      { cwd: process.cwd(), model: undefined, modelRegistry: { find: () => undefined } } as any,
    );

    const getTaskResultTool = harness.getTool("get_task_result");
    const result = await getTaskResultTool.execute(
      "tc-2",
      { task_id: "task-1" },
      undefined,
      undefined,
      { cwd: process.cwd() } as any,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("Phase: tool");
    expect(text).toContain("Turn: 2");
    expect(text).toContain("Active tools: read(demo.txt)");
    expect(text).toContain("Latest text delta: halfway there");
    expect(result.details).toMatchObject({
      taskId: "task-1",
      status: "running",
      phase: "tool",
      turnCount: 2,
      activeTools: ["read(demo.txt)"],
      latestTextDelta: "halfway there",
    });
  });

  it("pushes a completion notification for background tasks", async () => {
    const record = {
      id: "task-2",
      description: "bg task",
      prompt: "do the thing",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      messages: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      output: "done",
      outputFilePath: "/tmp/task.output.jsonl",
      sessionFilePath: "/tmp/task.session.jsonl",
      progress: {
        phase: "completed",
        turnCount: 1,
        activeTools: [],
        textDelta: "done",
      },
    };
    let completionListener: ((rec: typeof record) => void) | undefined;
    let completionUnsubscribed = false;
    const handle = {
      id: "task-2",
      result: Promise.resolve(record),
      getRecord: () => ({
        ...record,
        status: "running" as const,
        completedAt: undefined,
        progress: { ...record.progress, phase: "starting" as const },
      }),
      wait: async () => record,
      steer: async () => true,
      abort: async () => {},
      dispose: () => {},
      onToolActivity: () => () => {},
      onTextDelta: () => () => {},
      onSessionCreated: () => () => {},
      onCompletion: (listener: (rec: typeof record) => void) => {
        completionListener = listener;
        return () => {
          completionUnsubscribed = true;
        };
      },
    };
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const createTaskRunnerSpy = mock(() => handle);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    const taskTool = harness.getTool("Task");
    await taskTool.execute(
      "tc-3",
      { prompt: "do the thing", description: "bg task", background: true },
      undefined,
      undefined,
      { cwd: process.cwd(), model: undefined, modelRegistry: { find: () => undefined } } as any,
    );

    completionListener?.(record);

    expect(completionUnsubscribed).toBe(true);
    expect(harness.emittedEvents).toEqual([
      {
        channel: "task:background-completed",
        data: expect.objectContaining({
          taskId: "task-2",
          description: "bg task",
          status: "completed",
          output: "done",
        }),
      },
    ]);
    expect(harness.sentMessages).toEqual([
      {
        message: expect.objectContaining({
          customType: "task-background-notification",
          content: expect.stringContaining("Background task task-2 completed."),
          details: expect.objectContaining({ taskId: "task-2", status: "completed" }),
        }),
        options: { deliverAs: "nextTurn" },
      },
    ]);
  });

  it("detaches completion notifications before session cleanup aborts tasks", async () => {
    const record = {
      id: "task-3",
      description: "bg task",
      prompt: "do the thing",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      messages: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      output: "done",
      outputFilePath: "/tmp/task.output.jsonl",
      sessionFilePath: "/tmp/task.session.jsonl",
      progress: {
        phase: "completed",
        turnCount: 1,
        activeTools: [],
        textDelta: "done",
      },
    };
    let completionListener: ((rec: typeof record) => void) | undefined;
    let unsubscribed = false;
    const handle = {
      id: "task-3",
      result: Promise.resolve(record),
      getRecord: () => ({
        ...record,
        status: "running" as const,
        completedAt: undefined,
        progress: { ...record.progress, phase: "starting" as const },
      }),
      wait: async () => record,
      steer: async () => true,
      abort: async () => {
        completionListener?.(record);
      },
      dispose: () => {},
      onToolActivity: () => () => {},
      onTextDelta: () => () => {},
      onSessionCreated: () => () => {},
      onCompletion: (listener: (rec: typeof record) => void) => {
        completionListener = listener;
        return () => {
          unsubscribed = true;
          completionListener = undefined;
        };
      },
    };
    const getEnabledExtensionConfigSpy = mock(
      <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
        enabled: true,
        config: defaults,
      }),
    );
    const createTaskRunnerSpy = mock(() => handle);
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      getEnabledExtensionConfig:
        getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    const taskTool = harness.getTool("Task");
    await taskTool.execute(
      "tc-4",
      { prompt: "do the thing", description: "bg task", background: true },
      undefined,
      undefined,
      { cwd: process.cwd(), model: undefined, modelRegistry: { find: () => undefined } } as any,
    );

    await harness.listeners.session_switch?.[0]?.();

    expect(unsubscribed).toBe(true);
    expect(harness.emittedEvents).toEqual([]);
    expect(harness.sentMessages).toEqual([]);
  });

  it("falls back to defaults for invalid config and still registers", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-task-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-task": {
        builtinTools: ["read", 123],
        extensionTools: "finder",
      },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const createTaskRunnerSpy = mock((..._args: any[]) => {
      throw new Error("not used");
    });
    const withPromptPatchSpy = mock((tool: ToolDefinition) => tool);
    const extension = createTaskExtension({
      ...DEFAULT_DEPS,
      createTaskRunner: createTaskRunnerSpy as typeof DEFAULT_DEPS.createTaskRunner,
      withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
    });
    const harness = createMockExtensionApiHarness();

    extension(harness.pi);

    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-task; falling back to defaults.",
    );
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "Task",
      "get_task_result",
      "steer_task",
    ]);
    expect(withPromptPatchSpy).toHaveBeenCalledTimes(3);
  });
});
