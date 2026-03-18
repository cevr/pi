import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { createTaskRunner, type TaskRunnerConfig } from "./index";

function makeTextMessage(role: Message["role"], text: string, extra: Record<string, unknown> = {}): Message {
  return {
    role,
    content: [{ type: "text", text }],
    ...extra,
  } as Message;
}

class FakeSession {
  messages: Message[] = [];
  sessionFile = "/tmp/task-session.jsonl";
  sessionId = "task-session";
  activeTools: string[] = [];
  steerCalls: string[] = [];
  aborted = false;
  disposed = false;
  listeners = new Set<(event: AgentSessionEvent) => void>();
  promptImpl: (() => Promise<void>) | undefined;

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async prompt(): Promise<void> {
    await this.promptImpl?.();
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function makeConfig(overrides: Partial<TaskRunnerConfig> = {}): TaskRunnerConfig {
  return {
    cwd: process.cwd(),
    prompt: "do the thing",
    description: "test task",
    builtinTools: ["read", "bash"],
    extensionTools: ["finder"],
    modelRegistry: {
      find() {
        return undefined;
      },
    },
    ...overrides,
  };
}

function makeTempOutputPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-runner-test-"));
  return path.join(dir, "task.output.jsonl");
}

afterEach(() => {
  // temp dirs are left for debugging
});

describe("createTaskRunner", () => {
  it("collects output, usage, and transcript entries", async () => {
    const session = new FakeSession();
    const outputFilePath = makeTempOutputPath();

    session.promptImpl = async () => {
      session.messages.push(makeTextMessage("user", "do the thing"));
      session.emit({ type: "message_end", message: session.messages[0]! } as AgentSessionEvent);

      session.messages.push(
        makeTextMessage("assistant", "done", {
          usage: { input: 10, output: 4, cacheRead: 2, totalTokens: 16, cost: { total: 0.25 } },
          model: "openai-codex/gpt-5.4",
          stopReason: "end_turn",
        }),
      );
      session.emit({ type: "message_end", message: session.messages[1]! } as AgentSessionEvent);
      session.emit({ type: "turn_end" } as AgentSessionEvent);
      session.emit({ type: "agent_end", messages: session.messages } as AgentSessionEvent);
    };

    const handle = createTaskRunner(makeConfig({ outputFilePath }), {
      createSession: async () => session,
      createOutputFilePath: () => outputFilePath,
      now: () => 1,
      generateId: () => "task-1",
    });

    const result = await handle.wait();

    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(result.model).toBe("openai-codex/gpt-5.4");
    expect(result.usage).toMatchObject({
      input: 10,
      output: 4,
      cacheRead: 2,
      contextTokens: 16,
      turns: 1,
      cost: 0.25,
    });

    const transcript = fs.readFileSync(outputFilePath, "utf-8").trim().split("\n");
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toContain('"role":"user"');
    expect(transcript[1]).toContain('"role":"assistant"');
    expect(session.disposed).toBe(true);
  });

  it("queues steering sent before the session is ready", async () => {
    const session = new FakeSession();
    let resolveSession: ((session: FakeSession) => void) | undefined;
    const sessionPromise = new Promise<FakeSession>((resolve) => {
      resolveSession = resolve;
    });

    let resolvePrompt: (() => void) | undefined;
    session.promptImpl = () =>
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });

    const handle = createTaskRunner(makeConfig(), {
      createSession: () => sessionPromise,
      createOutputFilePath: () => makeTempOutputPath(),
      now: () => 1,
      generateId: () => "task-2",
    });

    expect(await handle.steer("course correct")).toBe(true);
    resolveSession?.(session);
    for (let index = 0; index < 5 && !resolvePrompt; index += 1) {
      await Promise.resolve();
    }
    expect(resolvePrompt).toBeDefined();
    resolvePrompt?.();
    await handle.wait();

    expect(session.steerCalls).toEqual(["course correct"]);
  });

  it("reports progress via callbacks and record snapshots", async () => {
    const session = new FakeSession();
    const toolProgress: string[][] = [];
    const textDeltas: string[] = [];
    const sessionCreated: string[] = [];

    session.promptImpl = async () => {
      session.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 } as AgentSessionEvent);
      session.messages.push(makeTextMessage("user", "do the thing"));
      session.emit({ type: "message_end", message: session.messages[0]! } as AgentSessionEvent);

      session.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/tmp/demo.txt" },
      } as AgentSessionEvent);
      session.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: {},
        isError: false,
      } as AgentSessionEvent);

      const assistant = makeTextMessage("assistant", "done", {
        usage: { input: 10, output: 4, cacheRead: 2, totalTokens: 16, cost: { total: 0.25 } },
        model: "openai-codex/gpt-5.4",
        stopReason: "end_turn",
      });
      session.messages.push(assistant);
      session.emit({ type: "message_start", message: assistant } as AgentSessionEvent);
      session.emit({
        type: "message_update",
        message: assistant,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "done",
          partial: assistant,
        },
      } as AgentSessionEvent);
      session.emit({ type: "message_end", message: assistant } as AgentSessionEvent);
      session.emit({ type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] } as AgentSessionEvent);
      session.emit({ type: "agent_end", messages: session.messages } as AgentSessionEvent);
    };

    const handle = createTaskRunner(makeConfig(), {
      createSession: async () => session,
      createOutputFilePath: () => makeTempOutputPath(),
      now: () => 1,
      generateId: () => "task-3",
    });

    handle.onToolActivity((progress) => {
      toolProgress.push(progress.activeTools.map((tool) => tool.label));
    });
    handle.onTextDelta((delta) => {
      textDeltas.push(delta);
    });
    handle.onSessionCreated((record) => {
      if (record.outputFilePath) {
        sessionCreated.push(record.outputFilePath);
      }
    });

    const result = await handle.wait();

    expect(sessionCreated).toHaveLength(1);
    expect(toolProgress).toEqual([["read(demo.txt)"], []]);
    expect(textDeltas).toEqual(["done"]);
    expect(result.progress).toMatchObject({
      phase: "completed",
      turnCount: 1,
      textDelta: "done",
      activeTools: [],
    });
  });

  it("aborts a running task", async () => {
    const session = new FakeSession();
    let resolvePrompt: (() => void) | undefined;
    session.promptImpl = () =>
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });

    const handle = createTaskRunner(makeConfig(), {
      createSession: async () => session,
      createOutputFilePath: () => makeTempOutputPath(),
      now: () => 1,
      generateId: () => "task-4",
    });

    await Promise.resolve();
    await handle.abort();
    resolvePrompt?.();
    const result = await handle.wait();

    expect(session.aborted).toBe(true);
    expect(result.status).toBe("aborted");
  });
});
