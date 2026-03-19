import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GraphRuntime } from "@cvr/pi-graph-runtime";
import { PiSpawnService, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "@cvr/pi-spawn";
import auditExtension, {
  ConcernBatchError,
  runConcernBatch,
  runDetection,
  runExecution,
  runSynthesis,
} from "./index";

function withFakePi<T>(run: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-pi-"));
  const binPath = path.join(dir, "pi");
  fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;

  try {
    return run();
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assistantTextMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AssistantMessage;
}

function toolResultMessage(toolCallId: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: isError ? "error" : "ok" }],
  } as ToolResultMessage;
}

function createDetectingState() {
  return {
    _tag: "Detecting" as const,
    scope: "paths" as const,
    diffStat: "",
    targetPaths: ["packages/extensions/audit"],
    skillCatalog: [{ name: "code-review", description: "Systematic code audit and cleanup" }],
    userPrompt: "check the audit flow",
    detectionFeedback: undefined,
    previousThinkingLevel: "medium" as const,
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousSynthesisSessionPaths: [],
    previousExecutionSessionPaths: [],
  };
}

function createConcernTasks() {
  return [
    {
      id: "1",
      order: 1,
      subject: "correctness",
      activeForm: "Auditing correctness",
      status: "in_progress" as const,
      blockedBy: [],
      metadata: { description: "Bugs and soundness", skills: ["code-review"] },
    },
    {
      id: "2",
      order: 2,
      subject: "frontend",
      activeForm: "Auditing frontend",
      status: "in_progress" as const,
      blockedBy: [],
      metadata: { description: "React patterns", skills: ["react", "ui"] },
    },
  ];
}

function createAuditingState(frontierTaskIds: string[] = ["1", "2"]) {
  return {
    _tag: "Auditing" as const,
    scope: "diff" as const,
    concerns: createConcernTasks(),
    diffStat: " 2 files changed",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "check react",
    cursor: {
      phase: "running" as const,
      frontierTaskIds,
      activeTaskIds: [...frontierTaskIds],
      total: 2,
    },
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousSynthesisSessionPaths: [],
    previousExecutionSessionPaths: [],
  };
}

function createSynthesizingState() {
  return {
    _tag: "Synthesizing" as const,
    scope: "diff" as const,
    concerns: createConcernTasks(),
    diffStat: " 2 files changed",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "check react",
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: ["/tmp/audit-concern-1.jsonl"],
    previousSynthesisSessionPaths: ["/tmp/audit-synthesis-0.jsonl"],
    previousExecutionSessionPaths: ["/tmp/audit-execution-0.jsonl"],
  };
}

function createExecutingState() {
  return {
    _tag: "Executing" as const,
    scope: "diff" as const,
    concerns: createConcernTasks(),
    findings: [
      {
        file: "src/app.tsx",
        description: "Null access in render path",
        severity: "critical" as const,
      },
    ],
    diffStat: " 2 files changed",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "check react",
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: ["/tmp/audit-concern-1.jsonl"],
    previousSynthesisSessionPaths: ["/tmp/audit-synthesis-0.jsonl"],
    previousExecutionSessionPaths: ["/tmp/audit-execution-0.jsonl"],
  };
}

async function runConcernBatchWithSpawn<A>(
  effect: Effect.Effect<A, ConcernBatchError, GraphRuntime | PiSpawnService>,
  spawnImpl: (config: PiSpawnConfig) => Effect.Effect<PiSpawnResult, never>,
): Promise<A> {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      GraphRuntime.layer,
      Layer.succeed(PiSpawnService, {
        spawn: spawnImpl,
      }),
    ),
  );

  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

