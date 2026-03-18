import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GraphRuntime } from "@cvr/pi-graph-runtime";
import { PiSpawnService, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "@cvr/pi-spawn";
import auditExtension, { ConcernBatchError, runConcernBatch } from "./index";

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

function createAuditingState(frontierTaskIds: string[] = ["1", "2"]) {
  return {
    _tag: "Auditing" as const,
    scope: "diff" as const,
    concerns: [
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
    ],
    diffStat: " 2 files changed",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "check react",
    cursor: {
      phase: "running" as const,
      frontierTaskIds,
      activeTaskIds: [...frontierTaskIds],
      total: 2,
    },
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

function createMockExtensionApiHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
  const commands: Array<{ name: string; command: any }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const sentMessages: Array<{ message: any; options?: unknown }> = [];
  const sentUserMessages: Array<{ message: string; options?: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sessionEntries: unknown[] = [];

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
    sendMessage(message: any, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: string, options?: unknown) {
      sentUserMessages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    listeners,
    sentMessages,
    sentUserMessages,
    appendedEntries,
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

describe("runConcernBatch", () => {
  it("strips the completion marker from concern notes and preserves frontier order", async () => {
    const state = createAuditingState(["1", "2"]);
    const seenTasks: string[] = [];

    const results = await runConcernBatchWithSpawn(
      runConcernBatch(state, "/tmp", "session-123", "Follow principles", new Map()),
      (config) => {
        seenTasks.push(config.task);
        expect(config.sessionPath).toEqual(expect.stringContaining("_audit-"));
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
    expect(results).toEqual([
      {
        taskId: "1",
        notes: "Found a null bug in src/app.tsx",
        sessionPath: expect.stringContaining("_audit-1-correctness-"),
      },
      {
        taskId: "2",
        notes: "Frontend looks clean",
        sessionPath: expect.stringContaining("_audit-2-frontend-"),
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
  it("registers /audit, audit helper commands, and the audit signal tools", () => {
    const harness = createMockExtensionApiHarness();
    auditExtension(harness.pi);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "audit_detected_concerns",
      "audit_concern_complete",
      "audit_synthesis_complete",
      "audit_finding_result",
      "audit_fix_gate_result",
      "audit_fix_counsel_result",
    ]);
    expect(harness.commands.map((command) => command.name)).toEqual([
      "audit-cancel",
      "audit-skip",
      "audit-status",
      "audit",
    ]);
  });

  it("accepts approved concerns through the detection tool", async () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "Detecting",
          scope: "diff",
          diffStat: " 2 files changed",
          targetPaths: ["src/app.tsx"],
          skillCatalog: [],
          userPrompt: "check react",
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    harness.getListener("session_start")!.handler({}, ctx);

    const detectionTool = harness.getTool("audit_detected_concerns");
    const result = await detectionTool.execute("tc-1", {
      concerns: [
        { name: "correctness", description: "Bugs and soundness", skills: ["code-review"] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Captured 1 approved audit concern");
    expect(harness.appendedEntries.some((entry) => entry.customType === "audit")).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: concern 1/1");
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

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: concern 2/2");
      const widgetCalls = (ctx.ui.setWidget as ReturnType<typeof mock>).mock.calls;
      expect(widgetCalls.at(-1)?.[0]).toBe("audit-progress");
      expect(widgetCalls.at(-1)?.[1]).toEqual([
        "focus: check react",
        "",
        "✔ correctness",
        "◼ Auditing frontend",
        expect.stringContaining("session: /Users/cvr/.pi/agent/sessions/"),
      ]);
    });
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

  it("restores persisted Fixing gate phase on session start", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "Fixing",
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
          currentFinding: 1,
          phase: "gating",
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: gating fix 2/2");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("audit-progress", [
      "  ✓ [critical] src/app.tsx",
      "  ▸ [warning] src/lib.ts (gating)",
    ]);
  });

  it("restores persisted Failed state on session start with concern transcript paths", () => {
    const harness = createMockExtensionApiHarness();
    harness.setSessionEntries([
      {
        type: "custom",
        customType: "audit",
        data: {
          mode: "Failed",
          failedPhase: "auditing",
          message: "spawn failure\n\nConcern transcript: /tmp/audit-1.jsonl",
          concerns: [
            {
              id: "1",
              order: 1,
              subject: "correctness",
              activeForm: "Auditing correctness",
              status: "in_progress",
              blockedBy: [],
              metadata: {
                description: "Bugs and soundness",
                skills: ["code-review"],
                sessionPath: "/tmp/audit-1.jsonl",
              },
            },
          ],
        },
      },
    ]);
    auditExtension(harness.pi);

    const ctx = harness.createContext();
    const sessionStart = harness.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("audit", "audit: failed (auditing)");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("audit-progress", [
      "✖ audit failed",
      "  phase: auditing",
      "  spawn failure",
      "  ",
      "  Concern transcript: /tmp/audit-1.jsonl",
      "◼ Auditing correctness",
      "  session: /tmp/audit-1.jsonl",
    ]);
  });
});
