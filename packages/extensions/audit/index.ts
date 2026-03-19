/**
 * Audit Extension — skill-aware branch audit-loop.
 *
 * Full loop: detect concerns → audit each concern → synthesize findings → fix each
 * finding with gate + counsel between fixes.
 *
 * Usage:
 *   /audit                                — auto-detect concerns from diff
 *   /audit check react and effect         — with explicit focus
 *   /audit packages/extensions/audit      — audit an explicit path
 *   /audit @packages/core/fs "check ts"  — force path parsing + focus
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as os from "node:os";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { createInlineExecutionExecutor, isExecutionEffect } from "@cvr/pi-execution";
import { GitClient } from "@cvr/pi-git-client";
import { GraphRuntime } from "@cvr/pi-graph-runtime";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { PiSpawnService } from "@cvr/pi-spawn";
import { register, type MachineConfig } from "@cvr/pi-state-machine";
import type { Command, StateObserver } from "@cvr/pi-state-machine";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  resolveBaseBranch,
  getDiffStat,
  getChangedFiles,
  buildSkillCatalog,
} from "@cvr/pi-diff-context";
import {
  AUDIT_GRAPH_POLICY,
  auditReducer,
  buildConcernAuditPrompt,
  getAuditStatusText,
  type AuditConcernTask,
  type AuditEffect,
  type AuditEvent,
  type AuditFinding,
  type AuditState,
  type PersistPayload,
  type SkillCatalogEntry,
} from "./machine";
import type { GraphExecutionCursor } from "@cvr/pi-graph-execution";
import { parseAuditScopeArgs, toAuditDisplayPath } from "./scope";
import { AUDIT_SIGNAL_TOOLS, hasToolCall, parseConcernCompletion } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: PiMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getLastAssistantText(messages: PiMessage[]): string {
  const assistants = messages.filter(isAssistantMessage);
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function normalizeHydratedSkillCatalog(
  entries: readonly Record<string, unknown>[] | undefined,
): SkillCatalogEntry[] {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry.name !== "string" || typeof entry.description !== "string") return [];
    return [{ name: entry.name, description: entry.description }];
  });
}

function normalizeHydratedProposedConcerns(
  items: readonly Record<string, unknown>[] | undefined,
): { name: string; description: string; skills: string[] }[] {
  return (items ?? []).flatMap((item) => {
    if (typeof item.name !== "string" || typeof item.description !== "string") return [];
    return [
      {
        name: item.name,
        description: item.description,
        skills: Array.isArray(item.skills)
          ? item.skills.filter((value): value is string => typeof value === "string")
          : [],
      },
    ];
  });
}

function normalizeHydratedConcernTasks(
  items: readonly Record<string, unknown>[] | undefined,
): AuditConcernTask[] {
  return (items ?? []).flatMap((item) => {
    const metadata =
      typeof item.metadata === "object" && item.metadata !== null
        ? (item.metadata as Record<string, unknown>)
        : undefined;
    if (
      typeof item.id !== "string" ||
      typeof item.order !== "number" ||
      typeof item.subject !== "string" ||
      (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") ||
      typeof metadata?.description !== "string"
    ) {
      return [];
    }

    return [
      {
        id: item.id,
        order: item.order,
        subject: item.subject,
        activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
        owner: typeof item.owner === "string" ? item.owner : undefined,
        status: item.status,
        blockedBy: Array.isArray(item.blockedBy)
          ? item.blockedBy.filter((value): value is string => typeof value === "string")
          : [],
        metadata: {
          description: metadata.description,
          skills: Array.isArray(metadata.skills)
            ? metadata.skills.filter((value): value is string => typeof value === "string")
            : [],
          notes: typeof metadata.notes === "string" ? metadata.notes : undefined,
          sessionPath: typeof metadata.sessionPath === "string" ? metadata.sessionPath : undefined,
        },
      },
    ];
  });
}

function normalizeHydratedConcernCursor(value: unknown): GraphExecutionCursor | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const cursor = value as Record<string, unknown>;
  if (
    (cursor.phase !== "running" && cursor.phase !== "gating" && cursor.phase !== "counseling") ||
    typeof cursor.total !== "number" ||
    !Array.isArray(cursor.frontierTaskIds) ||
    !Array.isArray(cursor.activeTaskIds)
  ) {
    return undefined;
  }

  return {
    phase: cursor.phase,
    total: cursor.total,
    frontierTaskIds: cursor.frontierTaskIds.filter(
      (taskId): taskId is string => typeof taskId === "string",
    ),
    activeTaskIds: cursor.activeTaskIds.filter(
      (taskId): taskId is string => typeof taskId === "string",
    ),
  };
}

function normalizeHydratedFindings(
  items: readonly Record<string, unknown>[] | undefined,
): AuditFinding[] {
  return (items ?? []).flatMap((item) => {
    if (
      typeof item.file !== "string" ||
      typeof item.description !== "string" ||
      (item.severity !== "critical" &&
        item.severity !== "warning" &&
        item.severity !== "suggestion")
    ) {
      return [];
    }

    return [
      {
        file: item.file,
        description: item.description,
        severity: item.severity,
      },
    ];
  });
}

const CONCERN_AUDIT_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const CONCERN_AUDIT_EXTENSION_TOOLS = ["read", "grep", "find", "ls", "bash", "skill"];

export class ConcernBatchError extends Schema.TaggedErrorClass<ConcernBatchError>()(
  "ConcernBatchError",
  { message: Schema.String },
) {}

export interface ConcernBatchResult {
  taskId: string;
  notes: string;
  sessionPath: string;
}

const AUDIT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function generateAuditConcernSessionPath(concern: AuditConcernTask): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const dir = path.join(AUDIT_SESSIONS_DIR, year);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const label =
    concern.subject
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "concern";
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `${timestamp}_audit-${concern.order}-${label}-${rand}.jsonl`);
}

function renderConcernLines(concerns: readonly AuditConcernTask[]): string[] {
  return concerns.flatMap((concern) => {
    const marker =
      concern.status === "completed" ? "✔" : concern.status === "in_progress" ? "◼" : "○";
    const subject =
      concern.status === "in_progress" ? (concern.activeForm ?? concern.subject) : concern.subject;
    const lines = [`${marker} ${subject}`];
    if (concern.metadata.sessionPath) {
      lines.push(`  session: ${concern.metadata.sessionPath}`);
    }
    return lines;
  });
}

function formatConcernApprovalPreview(concerns: readonly { name: string; description: string; skills: string[] }[]): string {
  const lines = [
    `Proposed ${concerns.length} audit concern${concerns.length === 1 ? "" : "s"}:`,
    ...concerns.map(
      (concern, index) =>
        `${index + 1}. ${concern.name} — ${concern.description} [skills: ${concern.skills.join(", ") || "none"}]`,
    ),
  ];
  return lines.join("\n");
}

function buildConcernBatchError(message: string, sessionPath: string): string {
  return `${message}\n\nConcern transcript: ${sessionPath}`;
}

function buildConcernCompletionMessage(concern: AuditConcernTask): string {
  const sessionLine = concern.metadata.sessionPath
    ? `\nSession: ${concern.metadata.sessionPath}`
    : "";
  return `Concern audit complete: ${concern.order}. ${concern.subject}${sessionLine}`;
}

function buildConcernAuditSystemPrompt(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  concern: AuditConcernTask,
  principles: string | undefined,
): string {
  const principlesBlock = principles ? `\n\n${principles}` : "";
  return `[AUDIT MODE — CONCERN ${concern.order}/${state.concerns.length}]\n\nCurrent concern: ${concern.subject} — ${concern.metadata.description}${principlesBlock}`;
}

function normalizeConcernAuditNotes(text: string): string {
  return text.trim();
}

export function runConcernBatch(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  cwd: string,
  sessionId: string,
  principles: string | undefined,
  concernSessions: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Effect.Effect<
  ReadonlyArray<ConcernBatchResult>,
  ConcernBatchError,
  GraphRuntime | PiSpawnService
> {
  return Effect.gen(function* () {
    const graphRuntime = yield* GraphRuntime;
    const spawn = yield* PiSpawnService;

    const results = yield* graphRuntime.runFrontier(
      state.cursor.frontierTaskIds,
      (taskId) =>
        Effect.gen(function* () {
          const concern = state.concerns.find((item) => item.id === taskId);
          if (!concern) {
            return yield* Effect.fail(
              new ConcernBatchError({
                message: `audit: missing concern for task ${taskId}`,
              }),
            );
          }

          const sessionPath =
            concernSessions.get(taskId) ?? generateAuditConcernSessionPath(concern);
          const result = yield* spawn.spawn({
            cwd,
            task: buildConcernAuditPrompt(state, concern),
            builtinTools: CONCERN_AUDIT_BUILTIN_TOOLS,
            extensionTools: CONCERN_AUDIT_EXTENSION_TOOLS,
            systemPromptBody: buildConcernAuditSystemPrompt(state, concern, principles),
            signal,
            sessionId,
            sessionPath,
          });
          const output = getLastAssistantText(result.messages).trim();
          const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted" ||
            !parseConcernCompletion(result.messages);

          if (isError) {
            return yield* Effect.fail(
              new ConcernBatchError({
                message: buildConcernBatchError(
                  result.errorMessage ||
                    result.stderr ||
                    output ||
                    `audit: concern ${concern.subject} failed before ${AUDIT_SIGNAL_TOOLS.concernComplete} was called`,
                  sessionPath,
                ),
              }),
            );
          }

          return {
            taskId,
            notes: normalizeConcernAuditNotes(output),
            sessionPath,
          } satisfies ConcernBatchResult;
        }),
      AUDIT_GRAPH_POLICY,
    );

    return results.map((result) => result.value);
  });
}

const AUDIT_HIDDEN_CONTEXT_TYPES = new Set([
  "audit-context",
  "audit-progress",
  "audit-error",
]);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function formatUI(state: AuditState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setStatus("audit", getAuditStatusText(state));

  if (state._tag === "Detecting") {
    const lines = [
      `scope: ${state.targetPaths[0] ?? "(none)"}${state.targetPaths.length > 1 ? ` +${state.targetPaths.length - 1} more` : ""}`,
    ];
    if (state.userPrompt.trim().length > 0) {
      lines.push(`focus: ${state.userPrompt.trim()}`);
    }
    lines.push("status: developing concerns");
    ctx.ui.setWidget("audit-progress", lines);
  } else if (state._tag === "AwaitingConcernApproval") {
    const lines = [
      `scope: ${state.targetPaths[0] ?? "(none)"}${state.targetPaths.length > 1 ? ` +${state.targetPaths.length - 1} more` : ""}`,
    ];
    if (state.userPrompt.trim().length > 0) {
      lines.push(`focus: ${state.userPrompt.trim()}`);
      lines.push("");
    }
    lines.push(...state.concerns.map((concern, index) => `${index + 1}. ${concern.name} — ${concern.description}`));
    lines.push("");
    lines.push("status: awaiting approval");
    ctx.ui.setWidget("audit-progress", lines);
  } else if (state._tag === "Auditing") {
    const focusLines =
      state.userPrompt.trim().length > 0 ? [`focus: ${state.userPrompt.trim()}`, ""] : [];
    ctx.ui.setWidget("audit-progress", [...focusLines, ...renderConcernLines(state.concerns)]);
  } else if (state._tag === "Fixing") {
    const lines = state.findings.map((finding, index) => {
      const marker =
        index < state.currentFinding ? "✓" : index === state.currentFinding ? "▸" : "○";
      const phase =
        index === state.currentFinding && state.phase !== "running" ? ` (${state.phase})` : "";
      return `  ${marker} [${finding.severity}] ${finding.file}${phase}`;
    });
    ctx.ui.setWidget("audit-progress", lines);
  } else if (state._tag === "Failed") {
    ctx.ui.setWidget("audit-progress", [
      "✖ audit failed",
      `  phase: ${state.failedPhase}`,
      ...state.message.split("\n").map((line) => `  ${line}`),
      ...renderConcernLines(state.concerns),
    ]);
  } else {
    ctx.ui.setWidget("audit-progress", undefined);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function auditExtension(pi: ExtensionAPI): void {
  const gitRuntime = ManagedRuntime.make(GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)));
  const concernRuntime = ManagedRuntime.make(
    Layer.mergeAll(GraphRuntime.layer, PiSpawnService.layer),
  );
  const executor = createInlineExecutionExecutor(pi);
  let activeConcernBatchAbort: AbortController | undefined;

  pi.on("session_shutdown" as any, async () => {
    activeConcernBatchAbort?.abort();
    activeConcernBatchAbort = undefined;
    await Promise.all([gitRuntime.dispose(), concernRuntime.dispose()]);
  });

  // ----- Commands -----
  const commands: Command<AuditState, AuditEvent>[] = [
    {
      mode: "event",
      name: "audit-cancel",
      description: "Cancel the running audit",
      toEvent: (state, _args, ctx): AuditEvent | null => {
        if (state._tag === "Idle") {
          ctx.ui.notify("No audit in progress", "info");
          return null;
        }
        return { _tag: "Cancel" };
      },
    },
    {
      mode: "event",
      name: "audit-skip",
      description: "Skip the current finding",
      toEvent: (state, _args, ctx): AuditEvent | null => {
        if (state._tag !== "Fixing" || state.phase !== "running") {
          ctx.ui.notify("Not currently fixing a finding", "info");
          return null;
        }
        return { _tag: "FixSkip" };
      },
    },
    {
      mode: "query",
      name: "audit-status",
      description: "Show audit status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No audit in progress", "info");
            break;
          case "Detecting":
            ctx.ui.notify("Audit: detecting concerns...", "info");
            break;
          case "AwaitingConcernApproval":
            ctx.ui.notify("Audit: waiting for concern approval...", "info");
            break;
          case "Auditing":
            ctx.ui.notify(`Audit: running ${state.concerns.length} concern audits`, "info");
            break;
          case "Synthesizing":
            ctx.ui.notify("Audit: synthesizing findings...", "info");
            break;
          case "Fixing": {
            const done = state.currentFinding;
            const total = state.findings.length;
            const current = state.findings[state.currentFinding]!;
            ctx.ui.notify(
              `Audit: fixing ${done + 1}/${total} (${state.phase}) — [${current.severity}] ${current.file}: ${current.description}`,
              "info",
            );
            break;
          }
          case "Failed":
            ctx.ui.notify(`Audit failed during ${state.failedPhase}: ${state.message}`, "error");
            break;
        }
      },
    },
  ];

  const toolError = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  });

  const concernSchema = Type.Object({
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    skills: Type.Array(Type.String({ minLength: 1 })),
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.proposeConcerns,
    label: "Audit Proposed Concerns",
    description: "Submit the proposed audit concerns so the extension can ask the user to approve, reject, or edit them.",
    promptSnippet: "Call this tool once you have the proposed concern list.",
    promptGuidelines: [
      "Use this only while the audit is in Detecting mode.",
      "Call this as soon as you have the proposed concern list.",
      "Do not start concern audits yourself after calling this tool.",
    ],
    parameters: Type.Object({
      concerns: Type.Array(concernSchema, { minItems: 1 }),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Detecting") {
        return toolError("Audit detection is not currently active.");
      }

      const concerns = params.concerns.filter(
        (concern) => concern.name.trim().length > 0 && concern.description.trim().length > 0,
      );
      if (concerns.length === 0) {
        return toolError("At least one valid proposed concern is required.");
      }

      machine.send({ _tag: "ConcernsProposed", concerns });
      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${concerns.length} proposed audit concern${concerns.length === 1 ? "" : "s"}. Waiting for user approval.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.detectConcerns,
    label: "Audit Detected Concerns",
    description: "Finalize the approved audit concerns detected for the current audit run.",
    promptSnippet: "Fallback: call this only if the final approved concerns must be submitted directly.",
    promptGuidelines: [
      "Prefer audit_proposed_concerns for the normal flow.",
      "Only use this while the audit is in Detecting mode.",
      "Use this only when the final approved concern list is already known.",
    ],
    parameters: Type.Object({
      concerns: Type.Array(concernSchema, { minItems: 1 }),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Detecting") {
        return toolError("Audit detection is not currently active.");
      }

      const concerns = params.concerns.filter(
        (concern) => concern.name.trim().length > 0 && concern.description.trim().length > 0,
      );
      if (concerns.length === 0) {
        return toolError("At least one valid approved concern is required.");
      }

      machine.send({ _tag: "ConcernsDetected", concerns });
      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${concerns.length} approved audit concern${concerns.length === 1 ? "" : "s"}. Launching audits.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.concernComplete,
    label: "Audit Concern Complete",
    description: "Signal that a spawned concern-audit subagent has finished writing its notes.",
    promptSnippet: "Use this from audit concern subagents after the notes are complete.",
    promptGuidelines: [
      "Only use this inside spawned audit concern subagents.",
      "Write the concern notes first, then call this tool.",
    ],
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: "Concern completion captured." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.synthesisComplete,
    label: "Audit Synthesis Complete",
    description: "Submit the synthesized audit findings for the current audit run.",
    promptSnippet: "Call this tool when audit synthesis is complete.",
    promptGuidelines: [
      "Use this only while the audit is synthesizing findings.",
      "Pass the ordered findings array. Use an empty array when there are no actionable findings.",
    ],
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          file: Type.String({ minLength: 1 }),
          description: Type.String({ minLength: 1 }),
          severity: Type.Union([
            Type.Literal("critical"),
            Type.Literal("warning"),
            Type.Literal("suggestion"),
          ]),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Synthesizing") {
        return toolError("Audit synthesis is not currently active.");
      }

      machine.send({ _tag: "SynthesisComplete", findings: params.findings });
      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${params.findings.length} audit finding${params.findings.length === 1 ? "" : "s"}.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.findingResult,
    label: "Audit Finding Result",
    description: "Signal whether the current audit finding was fixed or skipped.",
    promptSnippet: "Call this tool after handling the current finding.",
    promptGuidelines: ["Use this only while actively fixing an audit finding."],
    parameters: Type.Object({
      outcome: Type.Union([Type.Literal("fixed"), Type.Literal("skip")]),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Fixing" || state.phase !== "running") {
        return toolError("An audit finding is not currently being fixed.");
      }

      machine.send({ _tag: params.outcome === "fixed" ? "FindingFixed" : "FixSkip" });
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.outcome === "fixed"
                ? "Recorded finding as fixed. Run the gate next."
                : "Recorded finding as skipped.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.fixGateResult,
    label: "Audit Fix Gate Result",
    description: "Signal whether the validation gate passed for the current audit fix.",
    promptSnippet: "Call this tool after running the audit fix gate.",
    promptGuidelines: ["Use this only while the audit fix gate is active."],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Fixing" || state.phase !== "gating") {
        return toolError("The audit fix gate is not currently active.");
      }

      machine.send({ _tag: params.status === "pass" ? "FixGatePass" : "FixGateFail" });
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.status === "pass"
                ? "Gate passed. Run counsel next."
                : "Gate failed. Fix the issues and retry.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: AUDIT_SIGNAL_TOOLS.fixCounselResult,
    label: "Audit Fix Counsel Result",
    description: "Signal whether counsel approved the current audit fix.",
    promptSnippet: "Call this tool after counsel reviews the audit fix.",
    promptGuidelines: ["Use this only while audit counsel is active."],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Fixing" || state.phase !== "counseling") {
        return toolError("Audit counsel is not currently active.");
      }

      machine.send({ _tag: params.status === "pass" ? "FixCounselPass" : "FixCounselFail" });
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.status === "pass"
                ? "Counsel approved the fix."
                : "Counsel found issues. Address them before continuing.",
          },
        ],
        details: {},
      };
    },
  });

  const awaitingConcernApprovalObserver: StateObserver<AuditState, AuditEvent> = {
    match: (state) => state._tag === "AwaitingConcernApproval",
    handler: async (state, sendIfCurrent, ctx) => {
      if (state._tag !== "AwaitingConcernApproval" || !ctx.hasUI) return;

      ctx.ui.notify(formatConcernApprovalPreview(state.concerns), "info");

      const choice = await ctx.ui.select("Audit concerns ready — approve, reject, or edit?", [
        "Approve concerns",
        "Reject concerns",
        "Edit concerns",
      ]);

      if (choice === "Approve concerns") {
        sendIfCurrent({ _tag: "ConcernsApproved" });
        return;
      }

      if (choice === "Edit concerns") {
        const seed = state.concerns
          .map(
            (concern, index) =>
              `${index + 1}. ${concern.name} — ${concern.description}\n   skills: ${concern.skills.join(", ") || "none"}`,
          )
          .join("\n");
        const edited = await ctx.ui.editor(
          "Edit audit concerns — describe what to change",
          `Current concerns:\n${seed}\n\nReply with concrete edits, merges, drops, or additions:\n`,
        );
        if (!edited?.trim()) {
          sendIfCurrent({ _tag: "ConcernsRejected" });
          return;
        }
        sendIfCurrent({ _tag: "ConcernsEdited", feedback: edited.trim() });
        return;
      }

      sendIfCurrent({ _tag: "ConcernsRejected" });
    },
  };

  // ----- Machine config -----
  const machineConfig: MachineConfig<AuditState, AuditEvent, AuditEffect> = {
    id: "audit",
    initial: { _tag: "Idle" },
    reducer: auditReducer,

    events: {
      before_agent_start: {
        mode: "reply" as const,
        handle: (state) => {
          if (state._tag === "Idle") return;

          const principles = readPrinciples();
          const principlesBlock = principles ? `\n\n${principles}` : "";

          let content: string;
          switch (state._tag) {
            case "Detecting":
              content = `[AUDIT MODE — DETECTION]\n\nYou are detecting which audit concerns apply to this branch's changes. When you have the proposed concern list, call ${AUDIT_SIGNAL_TOOLS.proposeConcerns} with the ordered concerns. Do not start concern audits yourself after proposing them.${principlesBlock}`;
              break;
            case "AwaitingConcernApproval":
            case "Auditing":
            case "Failed":
              return;
            case "Synthesizing":
              content = `[AUDIT MODE — SYNTHESIS]\n\nSynthesize findings, then call ${AUDIT_SIGNAL_TOOLS.synthesisComplete} with the ordered findings array.${principlesBlock}`;
              break;
            case "Fixing": {
              const f = state.findings[state.currentFinding]!;
              const phaseLabel =
                state.phase === "gating"
                  ? "GATING"
                  : state.phase === "counseling"
                    ? "COUNSELING"
                    : `FIXING ${state.currentFinding + 1}/${state.findings.length}`;
              content = `[AUDIT MODE — ${phaseLabel}]\n\nCurrent finding: [${f.severity}] ${f.file} — ${f.description}${principlesBlock}`;
              break;
            }
          }

          return {
            message: {
              customType: "audit-context",
              content,
              display: false,
            },
          };
        },
      },

      context: {
        mode: "reply" as const,
        handle: (_state, event) => ({
          messages: event.messages.filter(
            (message: any) => !AUDIT_HIDDEN_CONTEXT_TYPES.has(message.customType),
          ),
        }),
      },

      agent_end: {
        mode: "fire" as const,
        toEvent: (state, event, ctx): AuditEvent | null => {
          if (!ctx.hasUI || state._tag === "Idle" || state._tag === "Failed") return null;

          const signalHandled = [
            AUDIT_SIGNAL_TOOLS.proposeConcerns,
            AUDIT_SIGNAL_TOOLS.detectConcerns,
            AUDIT_SIGNAL_TOOLS.synthesisComplete,
            AUDIT_SIGNAL_TOOLS.findingResult,
            AUDIT_SIGNAL_TOOLS.fixGateResult,
            AUDIT_SIGNAL_TOOLS.fixCounselResult,
          ].some((toolName) => hasToolCall(event.messages, toolName));
          if (signalHandled) return null;

          if (state._tag === "Detecting") {
            return null;
          }

          if (state._tag === "Auditing") {
            // Main-session agent_end is irrelevant here. Concern audits run in spawned subagents.
            return null;
          }

          if (state._tag === "Synthesizing") {
            return { _tag: "SynthesisFailed" };
          }

          if (state._tag === "Fixing") {
            return { _tag: "FixSignalMissing", phase: state.phase };
          }

          return null;
        },
      },

      session_start: {
        mode: "fire" as const,
        toEvent: (_state, _event, ctx): AuditEvent => {
          const entries = ctx.sessionManager.getEntries();
          const auditEntry = entries
            .filter((entry: any) => entry.type === "custom" && entry.customType === "audit")
            .pop() as { data?: PersistPayload } | undefined;
          const data = auditEntry?.data;
          const mode = data?.mode;
          const scope = data?.scope === "diff" || data?.scope === "paths" ? data.scope : undefined;
          const concerns = normalizeHydratedConcernTasks(
            Array.isArray(data?.concerns)
              ? (data.concerns as Record<string, unknown>[])
              : undefined,
          );
          const proposedConcerns = normalizeHydratedProposedConcerns(
            Array.isArray(data?.proposedConcerns)
              ? (data.proposedConcerns as Record<string, unknown>[])
              : undefined,
          );
          const findings = normalizeHydratedFindings(
            Array.isArray(data?.findings)
              ? (data.findings as Record<string, unknown>[])
              : undefined,
          );
          const skillCatalog = normalizeHydratedSkillCatalog(
            Array.isArray(data?.skillCatalog)
              ? (data.skillCatalog as Record<string, unknown>[])
              : undefined,
          );
          const concernCursor = normalizeHydratedConcernCursor(data?.concernCursor);
          const currentFinding =
            typeof data?.currentFinding === "number" ? data.currentFinding : undefined;
          const phase =
            data?.phase === "running" || data?.phase === "gating" || data?.phase === "counseling"
              ? data.phase
              : undefined;
          const failedPhase =
            data?.failedPhase === "auditing" ||
            data?.failedPhase === "synthesizing" ||
            data?.failedPhase === "fixing"
              ? data.failedPhase
              : undefined;
          const message = typeof data?.message === "string" ? data.message : undefined;

          return {
            _tag: "Hydrate",
            mode,
            scope,
            concerns,
            proposedConcerns,
            diffStat: data?.diffStat ?? "",
            targetPaths: Array.isArray(data?.targetPaths)
              ? data.targetPaths.filter((value): value is string => typeof value === "string")
              : [],
            skillCatalog,
            userPrompt: data?.userPrompt ?? "",
            concernCursor,
            findings,
            currentFinding,
            phase,
            failedPhase,
            message,
          };
        },
      },

      session_switch: {
        mode: "fire" as const,
        toEvent: (): AuditEvent => ({ _tag: "Reset" }),
      },

      input: {
        mode: "reply" as const,
        handle: (state, event) => {
          if (
            state._tag !== "Idle" &&
            state._tag !== "Failed" &&
            state._tag !== "Detecting" &&
            state._tag !== "AwaitingConcernApproval" &&
            event.source === "interactive"
          ) {
            queueMicrotask(() => machine.send({ _tag: "Cancel" }));
          }
          return { action: "continue" as const };
        },
      },
    },

    commands,
    observers: [awaitingConcernApprovalObserver],
  };

  const machine = register<AuditState, AuditEvent, AuditEffect>(
    pi,
    machineConfig,
    (effect, _pi, ctx) => {
      if (isExecutionEffect(effect)) {
        executor.execute(effect.request, ctx);
        return;
      }
      if (effect.type === "persistState") {
        if (effect.state.mode !== "Auditing") {
          activeConcernBatchAbort?.abort();
          activeConcernBatchAbort = undefined;
        }
        pi.appendEntry("audit", effect.state);
        return;
      }
      if (effect.type === "runConcernBatch") {
        activeConcernBatchAbort?.abort();
        const batchAbort = new AbortController();
        activeConcernBatchAbort = batchAbort;
        const principles = readPrinciples();
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
        const sessionEntries = effect.state.cursor.frontierTaskIds.flatMap((taskId) => {
          const concern = effect.state.concerns.find((item) => item.id === taskId);
          if (!concern) return [];
          return [{ taskId, sessionPath: generateAuditConcernSessionPath(concern) }];
        });
        const concernSessions = new Map(
          sessionEntries.map(({ taskId, sessionPath }) => [taskId, sessionPath] as const),
        );
        const preparedState: Extract<AuditState, { _tag: "Auditing" }> = {
          ...effect.state,
          concerns: effect.state.concerns.map((concern) => ({
            ...concern,
            metadata: {
              ...concern.metadata,
              sessionPath: concernSessions.get(concern.id) ?? concern.metadata.sessionPath,
            },
          })),
        };

        if (sessionEntries.length > 0) {
          machine.send({ _tag: "ConcernSessionsPrepared", sessions: sessionEntries });
        }

        concernRuntime
          .runPromise(
            runConcernBatch(
              preparedState,
              ctx.cwd,
              sessionId,
              principles,
              concernSessions,
              batchAbort.signal,
            ),
          )
          .then((results) => {
            if (activeConcernBatchAbort !== batchAbort || batchAbort.signal.aborted) return;
            for (const result of results) {
              const concern = preparedState.concerns.find((item) => item.id === result.taskId);
              machine.send({
                _tag: "ConcernAudited",
                taskId: result.taskId,
                notes: result.notes,
                sessionPath: result.sessionPath,
              });

              if (concern) {
                executor.execute(
                  {
                    customType: "audit-progress",
                    content: buildConcernCompletionMessage({
                      ...concern,
                      metadata: {
                        ...concern.metadata,
                        sessionPath: result.sessionPath,
                      },
                    }),
                    display: true,
                    triggerTurn: false,
                  },
                  ctx,
                );
              }
            }
            if (activeConcernBatchAbort === batchAbort) {
              activeConcernBatchAbort = undefined;
            }
          })
          .catch((err) => {
            if (activeConcernBatchAbort !== batchAbort || batchAbort.signal.aborted) return;
            batchAbort.abort();
            const message =
              err instanceof ConcernBatchError
                ? err.message
                : `audit: concern batch failed: ${String(err)}`;
            machine.send({ _tag: "ConcernAuditFailed", message });
            if (activeConcernBatchAbort === batchAbort) {
              activeConcernBatchAbort = undefined;
            }
          });
        return;
      }
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /audit command (imperative — async git work) -----
  pi.registerCommand("audit", {
    description: "Audit branch changes or explicit paths with skill-aware parallel subagents",
    handler: async (_args, ctx) => {
      if (machine.getState()._tag !== "Idle") {
        ctx.ui.notify("Audit already in progress. /audit-cancel to stop.", "info");
        return;
      }

      const parsedArgs = parseAuditScopeArgs(_args, ctx.cwd);
      if (parsedArgs.invalidPaths.length > 0) {
        ctx.ui.notify(
          `Invalid audit path${parsedArgs.invalidPaths.length > 1 ? "s" : ""}: ${parsedArgs.invalidPaths.join(", ")}`,
          "error",
        );
        return;
      }

      const skillCatalog = buildSkillCatalog(ctx.cwd);
      const targetPaths = parsedArgs.targetPaths.map((filePath) =>
        toAuditDisplayPath(filePath, ctx.cwd),
      );

      if (targetPaths.length > 0) {
        machine.send({
          _tag: "Start",
          scope: "paths",
          diffStat: "",
          targetPaths,
          skillCatalog,
          userPrompt: parsedArgs.userPrompt,
        });
        return;
      }

      const userPrompt = parsedArgs.userPrompt;
      const baseBranch = await resolveBaseBranch(ctx.cwd, gitRuntime);
      const diffStat = await getDiffStat(ctx.cwd, baseBranch, gitRuntime);
      const changedFiles = await getChangedFiles(ctx.cwd, baseBranch, gitRuntime);

      if (changedFiles.length === 0) {
        ctx.ui.notify(
          "No changes to audit. Pass a path to audit a file or directory explicitly.",
          "info",
        );
        return;
      }

      machine.send({
        _tag: "Start",
        scope: "diff",
        diffStat,
        targetPaths: changedFiles,
        skillCatalog,
        userPrompt,
      });
    },
  });
}