async function runSpawnWithSpawn<A>(
  effect: Effect.Effect<A, ConcernBatchError, PiSpawnService>,
  spawnImpl: (config: PiSpawnConfig) => Effect.Effect<PiSpawnResult, never>,
): Promise<A> {
  const runtime = ManagedRuntime.make(
    Layer.succeed(PiSpawnService, {
      spawn: spawnImpl,
    }),
  );

  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

function createMockExtensionApiHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
  const commands: Array<{ name: string; command: any }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const messageRenderers: Array<{ customType: string; renderer: Function }> = [];
  const sentMessages: Array<{ message: any; options?: unknown }> = [];
  const sentUserMessages: Array<{ message: string; options?: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sessionEntries: unknown[] = [];
  let thinkingLevel = "medium";

  const pi = {
    registerTool(tool: any) {
      tools.push({ name: tool.name, tool });
    },
    registerCommand(name: string, command: any) {
      commands.push({ name, command });
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    registerMessageRenderer(customType: string, renderer: Function) {
      messageRenderers.push({ customType, renderer });
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
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    listeners,
    messageRenderers,
    sentMessages,
    sentUserMessages,
    appendedEntries,
    getThinkingLevel: () => thinkingLevel,
    getTool: (name: string) => tools.find((tool) => tool.name === name)?.tool,
    getListener: (event: string) => listeners.find((listener) => listener.event === event),
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
        select: mock(async () => new Promise<undefined>(() => {})),
        editor: mock(async () => null),
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

describe("runDetection", () => {
  it("uses the mini model and parses proposed concerns from the detection subagent", async () => {
    const state = createDetectingState();
    let seenConfig: PiSpawnConfig | undefined;

    const concerns = await runSpawnWithSpawn(
      runDetection(state, "/tmp", "session-123", "/tmp/detect.jsonl"),
      (config) => {
        seenConfig = config;
        return Effect.succeed({
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Proposed concerns ready" },
                {
                  type: "toolCall",
                  id: "tc-detect",
                  name: "audit_proposed_concerns",
                  arguments: {
                    concerns: [
                      {
                        name: "correctness",
                        description: "Bugs and soundness",
                        skills: ["code-review"],
                      },
                    ],
                  },
                } as any,
              ],
            } as AssistantMessage,
            toolResultMessage("tc-detect"),
          ],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
          model: "openai-codex/gpt-5.4-mini",
        });
      },
    );

    expect(seenConfig?.model).toBe("openai-codex/gpt-5.4-mini");
    expect(seenConfig?.builtinTools).toEqual([]);
    expect(seenConfig?.extensionTools).toEqual(["audit_proposed_concerns"]);
    expect(seenConfig?.sessionPath).toBe("/tmp/detect.jsonl");
    expect(concerns).toEqual({
      concerns: [
        {
          name: "correctness",
          description: "Bugs and soundness",
          skills: ["code-review"],
        },
      ],
      sessionPath: "/tmp/detect.jsonl",
      renderResult: expect.objectContaining({
        agent: "audit detection 1/5",
        stopReason: "end_turn",
      }),
    });
  });

  it("fails when detection exits without audit_proposed_concerns", async () => {
    const state = createDetectingState();

    const error = await runSpawnWithSpawn(
      runDetection(state, "/tmp", "session-123", "/tmp/detect.jsonl").pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 0,
          messages: [assistantTextMessage("No tool call")],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
        }),
    );

    expect(error).toBeInstanceOf(ConcernBatchError);
    expect(error.message).toContain("No tool call");
  });
});

describe("runSynthesis", () => {
  it("returns parsed findings alongside the render result", async () => {
    const state = createSynthesizingState();
    let seenConfig: PiSpawnConfig | undefined;

    const result = await runSpawnWithSpawn(
      runSynthesis(state, "/tmp", "session-123", undefined, "/tmp/synth.jsonl"),
      (config) => {
        seenConfig = config;
        return Effect.succeed({
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Synthesis complete" },
                {
                  type: "toolCall",
                  id: "tc-synth",
                  name: "audit_synthesis_complete",
                  arguments: {
                    findings: [
                      {
                        file: "src/app.tsx",
                        description: "Null access in render path",
                        severity: "critical",
                      },
                    ],
                  },
                } as any,
              ],
            } as AssistantMessage,
            toolResultMessage("tc-synth"),
          ],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
        });
      },
    );

    expect(seenConfig?.model).toBe("openai-codex/gpt-5.4-mini");
    expect(result.sessionPath).toBe("/tmp/synth.jsonl");
    expect(result.findings).toEqual([
      {
        file: "src/app.tsx",
        description: "Null access in render path",
        severity: "critical",
      },
    ]);
  });
});

