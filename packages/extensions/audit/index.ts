/**
 * Audit Extension - skill-aware branch audit-loop.
 *
 * Full loop: detect concerns → audit each concern → synthesize findings → fix each
 * finding with gate + counsel between fixes.
 *
 * Usage:
 *   /audit                                - auto-detect concerns from diff
 *   /audit check react and effect         - with explicit focus
 *   /audit packages/extensions/audit      - audit an explicit path
 *   /audit @packages/core/fs "check ts"  - force path parsing + focus
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as os from "node:os";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { createInlineExecutionExecutor, isExecutionEffect } from "@cvr/pi-execution";
import { GitClient } from "@cvr/pi-git-client";
import { GraphRuntime } from "@cvr/pi-graph-runtime";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { PiSpawnService, type PiSpawnResult } from "@cvr/pi-spawn";
import { renderAgentTree, type SingleResult } from "@cvr/pi-sub-agent-render";
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
  DEFAULT_MAX_ITERATIONS,
  auditReducer,
  buildConcernAuditPrompt,
  buildDetectionPrompt,
  buildExecutionPrompt,
  buildSynthesisPrompt,
  getAuditStatusText,
  type AuditConcernTask,
  type AuditEffect,
  type AuditEvent,
  type AuditFinding,
  type AuditState,
  type PersistPayload,
  type SkillCatalogEntry,
  type AuditThinkingLevel,
} from "./machine";
import type { GraphExecutionCursor } from "@cvr/pi-graph-execution";
import { parseAuditScopeArgs, toAuditDisplayPath } from "./scope";
import {
  AUDIT_SIGNAL_TOOLS,
  hasToolCall,
  parseConcernCompletion,
  parseExecutionResult,
  parseProposedConcerns,
  parseSynthesisComplete,
} from "./utils";

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

const AUDIT_THINKING_LEVELS = new Set<AuditThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeAuditThinkingLevel(value: unknown): AuditThinkingLevel | undefined {
  return typeof value === "string" && AUDIT_THINKING_LEVELS.has(value as AuditThinkingLevel)
    ? (value as AuditThinkingLevel)
    : undefined;
}

function getCurrentAuditThinkingLevel(pi: ExtensionAPI): AuditThinkingLevel {
  return normalizeAuditThinkingLevel(pi.getThinkingLevel?.()) ?? "medium";
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

const DETECTION_MODEL = "openai-codex/gpt-5.4-mini";
const DETECTION_EXTENSION_TOOLS = [AUDIT_SIGNAL_TOOLS.proposeConcerns];
const CONCERN_AUDIT_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const CONCERN_AUDIT_EXTENSION_TOOLS = ["read", "grep", "find", "ls", "bash", "skill"];
const SYNTHESIS_BUILTIN_TOOLS = ["counsel"];
const EXECUTION_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "counsel"];
const EXECUTION_EXTENSION_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "skill",
  AUDIT_SIGNAL_TOOLS.executionResult,
];
const AUDIT_PHASE_RESULT_TYPE = "audit-phase-result";

type AuditPhase = "concern" | "synthesis" | "execution";

export class ConcernBatchError extends Schema.TaggedErrorClass<ConcernBatchError>()(
  "ConcernBatchError",
  { message: Schema.String },
) {}

export interface ConcernBatchResult {
  taskId: string;
  notes: string;
  sessionPath: string;
  renderResult: SingleResult;
}

export interface SpawnPhaseResult {
  sessionPath: string;
  renderResult: SingleResult;
  findings?: AuditFinding[];
  outcome?: "completed" | "skip";
}

interface AuditPhaseResultMessageDetails {
  phase: AuditPhase;
  label: string;
  sessionPath: string;
  result: SingleResult;
}

const AUDIT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function buildAuditSessionPath(label: string): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const dir = path.join(AUDIT_SESSIONS_DIR, year);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const safeLabel =
    label
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "audit";
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `${timestamp}_${safeLabel}-${rand}.jsonl`);
}

function generateAuditConcernSessionPath(concern: AuditConcernTask): string {
  return buildAuditSessionPath(`audit-${concern.order}-${concern.subject}`);
}

function generateAuditSynthesisSessionPath(iteration: number): string {
  return buildAuditSessionPath(`audit-synthesis-${iteration}`);
}

function generateAuditExecutionSessionPath(iteration: number): string {
  return buildAuditSessionPath(`audit-execution-${iteration}`);
}

function formatConcernApprovalPreview(
  concerns: readonly { name: string; description: string; skills: string[] }[],
): string {
  const lines = [
    `Proposed ${concerns.length} audit concern${concerns.length === 1 ? "" : "s"}:`,
    ...concerns.map(
      (concern, index) =>
        `${index + 1}. ${concern.name} - ${concern.description} [skills: ${concern.skills.join(", ") || "none"}]`,
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

function buildPhaseCompletionMessage(label: string, sessionPath: string): string {
  return `${label}\nSession: ${sessionPath}`;
}

function buildDetectionSystemPrompt(): string {
  return `[AUDIT MODE - DETECTION]\n\nQuickly classify the audit request into a small set of audit concerns. Use only the provided scope and prose. Do not inspect files or do discovery. When ready, call ${AUDIT_SIGNAL_TOOLS.proposeConcerns}.`;
}

function buildConcernAuditSystemPrompt(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  concern: AuditConcernTask,
  principles: string | undefined,
): string {
  const principlesBlock = principles ? `\n\n${principles}` : "";
  return `[AUDIT MODE - CONCERN ${concern.order}/${state.concerns.length}]\n\nCurrent concern: ${concern.subject} - ${concern.metadata.description}${principlesBlock}`;
}

function buildSynthesisSystemPrompt(
  state: Extract<AuditState, { _tag: "Synthesizing" }>,
  principles: string | undefined,
): string {
  const principlesBlock = principles ? `\n\n${principles}` : "";
  return `[AUDIT MODE - SYNTHESIS LOOP ${state.iteration}/${state.maxIterations}]${principlesBlock}`;
}

function buildExecutionSystemPrompt(
  state: Extract<AuditState, { _tag: "Executing" }>,
  principles: string | undefined,
): string {
  const principlesBlock = principles ? `\n\n${principles}` : "";
  return `[AUDIT MODE - EXECUTION LOOP ${state.iteration}/${state.maxIterations}]${principlesBlock}`;
}

function normalizeConcernAuditNotes(text: string): string {
  return text.trim();
}

function toSingleResult(agent: string, task: string, result: PiSpawnResult): SingleResult {
  return {
    agent,
    task,
    exitCode: result.exitCode,
    messages: [...result.messages],
    usage: { ...result.usage },
    model: result.model,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
  };
}

export function runDetection(
  state: Extract<AuditState, { _tag: "Detecting" }>,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
): Effect.Effect<
  readonly { name: string; description: string; skills: string[] }[],
  ConcernBatchError,
  PiSpawnService
> {
  return Effect.gen(function* () {
    const spawn = yield* PiSpawnService;
    const task = buildDetectionPrompt(state);
    const result = yield* spawn.spawn({
      cwd,
      task,
      model: DETECTION_MODEL,
      builtinTools: [],
      extensionTools: DETECTION_EXTENSION_TOOLS,
      systemPromptBody: buildDetectionSystemPrompt(),
      signal,
      sessionId,
      sessionPath: undefined,
    });
    const concerns = parseProposedConcerns(result.messages);

    if (
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      !concerns
    ) {
      return yield* Effect.fail(
        new ConcernBatchError({
          message:
            result.errorMessage ||
            result.stderr ||
            getLastAssistantText(result.messages).trim() ||
            `audit: concern detection ended before ${AUDIT_SIGNAL_TOOLS.proposeConcerns} was called`,
        }),
      );
    }

    return concerns;
  });
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
          const task = buildConcernAuditPrompt(state, concern);
          const result = yield* spawn.spawn({
            cwd,
            task,
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
            renderResult: toSingleResult(
              `audit concern ${concern.order}/${state.concerns.length}`,
              task,
              result,
            ),
          } satisfies ConcernBatchResult;
        }),
      AUDIT_GRAPH_POLICY,
    );

    return results.map((result) => result.value);
  });
}

export function runSynthesis(
  state: Extract<AuditState, { _tag: "Synthesizing" }>,
  cwd: string,
  sessionId: string,
  principles: string | undefined,
  sessionPath: string,
  signal?: AbortSignal,
): Effect.Effect<SpawnPhaseResult, ConcernBatchError, PiSpawnService> {
  return Effect.gen(function* () {
    const spawn = yield* PiSpawnService;
    const task = buildSynthesisPrompt(state);
    const result = yield* spawn.spawn({
      cwd,
      task,
      builtinTools: SYNTHESIS_BUILTIN_TOOLS,
      extensionTools: [AUDIT_SIGNAL_TOOLS.synthesisComplete],
      systemPromptBody: buildSynthesisSystemPrompt(state, principles),
      signal,
      sessionId,
      sessionPath,
    });

    const findings = parseSynthesisComplete(result.messages);
    if (
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      !findings
    ) {
      return yield* Effect.fail(
        new ConcernBatchError({
          message:
            result.errorMessage ||
            result.stderr ||
            getLastAssistantText(result.messages).trim() ||
            `audit: synthesis ended before ${AUDIT_SIGNAL_TOOLS.synthesisComplete} was called`,
        }),
      );
    }

    return {
      sessionPath,
      renderResult: toSingleResult(
        `audit synthesis ${state.iteration}/${state.maxIterations}`,
        task,
        result,
      ),
      findings,
    };
  });
}

export function runExecution(
  state: Extract<AuditState, { _tag: "Executing" }>,
  cwd: string,
  sessionId: string,
  principles: string | undefined,
  sessionPath: string,
  signal?: AbortSignal,
): Effect.Effect<SpawnPhaseResult, ConcernBatchError, PiSpawnService> {
  return Effect.gen(function* () {
    const spawn = yield* PiSpawnService;
    const task = buildExecutionPrompt(state);
    const result = yield* spawn.spawn({
      cwd,
      task,
      builtinTools: EXECUTION_BUILTIN_TOOLS,
      extensionTools: EXECUTION_EXTENSION_TOOLS,
      systemPromptBody: buildExecutionSystemPrompt(state, principles),
      signal,
      sessionId,
      sessionPath,
    });

    const outcome = parseExecutionResult(result.messages);
    if (
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      !outcome
    ) {
      return yield* Effect.fail(
        new ConcernBatchError({
          message:
            result.errorMessage ||
            result.stderr ||
            getLastAssistantText(result.messages).trim() ||
            `audit: execution ended before ${AUDIT_SIGNAL_TOOLS.executionResult} was called`,
        }),
      );
    }

    return {
      sessionPath,
      renderResult: toSingleResult(
        `audit execution ${state.iteration}/${state.maxIterations}`,
        task,
        result,
      ),
      outcome,
    };
  });
}

const AUDIT_HIDDEN_CONTEXT_TYPES = new Set([
  "audit-context",
  "audit-progress",
  "audit-error",
  AUDIT_PHASE_RESULT_TYPE,
]);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function formatUI(state: AuditState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setStatus("audit", getAuditStatusText(state));

  if (state._tag === "Detecting") {
    ctx.ui.setWidget("audit-progress", ["audit setup", "detecting concerns"]);
  } else if (state._tag === "AwaitingConcernApproval") {
    ctx.ui.setWidget("audit-progress", ["audit setup", "awaiting concern approval"]);
  } else if (state._tag === "Auditing") {
    const completed = state.concerns.filter((concern) => concern.status === "completed").length;
    ctx.ui.setWidget("audit-progress", [
      `audit loop ${state.iteration}/${state.maxIterations}`,
      `${completed}/${state.concerns.length} complete`,
    ]);
  } else if (state._tag === "Synthesizing") {
    ctx.ui.setWidget("audit-progress", [
      `audit loop ${state.iteration}/${state.maxIterations}`,
      "synthesizing",
    ]);
  } else if (state._tag === "Executing") {
    ctx.ui.setWidget("audit-progress", [
      `audit loop ${state.iteration}/${state.maxIterations}`,
      "executing plan",
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
  let activeDetectionAbort: AbortController | undefined;
  let activeConcernBatchAbort: AbortController | undefined;
  let activeSynthesisAbort: AbortController | undefined;
  let activeExecutionAbort: AbortController | undefined;

  pi.registerMessageRenderer(AUDIT_PHASE_RESULT_TYPE, (message, { expanded }, theme) => {
    const details = message.details as AuditPhaseResultMessageDetails | undefined;
    if (!details?.result) return new Text("(missing audit phase result)", 0, 0);
    const container = new Container();
    renderAgentTree(details.result, container, expanded, theme, {
      label: details.label,
    });
    return container;
  });

  pi.on("session_shutdown" as any, async () => {
    activeDetectionAbort?.abort();
    activeDetectionAbort = undefined;
    activeConcernBatchAbort?.abort();
    activeConcernBatchAbort = undefined;
    activeSynthesisAbort?.abort();
    activeSynthesisAbort = undefined;
    activeExecutionAbort?.abort();
    activeExecutionAbort = undefined;
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
      mode: "query",
      name: "audit-status",
      description: "Show audit status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No audit in progress", "info");
            break;
          case "Detecting":
            ctx.ui.notify(
              `Audit loop ${state.iteration}/${state.maxIterations}: detecting concerns`,
              "info",
            );
            break;
          case "AwaitingConcernApproval":
            ctx.ui.notify("Audit: waiting for concern approval...", "info");
            break;
          case "Auditing":
            ctx.ui.notify(
              `Audit loop ${state.iteration}/${state.maxIterations}: running ${state.concerns.length} concern audits`,
              "info",
            );
            break;
          case "Synthesizing":
            ctx.ui.notify(
              `Audit loop ${state.iteration}/${state.maxIterations}: synthesizing`,
              "info",
            );
            break;
          case "Executing":
            ctx.ui.notify(
              `Audit loop ${state.iteration}/${state.maxIterations}: executing ${state.findings.length} plan item${state.findings.length === 1 ? "" : "s"}`,
              "info",
            );
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
    description:
      "Submit the proposed audit concerns so the extension can ask the user to approve, reject, or edit them.",
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
      const concerns = params.concerns.filter(
        (concern) => concern.name.trim().length > 0 && concern.description.trim().length > 0,
      );
      if (concerns.length === 0) {
        return toolError("At least one valid proposed concern is required.");
      }

      if (state._tag === "Detecting") {
        machine.send({ _tag: "ConcernsProposed", concerns });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${concerns.length} proposed audit concern${concerns.length === 1 ? "" : "s"}.`,
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
      if (state._tag === "Synthesizing") {
        machine.send({ _tag: "SynthesisComplete", findings: params.findings });
      }
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
    name: AUDIT_SIGNAL_TOOLS.executionResult,
    label: "Audit Execution Result",
    description:
      "Signal whether the spawned execution subagent completed the synthesized audit plan.",
    promptSnippet: "Call this tool after executing the synthesized audit plan.",
    promptGuidelines: [
      "Use this from the spawned execution subagent.",
      "Call outcome: completed when the plan was executed.",
      "Call outcome: skip when there is nothing left to do.",
    ],
    parameters: Type.Object({
      outcome: Type.Union([Type.Literal("completed"), Type.Literal("skip")]),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.outcome === "completed"
                ? "Recorded execution as completed."
                : "Recorded execution as skipped.",
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

      const choice = await ctx.ui.select("Audit concerns ready - approve, reject, or edit?", [
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
              `${index + 1}. ${concern.name} - ${concern.description}\n   skills: ${concern.skills.join(", ") || "none"}`,
          )
          .join("\n");
        const edited = await ctx.ui.editor(
          "Edit audit concerns - describe what to change",
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
              content = `[AUDIT MODE - DETECTION]\n\nYou are detecting which audit concerns apply to this branch's changes. When you have the proposed concern list, call ${AUDIT_SIGNAL_TOOLS.proposeConcerns} with the ordered concerns. Do not start concern audits yourself after proposing them.${principlesBlock}`;
              break;
            case "AwaitingConcernApproval":
            case "Auditing":
              return;
            case "Synthesizing":
              content = `[AUDIT MODE - SYNTHESIS]\n\nSynthesize findings, then call ${AUDIT_SIGNAL_TOOLS.synthesisComplete} with the ordered findings array.${principlesBlock}`;
              break;
            case "Executing":
              content = `[AUDIT MODE - EXECUTION]\n\nExecute the synthesized plan, then call ${AUDIT_SIGNAL_TOOLS.executionResult} with outcome completed or skip.${principlesBlock}`;
              break;
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
          if (!ctx.hasUI || state._tag === "Idle") return null;

          const signalHandled = [
            AUDIT_SIGNAL_TOOLS.proposeConcerns,
            AUDIT_SIGNAL_TOOLS.synthesisComplete,
            AUDIT_SIGNAL_TOOLS.executionResult,
          ].some((toolName) => hasToolCall(event.messages, toolName));
          if (signalHandled) return null;

          if (state._tag === "Detecting" || state._tag === "Auditing") {
            return null;
          }

          if (state._tag === "Synthesizing") {
            return { _tag: "SynthesisFailed" };
          }

          if (state._tag === "Executing") {
            return { _tag: "ExecutionFailed" };
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
          const previousThinkingLevel = normalizeAuditThinkingLevel(data?.previousThinkingLevel);
          const detectionFeedback =
            typeof data?.detectionFeedback === "string" ? data.detectionFeedback : undefined;
          const iteration = typeof data?.iteration === "number" ? data.iteration : undefined;
          const maxIterations =
            typeof data?.maxIterations === "number" ? data.maxIterations : undefined;
          const previousConcernSessionPaths = Array.isArray(data?.previousConcernSessionPaths)
            ? data.previousConcernSessionPaths.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined;
          const previousExecutionSessionPaths = Array.isArray(data?.previousExecutionSessionPaths)
            ? data.previousExecutionSessionPaths.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined;

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
            detectionFeedback,
            previousThinkingLevel,
            concernCursor,
            findings,
            iteration,
            maxIterations,
            previousConcernSessionPaths,
            previousExecutionSessionPaths,
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
        if (effect.state.mode !== "Detecting") {
          activeDetectionAbort?.abort();
          activeDetectionAbort = undefined;
        }
        if (effect.state.mode !== "Auditing") {
          activeConcernBatchAbort?.abort();
          activeConcernBatchAbort = undefined;
        }
        if (effect.state.mode !== "Synthesizing") {
          activeSynthesisAbort?.abort();
          activeSynthesisAbort = undefined;
        }
        if (effect.state.mode !== "Executing") {
          activeExecutionAbort?.abort();
          activeExecutionAbort = undefined;
        }
        pi.appendEntry("audit", effect.state);
        return;
      }
      if (effect.type === "runDetection") {
        activeDetectionAbort?.abort();
        const detectionAbort = new AbortController();
        activeDetectionAbort = detectionAbort;
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
        concernRuntime
          .runPromise(runDetection(effect.state, ctx.cwd, sessionId, detectionAbort.signal))
          .then((concerns) => {
            if (activeDetectionAbort !== detectionAbort || detectionAbort.signal.aborted) return;
            machine.send({ _tag: "ConcernsProposed", concerns: [...concerns] });
            if (activeDetectionAbort === detectionAbort) {
              activeDetectionAbort = undefined;
            }
          })
          .catch(() => {
            if (activeDetectionAbort !== detectionAbort || detectionAbort.signal.aborted) return;
            machine.send({ _tag: "DetectionFailed" });
            if (activeDetectionAbort === detectionAbort) {
              activeDetectionAbort = undefined;
            }
          });
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
                pi.sendMessage(
                  {
                    customType: AUDIT_PHASE_RESULT_TYPE,
                    content: buildConcernCompletionMessage({
                      ...concern,
                      metadata: {
                        ...concern.metadata,
                        sessionPath: result.sessionPath,
                      },
                    }),
                    display: true,
                    details: {
                      phase: "concern",
                      label: `audit concern ${concern.order}: ${concern.subject}`,
                      sessionPath: result.sessionPath,
                      result: result.renderResult,
                    } satisfies AuditPhaseResultMessageDetails,
                  },
                  { deliverAs: "nextTurn" },
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
            machine.send({
              _tag: "ConcernAuditFailed",
              message,
              sessionPaths: sessionEntries.map(({ sessionPath }) => sessionPath),
            });
            if (activeConcernBatchAbort === batchAbort) {
              activeConcernBatchAbort = undefined;
            }
          });
        return;
      }
      if (effect.type === "runSynthesis") {
        activeSynthesisAbort?.abort();
        const synthesisAbort = new AbortController();
        activeSynthesisAbort = synthesisAbort;
        const principles = readPrinciples();
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
        const sessionPath = generateAuditSynthesisSessionPath(effect.state.iteration);
        concernRuntime
          .runPromise(
            runSynthesis(
              effect.state,
              ctx.cwd,
              sessionId,
              principles,
              sessionPath,
              synthesisAbort.signal,
            ),
          )
          .then((result) => {
            if (activeSynthesisAbort !== synthesisAbort || synthesisAbort.signal.aborted) return;
            machine.send({ _tag: "SynthesisComplete", findings: result.findings ?? [] });
            pi.sendMessage(
              {
                customType: AUDIT_PHASE_RESULT_TYPE,
                content: buildPhaseCompletionMessage(
                  "Audit synthesis complete.",
                  result.sessionPath,
                ),
                display: true,
                details: {
                  phase: "synthesis",
                  label: `audit synthesis ${effect.state.iteration}/${effect.state.maxIterations}`,
                  sessionPath: result.sessionPath,
                  result: result.renderResult,
                } satisfies AuditPhaseResultMessageDetails,
              },
              { deliverAs: "nextTurn" },
            );
            if (activeSynthesisAbort === synthesisAbort) {
              activeSynthesisAbort = undefined;
            }
          })
          .catch((err) => {
            if (activeSynthesisAbort !== synthesisAbort || synthesisAbort.signal.aborted) return;
            machine.send({
              _tag: "SynthesisFailed",
              sessionPath,
              message:
                err instanceof ConcernBatchError
                  ? err.message
                  : `audit: synthesis failed: ${String(err)}`,
            });
            if (activeSynthesisAbort === synthesisAbort) {
              activeSynthesisAbort = undefined;
            }
          });
        return;
      }
      if (effect.type === "runExecution") {
        activeExecutionAbort?.abort();
        const executionAbort = new AbortController();
        activeExecutionAbort = executionAbort;
        const principles = readPrinciples();
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
        const sessionPath = generateAuditExecutionSessionPath(effect.state.iteration);
        concernRuntime
          .runPromise(
            runExecution(
              effect.state,
              ctx.cwd,
              sessionId,
              principles,
              sessionPath,
              executionAbort.signal,
            ),
          )
          .then((result) => {
            if (activeExecutionAbort !== executionAbort || executionAbort.signal.aborted) return;
            machine.send(
              result.outcome === "completed"
                ? { _tag: "ExecutionComplete", sessionPath: result.sessionPath }
                : {
                    _tag: "ExecutionFailed",
                    sessionPath: result.sessionPath,
                    message: "execution subagent reported nothing left to do",
                  },
            );
            pi.sendMessage(
              {
                customType: AUDIT_PHASE_RESULT_TYPE,
                content: buildPhaseCompletionMessage(
                  "Audit execution finished.",
                  result.sessionPath,
                ),
                display: true,
                details: {
                  phase: "execution",
                  label: `audit execution ${effect.state.iteration}/${effect.state.maxIterations}`,
                  sessionPath: result.sessionPath,
                  result: result.renderResult,
                } satisfies AuditPhaseResultMessageDetails,
              },
              { deliverAs: "nextTurn" },
            );
            if (activeExecutionAbort === executionAbort) {
              activeExecutionAbort = undefined;
            }
          })
          .catch((err) => {
            if (activeExecutionAbort !== executionAbort || executionAbort.signal.aborted) return;
            machine.send({
              _tag: "ExecutionFailed",
              sessionPath,
              message:
                err instanceof ConcernBatchError
                  ? err.message
                  : `audit: execution failed: ${String(err)}`,
            });
            if (activeExecutionAbort === executionAbort) {
              activeExecutionAbort = undefined;
            }
          });
        return;
      }
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /audit command (imperative - async git work) -----
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
          detectionFeedback: undefined,
          previousThinkingLevel: getCurrentAuditThinkingLevel(pi),
          maxIterations: DEFAULT_MAX_ITERATIONS,
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
        detectionFeedback: undefined,
        previousThinkingLevel: getCurrentAuditThinkingLevel(pi),
        maxIterations: DEFAULT_MAX_ITERATIONS,
      });
    },
  });
}