describe("runExecution", () => {
  it("returns the parsed execution outcome alongside the render result", async () => {
    const state = createExecutingState();
    let seenConfig: PiSpawnConfig | undefined;

    const result = await runSpawnWithSpawn(
      runExecution(state, "/tmp", "session-123", undefined, "/tmp/exec.jsonl"),
      (config) => {
        seenConfig = config;
        return Effect.succeed({
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Execution complete" },
                {
                  type: "toolCall",
                  id: "tc-exec",
                  name: "audit_execution_result",
                  arguments: { outcome: "completed" },
                } as any,
              ],
            } as AssistantMessage,
            toolResultMessage("tc-exec"),
          ],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
        });
      },
    );

    expect(seenConfig?.thinking).toBe("xhigh");
    expect(result.sessionPath).toBe("/tmp/exec.jsonl");
    expect(result.outcome).toBe("completed");
  });
});

describe("runConcernBatch", () => {
  it("strips the completion marker from concern notes and preserves frontier order", async () => {
    const state = createAuditingState(["1", "2"]);
    const seenTasks: string[] = [];
    const seenThinking: string[] = [];

    const results = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", "Follow principles", new Map()),
      (config) => {
        seenTasks.push(config.task);
        seenThinking.push(config.thinking ?? "");
        expect(config.sessionPath).toEqual(expect.stringContaining("audit-"));
        const toolCallId = config.task.includes("correctness") ? "tc-correctness" : "tc-frontend";
        const text = config.task.includes("correctness")
          ? "Found a null bug in src/app.tsx"
          : "Frontend looks clean";
        return Effect.succeed({
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text },
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "audit_concern_complete",
                  arguments: {},
                } as any,
              ],
            } as AssistantMessage,
            toolResultMessage(toolCallId),
          ],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
        });
      },
    );

    expect(seenTasks[0]).toContain("Audit concern 1/2: correctness");
    expect(seenTasks[1]).toContain("Audit concern 2/2: frontend");
    expect(seenThinking).toEqual(["xhigh", "xhigh"]);
    expect(results).toEqual([
      {
        taskId: "1",
        notes: "Found a null bug in src/app.tsx",
        sessionPath: expect.stringContaining("audit-1-correctness"),
        renderResult: expect.objectContaining({
          agent: "audit concern 1/2",
          model: undefined,
        }),
      },
      {
        taskId: "2",
        notes: "Frontend looks clean",
        sessionPath: expect.stringContaining("audit-2-frontend"),
        renderResult: expect.objectContaining({
          agent: "audit concern 2/2",
          model: undefined,
        }),
      },
    ]);
  });

  it("fails with stderr when the subagent output is missing the completion tool call", async () => {
    const state = createAuditingState(["1"]);

    const error = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", undefined, new Map()).pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 0,
          messages: [assistantTextMessage("Still thinking")],
          stderr: "subagent omitted completion signal",
          usage: zeroUsage(),
          stopReason: "end_turn",
        }),
    );

    expect(error).toBeInstanceOf(ConcernBatchError);
    expect(error.message).toContain("subagent omitted completion signal");
    expect(error.message).toContain("Concern transcript:");
  });

  it("fails when the frontier references a missing concern", async () => {
    const state = createAuditingState(["3"]);

    const error = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", undefined, new Map()).pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 0,
          messages: [assistantTextMessage("unused")],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "end_turn",
        }),
    );

    expect(error).toBeInstanceOf(ConcernBatchError);
    expect(error.message).toBe("audit: missing concern for task 3");
  });

  it("uses errorMessage before stderr before raw output when shaping failures", async () => {
    const state = createAuditingState(["1"]);

    const withErrorMessage = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", undefined, new Map()).pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 1,
          messages: [assistantTextMessage("raw output")],
          stderr: "stderr output",
          errorMessage: "typed failure",
          usage: zeroUsage(),
          stopReason: "error",
        }),
    );

    const withStderr = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", undefined, new Map()).pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 1,
          messages: [assistantTextMessage("raw output")],
          stderr: "stderr output",
          usage: zeroUsage(),
          stopReason: "error",
        }),
    );

    const withRawOutput = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", undefined, new Map()).pipe(Effect.flip),
      () =>
        Effect.succeed({
          exitCode: 1,
          messages: [assistantTextMessage("raw output")],
          stderr: "",
          usage: zeroUsage(),
          stopReason: "error",
        }),
    );

    expect(withErrorMessage).toBeInstanceOf(ConcernBatchError);
    expect(withErrorMessage.message).toContain("typed failure");
    expect(withErrorMessage.message).toContain("Concern transcript:");
    expect(withStderr).toBeInstanceOf(ConcernBatchError);
    expect(withStderr.message).toContain("stderr output");
    expect(withStderr.message).toContain("Concern transcript:");
    expect(withRawOutput).toBeInstanceOf(ConcernBatchError);
    expect(withRawOutput.message).toContain("raw output");
    expect(withRawOutput.message).toContain("Concern transcript:");
  });
});

describe("audit extension", () => {
  it("registers /audit, audit helper commands, the concern renderer, and the audit signal tools", () => {
    const harness = createMockExtensionApiHarness();
    auditExtension(harness.pi);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "audit_proposed_concerns",
      "audit_concern_complete",
      "audit_synthesis_complete",
      "audit_execution_result",
    ]);
    expect(harness.messageRenderers.map((entry) => entry.customType)).toEqual([
      "audit-phase-result",
    ]);
    expect(harness.commands.map((command) => command.name)).toEqual([
      "audit-cancel",
      "audit-status",
      "audit",
    ]);
  });

  it("restores awaiting approval and prompts the user", async () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "AwaitingConcernApproval",
          scope: "diff",
          diffStat: " 2 files changed",
          targetPaths: ["src/app.tsx"],
          skillCatalog: [],
          userPrompt: "check react",
          previousThinkingLevel: "medium",
          proposedConcerns: [
            {
              name: "correctness",
              description: "Bugs and soundness",
              skills: ["code-review"],
            },
          ],
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    await harness.getListener("session_start")!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: approve concerns");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1. correctness"), "info");
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Audit concerns ready"), [
      "Approve concerns",
      "Reject concerns",
      "Edit concerns",
    ]);
  });

  it("launches audits after UI approval", async () => {
    await withFakePi(async () => {
      const harness = createMockExtensionApiHarness();
      harness.setSessionEntries([
        {
          type: "custom",
          customType: "audit",
          data: {
            mode: "AwaitingConcernApproval",
            scope: "diff",
            diffStat: " 2 files changed",
            targetPaths: ["src/app.tsx"],
            skillCatalog: [],
            userPrompt: "check react",
            previousThinkingLevel: "medium",
            proposedConcerns: [
              {
                name: "correctness",
                description: "Bugs and soundness",
                skills: ["code-review"],
              },
            ],
          },
        },
      ]);
      auditExtension(harness.pi);

      const ctx = harness.createContext();
      ctx.ui.select = mock(async () => "Approve concerns");
      await harness.getListener("session_start")!.handler({}, ctx);
      await Promise.resolve();

      expect(harness.appendedEntries.some((entry) => entry.customType === "audit")).toBe(true);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: loop 1/5 0/1");
    });
  });

  it("feeds edited concern feedback back into detection", async () => {
    await withFakePi(async () => {
      const harness = createMockExtensionApiHarness();
      harness.setSessionEntries([
        {
          type: "custom",
          customType: "audit",
          data: {
            mode: "AwaitingConcernApproval",
            scope: "diff",
            diffStat: " 2 files changed",
            targetPaths: ["src/app.tsx"],
            skillCatalog: [],
            userPrompt: "check react",
            previousThinkingLevel: "medium",
            proposedConcerns: [
              {
                name: "correctness",
                description: "Bugs and soundness",
                skills: ["code-review"],
              },
            ],
          },
        },
      ]);
      auditExtension(harness.pi);

      const ctx = harness.createContext();
      ctx.ui.select = mock(async () => "Edit concerns");
      ctx.ui.editor = mock(async () => "Merge correctness into architecture and add duplication.");
      await harness.getListener("session_start")!.handler({}, ctx);
      await Promise.resolve();

      expect(ctx.ui.editor).toHaveBeenCalledWith(
        expect.stringContaining("Edit audit concerns"),
        expect.stringContaining("skills: code-review"),
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: loop 1/5 detecting");
      expect(harness.sentUserMessages).toEqual([]);
      expect(harness.appendedEntries.at(-1)).toEqual(
        expect.objectContaining({
          customType: "audit",
          data: expect.objectContaining({
            mode: "Detecting",
            detectionFeedback: "Merge correctness into architecture and add duplication.",
          }),
        }),
      );
    });
  });

  it("allows audit_proposed_concerns from spawned sessions without mutating idle parent state", async () => {
    const harness = createMockExtensionApiHarness();
    auditExtension(harness.pi);

    const result = await harness.getTool("audit_proposed_concerns").execute("tc-1", {
      concerns: [
        { name: "correctness", description: "Bugs and soundness", skills: ["code-review"] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Captured 1 proposed audit concern");
    expect(harness.appendedEntries).toEqual([]);
  });

  it("restores persisted AwaitingConcernApproval state on session start", async () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "AwaitingConcernApproval",
          scope: "paths",
          proposedConcerns: [
            {
              name: "architecture",
              description: "Check extension architecture consistency",
              skills: ["architecture"],
            },
          ],
          targetPaths: ["packages/extensions"],
          skillCatalog: [],
          userPrompt: "check architecture",
          previousThinkingLevel: "medium",
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    await harness.getListener("session_start")!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: approve concerns");
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Audit concerns ready"), [
      "Approve concerns",
      "Reject concerns",
      "Edit concerns",
    ]);
  });

  it("restores persisted Auditing state on session start", () => {
    withFakePi(() => {
      const harness = createMockExtensionApiHarness();
      harness.setSessionEntries([
        {
          type: "custom",
          customType: "audit",
          data: {
            mode: "Auditing",
            scope: "diff",
            concerns: [
              {
                id: "1",
                order: 1,
                subject: "correctness",
                activeForm: "Auditing correctness",
                status: "completed",
                blockedBy: [],
                metadata: { description: "Bugs and soundness", skills: ["code-review"] },
              },
              {
                id: "2",
                order: 2,
                subject: "frontend",
                activeForm: "Auditing frontend",
                status: "pending",
                blockedBy: [],
                metadata: { description: "React patterns", skills: ["react", "ui"] },
              },
            ],
            diffStat: " 2 files changed",
            targetPaths: ["src/app.tsx", "src/lib.ts"],
            userPrompt: "check react",
            concernCursor: {
              phase: "running",
              frontierTaskIds: ["2"],
              activeTaskIds: ["2"],
              total: 2,
            },
          },
        },
      ]);
      auditExtension(harness.pi);

      const ctx = harness.createContext();
      const sessionStart = harness.getListener("session_start");
      expect(sessionStart).toBeDefined();

      sessionStart!.handler({}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: loop 1/5 1/2");
      const widgetCalls = (ctx.ui.setWidget as ReturnType<typeof mock>).mock.calls;
      expect(widgetCalls.at(-1)?.[0]).toBe("audit-progress");
      expect(widgetCalls.at(-1)?.[1]).toEqual(["audit loop 1/5", "1/2 complete"]);
    });
  });

  it("keeps Detecting active after agent_end without surfacing a missing main-session signal", async () => {
    withFakePi(() => {
      const harness = createMockExtensionApiHarness();
      harness.setSessionEntries([
        {
          type: "custom",
          customType: "audit",
          data: {
            mode: "Detecting",
            scope: "paths",
            diffStat: "",
            targetPaths: ["packages/extensions"],
            skillCatalog: [],
            userPrompt: "check architecture",
            previousThinkingLevel: "medium",
          },
        },
      ]);
      auditExtension(harness.pi);

      const ctx = harness.createContext();
      harness.getListener("session_start")!.handler({}, ctx);
      harness.getListener("agent_end")!.handler({ messages: [] }, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "audit: concern detection ended before audit_proposed_concerns was called",
        "error",
      );
    });
  });

  it("does not cancel AwaitingConcernApproval on interactive input", async () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "AwaitingConcernApproval",
          scope: "paths",
          targetPaths: ["packages/extensions"],
          skillCatalog: [],
          userPrompt: "check architecture",
          previousThinkingLevel: "medium",
          proposedConcerns: [
            {
              name: "architecture",
              description: "Check extension architecture consistency",
              skills: ["architecture"],
            },
          ],
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);
    harness.getListener("input")!.handler({ source: "interactive", text: "approve" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: approve concerns");
  });

  it("does not inject main-agent audit context while concern subagents are running", () => {
    withFakePi(() => {
      const harness = createMockExtensionApiHarness();
      harness.setSessionEntries([
        {
          type: "custom",
          customType: "audit",
          data: {
            mode: "Auditing",
            scope: "diff",
            concerns: [
              {
                id: "1",
                order: 1,
                subject: "correctness",
                activeForm: "Auditing correctness",
                status: "completed",
                blockedBy: [],
                metadata: { description: "Bugs and soundness", skills: ["code-review"] },
              },
              {
                id: "2",
                order: 2,
                subject: "frontend",
                activeForm: "Auditing frontend",
                status: "pending",
                blockedBy: [],
                metadata: { description: "React patterns", skills: ["react", "ui"] },
              },
            ],
            diffStat: " 2 files changed",
            targetPaths: ["src/app.tsx", "src/lib.ts"],
            userPrompt: "check react",
            concernCursor: {
              phase: "running",
              frontierTaskIds: ["2"],
              activeTaskIds: ["2"],
              total: 2,
            },
          },
        },
      ]);
      auditExtension(harness.pi);

      const ctx = harness.createContext();
      const sessionStart = harness.getListener("session_start");
      const beforeAgentStart = harness.getListener("before_agent_start");
      expect(sessionStart).toBeDefined();
      expect(beforeAgentStart).toBeDefined();

      sessionStart!.handler({}, ctx);

      expect(beforeAgentStart!.handler({}, ctx)).toBeUndefined();
    });
  });

  it("keeps audit trigger messages in context while stripping passive audit status messages", () => {
    const harness = createMockExtensionApiHarness();
    auditExtension(harness.pi);

    const context = harness.getListener("context");
    expect(context).toBeDefined();

    const reply = context!.handler({
      messages: [
        { role: "custom", customType: "audit-context", content: "hidden" },
        { role: "custom", customType: "audit-progress", content: "progress" },
        { role: "custom", customType: "audit-trigger", content: "detect concerns" },
        { role: "custom", customType: "audit-fix", content: "fix finding" },
        { role: "user", content: "real user message" },
      ],
    });

    expect(reply.messages).toEqual([
      { role: "custom", customType: "audit-trigger", content: "detect concerns" },
      { role: "custom", customType: "audit-fix", content: "fix finding" },
      { role: "user", content: "real user message" },
    ]);
  });

  it("restores persisted Executing state on session start", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "Executing",
          scope: "diff",
          concerns: [
            {
              id: "1",
              order: 1,
              subject: "correctness",
              activeForm: "Auditing correctness",
              status: "completed",
              blockedBy: [],
              metadata: { description: "Bugs and soundness", skills: ["code-review"] },
            },
          ],
          findings: [
            { file: "src/app.tsx", description: "Missing null check", severity: "critical" },
            { file: "src/lib.ts", description: "Unused import", severity: "warning" },
          ],
          diffStat: " 2 files changed",
          targetPaths: ["src/app.tsx", "src/lib.ts"],
          userPrompt: "check react",
          iteration: 2,
          maxIterations: 5,
          previousSynthesisSessionPaths: ["/tmp/synth-1.jsonl"],
          previousExecutionSessionPaths: ["/tmp/exec-1.jsonl"],
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: loop 2/5 executing");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("audit-progress", [
      "audit loop 2/5",
      "executing plan",
    ]);
  });

  it("keeps previous session paths when restoring later-loop auditing state", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "Auditing",
          scope: "diff",
          concerns: [
            {
              id: "1",
              order: 1,
              subject: "correctness",
              activeForm: "Auditing correctness",
              status: "completed",
              blockedBy: [],
              metadata: { description: "Bugs and soundness", skills: ["code-review"] },
            },
            {
              id: "2",
              order: 2,
              subject: "frontend",
              activeForm: "Auditing frontend",
              status: "pending",
              blockedBy: [],
              metadata: { description: "React patterns", skills: ["react", "ui"] },
            },
          ],
          diffStat: " 2 files changed",
          targetPaths: ["src/app.tsx", "src/lib.ts"],
          userPrompt: "check react",
          concernCursor: {
            phase: "running",
            frontierTaskIds: ["2"],
            activeTaskIds: ["2"],
            total: 2,
          },
          iteration: 3,
          maxIterations: 5,
          previousConcernSessionPaths: ["/tmp/audit-1.jsonl"],
          previousSynthesisSessionPaths: ["/tmp/synth-1.jsonl"],
          previousExecutionSessionPaths: ["/tmp/exec-1.jsonl"],
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: loop 3/5 1/2");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("audit-progress", [
      "audit loop 3/5",
      "1/2 complete",
    ]);
  });
});
