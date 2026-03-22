/**
 * Audit — pure state machine.
 *
 * Full audit-loop: detect → audit → synthesize → fix → gate → counsel → next.
 * Zero pi imports beyond the state machine framework.
 */

import type { SkillCatalogEntry } from "@cvr/pi-diff-context";
import { executeTurn, type ExecutionEffect } from "@cvr/pi-execution";
import {
  recordGraphTaskCompletion,
  startGraphExecution,
  type GraphExecutionCursor,
  type GraphExecutionPolicy,
} from "@cvr/pi-graph-execution";
import type { TaskListItem } from "@cvr/pi-task-list";
import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";

export type AuditThinkingLevel = Extract<BuiltinEffect, { type: "setThinkingLevel" }>["level"];

export type { SkillCatalogEntry, DiffContext } from "@cvr/pi-diff-context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CONCERNS = 5;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AuditConcern {
  name: string;
  description: string;
  skills: string[];
}

export interface AuditFinding {
  file: string;
  description: string;
  severity: "critical" | "warning" | "suggestion";
}

export interface AuditConcernTaskMetadata extends Record<string, unknown> {
  description: string;
  skills: string[];
  notes?: string;
  sessionPath?: string;
}

export interface AuditConcernTask extends TaskListItem {
  metadata: AuditConcernTaskMetadata;
}

export const AUDIT_GRAPH_POLICY: GraphExecutionPolicy = { maxParallel: 3 };
export const DEFAULT_MAX_ITERATIONS = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AuditScopeMode = "diff" | "paths";

export interface AuditLoopContext {
  scope: AuditScopeMode;
  diffStat: string;
  targetPaths: string[];
  userPrompt: string;
  iteration: number;
  maxIterations: number;
  previousConcernSessionPaths: string[];
  previousSynthesisSessionPaths: string[];
  previousExecutionSessionPaths: string[];
}

export type AuditState =
  | { _tag: "Idle" }
  | ({
      _tag: "Detecting";
      skillCatalog: SkillCatalogEntry[];
      detectionFeedback?: string;
      previousThinkingLevel: AuditThinkingLevel;
    } & AuditLoopContext)
  | ({
      _tag: "AwaitingConcernApproval";
      skillCatalog: SkillCatalogEntry[];
      detectionFeedback?: string;
      previousThinkingLevel: AuditThinkingLevel;
      concerns: AuditConcern[];
    } & AuditLoopContext)
  | ({
      _tag: "Auditing";
      concerns: AuditConcernTask[];
      cursor: GraphExecutionCursor;
    } & AuditLoopContext)
  | ({
      _tag: "Synthesizing";
      concerns: AuditConcernTask[];
    } & AuditLoopContext)
  | ({
      _tag: "Executing";
      concerns: AuditConcernTask[];
      findings: AuditFinding[];
    } & AuditLoopContext);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AuditEvent =
  | {
      _tag: "Start";
      scope: AuditScopeMode;
      diffStat: string;
      targetPaths: string[];
      skillCatalog: SkillCatalogEntry[];
      userPrompt: string;
      detectionFeedback?: string;
      previousThinkingLevel: AuditThinkingLevel;
      maxIterations?: number;
    }
  | { _tag: "ConcernsProposed"; concerns: AuditConcern[] }
  | { _tag: "ConcernsApproved" }
  | { _tag: "ConcernsRejected" }
  | { _tag: "ConcernsEdited"; feedback: string }
  | { _tag: "DetectionFailed" }
  | {
      _tag: "ConcernSessionsPrepared";
      sessions: ReadonlyArray<{ taskId: string; sessionPath: string }>;
    }
  | { _tag: "ConcernAudited"; taskId: string; notes: string; sessionPath: string }
  | { _tag: "ConcernAuditFailed"; message: string; sessionPaths: string[] }
  | { _tag: "SynthesisComplete"; findings: AuditFinding[]; sessionPath?: string }
  | { _tag: "SynthesisFailed"; sessionPath?: string; message?: string }
  | { _tag: "ExecutionComplete"; sessionPath: string }
  | { _tag: "ExecutionFailed"; sessionPath?: string; message?: string }
  | { _tag: "Cancel" }
  | {
      _tag: "Hydrate";
      mode?: AuditState["_tag"];
      scope?: AuditScopeMode;
      concerns?: AuditConcernTask[];
      proposedConcerns?: AuditConcern[];
      diffStat?: string;
      targetPaths?: string[];
      skillCatalog?: SkillCatalogEntry[];
      userPrompt?: string;
      detectionFeedback?: string;
      previousThinkingLevel?: AuditThinkingLevel;
      concernCursor?: GraphExecutionCursor;
      findings?: AuditFinding[];
      iteration?: number;
      maxIterations?: number;
      previousConcernSessionPaths?: string[];
      previousSynthesisSessionPaths?: string[];
      previousExecutionSessionPaths?: string[];
    }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type AuditEffect =
  | ExecutionEffect
  | { type: "persistState"; state: PersistPayload }
  | { type: "updateUI" };

export interface PersistPayload {
  mode: AuditState["_tag"];
  scope?: AuditScopeMode;
  concerns?: AuditConcernTask[];
  proposedConcerns?: AuditConcern[];
  diffStat?: string;
  targetPaths?: string[];
  skillCatalog?: SkillCatalogEntry[];
  userPrompt?: string;
  detectionFeedback?: string;
  previousThinkingLevel?: AuditThinkingLevel;
  concernCursor?: GraphExecutionCursor;
  findings?: AuditFinding[];
  iteration?: number;
  maxIterations?: number;
  previousConcernSessionPaths?: string[];
  previousSynthesisSessionPaths?: string[];
  previousExecutionSessionPaths?: string[];
}

// ---------------------------------------------------------------------------
// Prompt builders (pure — used by both reducer effects and wiring)
// ---------------------------------------------------------------------------

export function buildDetectionPrompt(state: Extract<AuditState, { _tag: "Detecting" }>): string {
  const pathsList = state.targetPaths.map((filePath) => `- ${filePath}`).join("\n");
  const skillsList = state.skillCatalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const userBlock = state.userPrompt ? `## User Request\n${state.userPrompt}\n` : "";
  const feedbackBlock = state.detectionFeedback
    ? `\n## User Edits To Previous Concern List\n${state.detectionFeedback}\n`
    : "";
  const scopeBlock =
    state.scope === "diff"
      ? `## Changed Files\n${state.diffStat}\n\n${pathsList}`
      : `## Audit Paths\n${pathsList}`;

  return `Quickly identify the audit concerns for this audit request. This is a fast parsing pass, not a full discovery phase.${userBlock}${feedbackBlock}
## Scope
${scopeBlock}

## Available Skills
${skillsList}

Choose the smallest useful set of concern categories for the requested audit. Maximum ${MAX_CONCERNS} concerns. Merge overlaps.

Use only what is obvious from the path names, diff summary, and user prose. Do not read files or perform extra discovery.

When you have the proposed concern list, call the audit_proposed_concerns tool with:
- concerns: [{ name, description, skills }]

Do not start concern audits yourself after proposing them.`;
}

function formatSessionPathBlock(title: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return `\n## ${title}\n${paths.map((sessionPath) => `- ${sessionPath}`).join("\n")}\n`;
}

export function buildConcernAuditPrompt(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  concern: AuditConcernTask,
): string {
  const skills = concern.metadata.skills.length > 0 ? concern.metadata.skills.join(", ") : "none";
  const targetPathsList = state.targetPaths.join(", ");
  const scopeBlock =
    state.scope === "diff"
      ? `${state.diffStat}\nChanged files: ${targetPathsList}`
      : `Explicit audit targets: ${targetPathsList}`;
  const scopeRule =
    state.scope === "diff"
      ? "Use diff stat only for scoping. Do NOT inject raw diff — read files directly."
      : "These paths were selected explicitly, not from a diff. Inspect the files or directories directly.";
  const userBlock = state.userPrompt ? `\n## Focus\n${state.userPrompt}\n` : "";
  const previousConcernSessions = formatSessionPathBlock(
    "Previous Concern Audit Sessions",
    state.previousConcernSessionPaths,
  );
  const previousExecutionSessions = formatSessionPathBlock(
    "Previous Execution Sessions",
    state.previousExecutionSessionPaths,
  );

  return `Audit loop ${state.iteration}/${state.maxIterations}.
Audit concern ${concern.order}/${state.concerns.length}: ${concern.subject}

## Concern
- Name: ${concern.subject}
- Description: ${concern.metadata.description}
- Skills: ${skills}${userBlock}

## Context
${scopeBlock}

${scopeRule}${previousConcernSessions}${previousExecutionSessions}
If previous session paths are provided, read them only if needed to understand what has already been attempted.

Produce the concern-specific audit notes in plain text with concrete file references.
After the notes are complete, call the audit_concern_complete tool.
Do not use prose completion markers.`;
}

export function buildSynthesisPrompt(state: Extract<AuditState, { _tag: "Synthesizing" }>): string {
  const userBlock = state.userPrompt ? `\n## Focus\n${state.userPrompt}\n` : "";
  const concernNotes = state.concerns
    .map((concern) => {
      const notes = concern.metadata.notes?.trim() || "(no notes collected)";
      return `## Concern ${concern.order}: ${concern.subject}\n${notes}`;
    })
    .join("\n\n");
  const previousSynthesisSessions = formatSessionPathBlock(
    "Previous Synthesis Sessions",
    state.previousSynthesisSessionPaths,
  );
  const previousExecutionSessions = formatSessionPathBlock(
    "Previous Execution Sessions",
    state.previousExecutionSessionPaths,
  );

  return `Synthesize the ordered execution plan for audit loop ${state.iteration}/${state.maxIterations}.${userBlock}

## Concern Audit Notes
${concernNotes}${previousSynthesisSessions}${previousExecutionSessions}Read previous synthesis and execution sessions only if needed to understand what was already tried and what remains.

1. Deduplicate across concerns
2. Group related findings so the execution pass can fix them coherently
3. Order work to respect dependencies and minimize churn
4. Rank by severity within that ordering
5. Optionally use the \`counsel\` tool for a cross-vendor review

Present the actionable report.
Then call the audit_synthesis_complete tool with the ordered findings to execute:
- findings: [{ file, description, severity }]
- Use an empty array when there are no actionable findings.
Do not output JSON blocks or prose completion markers.`;
}

export function buildExecutionPrompt(state: Extract<AuditState, { _tag: "Executing" }>): string {
  const userBlock = state.userPrompt ? `\n## Focus\n${state.userPrompt}\n` : "";
  const plan = state.findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.file} — ${finding.description}`,
    )
    .join("\n");
  const previousExecutionSessions = formatSessionPathBlock(
    "Previous Execution Sessions",
    state.previousExecutionSessionPaths,
  );

  return `Execute the synthesized audit plan for loop ${state.iteration}/${state.maxIterations}.${userBlock}

## Ordered Plan
${plan}${previousExecutionSessions}
Apply the plan in the given order. Related findings may need to be fixed together.
Run validation as needed while working. Use counsel if it meaningfully improves confidence.
Try to complete the whole plan in this session.
If you determine there is nothing to do, call audit_execution_result with outcome: "skip".
When you finish the plan, call audit_execution_result with outcome: "completed".
Do not use prose completion markers.`;
}

function formatConcernList(concerns: readonly AuditConcernTask[]): string {
  return concerns
    .map((concern) => `- ${concern.order}. ${concern.subject} — ${concern.metadata.description}`)
    .join("\n");
}

function formatFocusBlock(userPrompt: string): string {
  return userPrompt.trim().length > 0 ? `\n\nFocus: ${userPrompt.trim()}` : "";
}

function summarizeAuditTargets(targetPaths: readonly string[]): string {
  if (targetPaths.length === 0) return "No explicit targets";
  if (targetPaths.length === 1) return targetPaths[0]!;
  return `${targetPaths[0]!} +${targetPaths.length - 1} more`;
}

export function buildAuditPhaseMessage(
  state: Extract<
    AuditState,
    {
      _tag: "Detecting" | "AwaitingConcernApproval" | "Auditing" | "Synthesizing" | "Executing";
    }
  >,
): string {
  switch (state._tag) {
    case "Detecting":
      return `Audit loop ${state.iteration}/${state.maxIterations} started. Developing concerns for ${summarizeAuditTargets(state.targetPaths)}.${formatFocusBlock(state.userPrompt)}`;
    case "AwaitingConcernApproval":
      return `Concern proposal ready. Waiting for approval on ${state.concerns.length} concern${state.concerns.length === 1 ? "" : "s"}.${formatFocusBlock(state.userPrompt)}`;
    case "Auditing":
      return `Audit loop ${state.iteration}/${state.maxIterations}. Running ${state.concerns.length} concern audit${state.concerns.length === 1 ? "" : "s"}.${formatFocusBlock(state.userPrompt)}\n\n${formatConcernList(state.concerns)}`;
    case "Synthesizing":
      return `Audit loop ${state.iteration}/${state.maxIterations}. Synthesizing findings from ${state.concerns.length} concern${state.concerns.length === 1 ? "" : "s"}.`;
    case "Executing":
      return `Audit loop ${state.iteration}/${state.maxIterations}. Executing synthesized plan with ${state.findings.length} item${state.findings.length === 1 ? "" : "s"}.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<AuditState, AuditEffect>;

const UI: AuditEffect = { type: "updateUI" };

function triggerConcernTool(): AuditEffect {
  return executeTurn({
    customType: "audit-progress",
    content: "Concern audits are ready. Call audit_run_concerns to execute them.",
    display: false,
    triggerTurn: true,
  });
}

function triggerDetectionTool(): AuditEffect {
  return executeTurn({
    customType: "audit-progress",
    content: "Detection is ready. Call audit_run_detection to execute it.",
    display: false,
    triggerTurn: true,
  });
}

function triggerSynthesisTool(): AuditEffect {
  return executeTurn({
    customType: "audit-progress",
    content: "Synthesis is ready. Call audit_run_synthesis to execute it.",
    display: false,
    triggerTurn: true,
  });
}

function triggerExecutionTool(): AuditEffect {
  return executeTurn({
    customType: "audit-progress",
    content: "Execution is ready. Call audit_run_execution to execute it.",
    display: false,
    triggerTurn: true,
  });
}

function persist(state: AuditState): AuditEffect {
  const payload: PersistPayload = (() => {
    switch (state._tag) {
      case "Idle":
        return { mode: "Idle" };
      case "Detecting":
        return {
          mode: "Detecting",
          scope: state.scope,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          skillCatalog: state.skillCatalog,
          userPrompt: state.userPrompt,
          detectionFeedback: state.detectionFeedback,
          previousThinkingLevel: state.previousThinkingLevel,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
      case "AwaitingConcernApproval":
        return {
          mode: "AwaitingConcernApproval",
          scope: state.scope,
          proposedConcerns: state.concerns,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          skillCatalog: state.skillCatalog,
          userPrompt: state.userPrompt,
          detectionFeedback: state.detectionFeedback,
          previousThinkingLevel: state.previousThinkingLevel,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
      case "Auditing":
        return {
          mode: "Auditing",
          scope: state.scope,
          concerns: state.concerns,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          userPrompt: state.userPrompt,
          concernCursor: state.cursor,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
      case "Synthesizing":
        return {
          mode: "Synthesizing",
          concerns: state.concerns,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          userPrompt: state.userPrompt,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
      case "Executing":
        return {
          mode: "Executing",
          concerns: state.concerns,
          findings: state.findings,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          userPrompt: state.userPrompt,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
    }
  })();

  return { type: "persistState", state: payload };
}

export function getAuditStatusText(state: AuditState): string | undefined {
  switch (state._tag) {
    case "Idle":
      return undefined;
    case "Detecting":
      return `audit: loop ${state.iteration}/${state.maxIterations} detecting`;
    case "AwaitingConcernApproval":
      return "audit: approve concerns";
    case "Auditing": {
      const completed = state.concerns.filter((concern) => concern.status === "completed").length;
      return `audit: loop ${state.iteration}/${state.maxIterations} ${completed}/${state.concerns.length}`;
    }
    case "Synthesizing":
      return `audit: loop ${state.iteration}/${state.maxIterations} synthesizing`;
    case "Executing":
      return `audit: loop ${state.iteration}/${state.maxIterations} executing`;
  }
}

function visibleMessage(content: string, customType = "audit-progress"): ExecutionEffect {
  return executeTurn({
    customType,
    content,
    display: true,
    triggerTurn: false,
  });
}

function statusEffect(text?: string): BuiltinEffect {
  return { type: "setStatus", key: "audit", text };
}

function statusEffectForState(state: AuditState): BuiltinEffect {
  return statusEffect(getAuditStatusText(state));
}

function createConcernTasks(concerns: readonly AuditConcern[]): AuditConcernTask[] {
  return concerns.map((concern, index) => ({
    id: String(index + 1),
    order: index + 1,
    subject: concern.name,
    activeForm: `Auditing ${concern.name}`,
    status: "pending",
    blockedBy: [],
    metadata: {
      description: concern.description,
      skills: concern.skills,
    },
  }));
}

function cloneConcernTask(concern: AuditConcernTask): AuditConcernTask {
  return {
    ...concern,
    blockedBy: [...concern.blockedBy],
    metadata: {
      description: concern.metadata.description,
      skills: [...concern.metadata.skills],
      notes: concern.metadata.notes,
      sessionPath: concern.metadata.sessionPath,
    },
  };
}

function cloneConcernTasks(concerns: readonly AuditConcernTask[]): AuditConcernTask[] {
  return concerns.map(cloneConcernTask);
}

function setConcernStatuses(
  concerns: readonly AuditConcernTask[],
  taskIds: readonly string[],
  status: AuditConcernTask["status"],
): AuditConcernTask[] {
  const targetIds = new Set(taskIds);
  return cloneConcernTasks(concerns).map((concern) =>
    targetIds.has(concern.id)
      ? {
          ...concern,
          status,
        }
      : concern,
  );
}

function setConcernNotes(
  concerns: readonly AuditConcernTask[],
  taskId: string,
  notes: string,
): AuditConcernTask[] {
  return cloneConcernTasks(concerns).map((concern) =>
    concern.id === taskId
      ? {
          ...concern,
          metadata: {
            ...concern.metadata,
            notes,
          },
        }
      : concern,
  );
}

function setConcernSessionPaths(
  concerns: readonly AuditConcernTask[],
  sessions: ReadonlyArray<{ taskId: string; sessionPath: string }>,
): AuditConcernTask[] {
  const byTaskId = new Map(sessions.map((session) => [session.taskId, session.sessionPath]));
  return cloneConcernTasks(concerns).map((concern) => {
    const sessionPath = byTaskId.get(concern.id);
    if (!sessionPath) return concern;
    return {
      ...concern,
      metadata: {
        ...concern.metadata,
        sessionPath,
      },
    };
  });
}

function getConcernForCursor(
  concerns: readonly AuditConcernTask[],
  cursor: GraphExecutionCursor,
): AuditConcernTask | undefined {
  const concernId = cursor.activeTaskIds[0] ?? cursor.frontierTaskIds[0];
  return concernId === undefined ? undefined : concerns.find((concern) => concern.id === concernId);
}

function startConcernExecution(concerns: readonly AuditConcernTask[]): {
  concerns: AuditConcernTask[];
  cursor: GraphExecutionCursor;
  concern: AuditConcernTask;
} | null {
  const cursor = startGraphExecution(concerns, AUDIT_GRAPH_POLICY);
  if (!cursor) return null;

  const nextConcerns = setConcernStatuses(concerns, cursor.frontierTaskIds, "in_progress");
  const concern = getConcernForCursor(nextConcerns, cursor);
  if (!concern) return null;

  return {
    concerns: nextConcerns,
    cursor,
    concern,
  };
}

function getHydratedConcernExecution(
  concerns: readonly AuditConcernTask[],
  cursor: GraphExecutionCursor | undefined,
): { concerns: AuditConcernTask[]; cursor: GraphExecutionCursor } | null {
  const normalizedConcerns = cloneConcernTasks(concerns).map((concern) => ({
    ...concern,
    status: (concern.status === "completed"
      ? "completed"
      : "pending") as AuditConcernTask["status"],
  }));
  const completedConcernIds = new Set(
    normalizedConcerns
      .filter((concern) => concern.status === "completed")
      .map((concern) => concern.id),
  );
  const validConcernIds = new Set(normalizedConcerns.map((concern) => concern.id));
  const frontierTaskIds =
    cursor?.frontierTaskIds.filter(
      (taskId) => validConcernIds.has(taskId) && !completedConcernIds.has(taskId),
    ) ?? [];
  const activeTaskIds =
    cursor?.activeTaskIds.filter((taskId) => frontierTaskIds.includes(taskId)) ?? [];
  const inferredCursor = startGraphExecution(normalizedConcerns, AUDIT_GRAPH_POLICY);
  const nextCursor =
    frontierTaskIds.length > 0
      ? {
          phase: "running" as const,
          frontierTaskIds,
          activeTaskIds: activeTaskIds.length > 0 ? activeTaskIds : [...frontierTaskIds],
          total: normalizedConcerns.length,
        }
      : inferredCursor;
  if (!nextCursor) return null;

  return {
    concerns: setConcernStatuses(normalizedConcerns, nextCursor.frontierTaskIds, "in_progress"),
    cursor: nextCursor,
  };
}

function transitionToAuditing(
  state: Extract<AuditState, { _tag: "Detecting" | "AwaitingConcernApproval" }>,
  concerns: readonly AuditConcern[],
): Result {
  const concernExecution = startConcernExecution(
    createConcernTasks(concerns.slice(0, MAX_CONCERNS)),
  );
  if (!concernExecution) {
    const next: AuditState = { _tag: "Idle" };
    return {
      state: next,
      effects: [
        {
          type: "notify",
          message: "audit: couldn't start concern execution",
          level: "error",
        },
        statusEffectForState(next),
        UI,
        persist(next),
      ],
    };
  }

  const next: Extract<AuditState, { _tag: "Auditing" }> = {
    _tag: "Auditing",
    scope: state.scope,
    concerns: concernExecution.concerns,
    diffStat: state.diffStat,
    targetPaths: state.targetPaths,
    userPrompt: state.userPrompt,
    cursor: concernExecution.cursor,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    previousConcernSessionPaths: state.previousConcernSessionPaths,
    previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
    previousExecutionSessionPaths: state.previousExecutionSessionPaths,
  };
  return {
    state: next,
    effects: [
      statusEffectForState(next),
      visibleMessage(buildAuditPhaseMessage(next)),
      triggerConcernTool(),
      UI,
      persist(next),
    ],
  };
}

function resetConcernIteration(concerns: readonly AuditConcernTask[]): AuditConcernTask[] {
  return cloneConcernTasks(concerns).map((concern) => ({
    ...concern,
    status: "pending",
    metadata: {
      ...concern.metadata,
      notes: undefined,
      sessionPath: undefined,
    },
  }));
}

function continueAuditLoop(
  state: Extract<AuditState, { _tag: "Auditing" | "Synthesizing" | "Executing" }>,
  additionalConcernSessionPaths: readonly string[] = [],
  additionalSynthesisSessionPaths: readonly string[] = [],
  additionalExecutionSessionPaths: readonly string[] = [],
): Result {
  if (state.iteration >= state.maxIterations) {
    const next: AuditState = { _tag: "Idle" };
    return {
      state: next,
      effects: [
        {
          type: "notify",
          message: `audit stopped after reaching max iterations (${state.maxIterations})`,
          level: "warning",
        },
        visibleMessage(
          `Audit stopped after ${state.maxIterations} loop${state.maxIterations === 1 ? "" : "s"}.`,
        ),
        statusEffectForState(next),
        UI,
        persist(next),
      ],
    };
  }

  const restarted = startConcernExecution(resetConcernIteration(state.concerns));
  if (!restarted) {
    const next: AuditState = { _tag: "Idle" };
    return {
      state: next,
      effects: [
        { type: "notify", message: "audit: couldn't restart concern execution", level: "error" },
        statusEffectForState(next),
        UI,
        persist(next),
      ],
    };
  }

  const next: Extract<AuditState, { _tag: "Auditing" }> = {
    _tag: "Auditing",
    scope: state.scope,
    concerns: restarted.concerns,
    diffStat: state.diffStat,
    targetPaths: state.targetPaths,
    userPrompt: state.userPrompt,
    cursor: restarted.cursor,
    iteration: state.iteration + 1,
    maxIterations: state.maxIterations,
    previousConcernSessionPaths: [
      ...state.previousConcernSessionPaths,
      ...additionalConcernSessionPaths,
    ],
    previousSynthesisSessionPaths: [
      ...state.previousSynthesisSessionPaths,
      ...additionalSynthesisSessionPaths,
    ],
    previousExecutionSessionPaths: [
      ...state.previousExecutionSessionPaths,
      ...additionalExecutionSessionPaths,
    ],
  };

  return {
    state: next,
    effects: [
      statusEffectForState(next),
      visibleMessage(buildAuditPhaseMessage(next)),
      triggerConcernTool(),
      UI,
      persist(next),
    ],
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const auditReducer: Reducer<AuditState, AuditEvent, AuditEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    case "Start": {
      if (state._tag !== "Idle") return { state };
      const next: Extract<AuditState, { _tag: "Detecting" }> = {
        _tag: "Detecting",
        scope: event.scope,
        diffStat: event.diffStat,
        targetPaths: event.targetPaths,
        skillCatalog: event.skillCatalog,
        userPrompt: event.userPrompt,
        detectionFeedback: event.detectionFeedback,
        previousThinkingLevel: event.previousThinkingLevel,
        iteration: 1,
        maxIterations: event.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        previousConcernSessionPaths: [],
        previousSynthesisSessionPaths: [],
        previousExecutionSessionPaths: [],
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          triggerDetectionTool(),
          UI,
          persist(next),
        ],
      };
    }

    case "ConcernsProposed": {
      if (state._tag !== "Detecting") return { state };
      if (event.concerns.length === 0) {
        const next: AuditState = { _tag: "Idle" };
        return {
          state: next,
          effects: [
            { type: "notify", message: "no audit concerns detected", level: "info" },
            statusEffectForState(next),
            UI,
            persist(next),
          ],
        };
      }

      const next: Extract<AuditState, { _tag: "AwaitingConcernApproval" }> = {
        _tag: "AwaitingConcernApproval",
        scope: state.scope,
        concerns: event.concerns.slice(0, MAX_CONCERNS),
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
        skillCatalog: state.skillCatalog,
        userPrompt: state.userPrompt,
        detectionFeedback: state.detectionFeedback,
        previousThinkingLevel: state.previousThinkingLevel,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        previousConcernSessionPaths: state.previousConcernSessionPaths,
        previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
        previousExecutionSessionPaths: state.previousExecutionSessionPaths,
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          UI,
          persist(next),
        ],
      };
    }

    case "ConcernsApproved": {
      if (state._tag !== "AwaitingConcernApproval") return { state };
      return transitionToAuditing(state, state.concerns);
    }

    case "ConcernsRejected": {
      if (state._tag !== "AwaitingConcernApproval") return { state };
      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "audit cancelled before concern approval", level: "info" },
          statusEffectForState(next),
          UI,
          persist(next),
        ],
      };
    }

    case "ConcernsEdited": {
      if (state._tag !== "AwaitingConcernApproval") return { state };
      const next: Extract<AuditState, { _tag: "Detecting" }> = {
        _tag: "Detecting",
        scope: state.scope,
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
        skillCatalog: state.skillCatalog,
        userPrompt: state.userPrompt,
        detectionFeedback: event.feedback,
        previousThinkingLevel: state.previousThinkingLevel,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        previousConcernSessionPaths: state.previousConcernSessionPaths,
        previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
        previousExecutionSessionPaths: state.previousExecutionSessionPaths,
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage("Revising audit concerns with user edits."),
          triggerDetectionTool(),
          UI,
          persist(next),
        ],
      };
    }

    case "DetectionFailed": {
      if (state._tag !== "Detecting") return { state };
      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [
          {
            type: "notify",
            message: "audit: concern detection ended before audit_proposed_concerns was called",
            level: "error",
          },
          statusEffectForState(next),
          UI,
          persist(next),
        ],
      };
    }

    case "ConcernSessionsPrepared": {
      if (state._tag !== "Auditing") return { state };
      const next: Extract<AuditState, { _tag: "Auditing" }> = {
        ...state,
        concerns: setConcernSessionPaths(state.concerns, event.sessions),
      };
      return {
        state: next,
        effects: [UI, persist(next)],
      };
    }

    case "ConcernAudited": {
      if (state._tag !== "Auditing") return { state };

      const concerns = setConcernStatuses(
        setConcernNotes(state.concerns, event.taskId, event.notes),
        [event.taskId],
        "completed",
      );
      const progress = recordGraphTaskCompletion(state.cursor, event.taskId);
      if (!progress) return { state };

      if (progress.phase === "running") {
        const next: Extract<AuditState, { _tag: "Auditing" }> = {
          ...state,
          concerns,
          cursor: progress,
        };
        return {
          state: next,
          effects: [statusEffectForState(next), UI, persist(next)],
        };
      }

      const concernExecution = startConcernExecution(concerns);
      if (!concernExecution) {
        const next: Extract<AuditState, { _tag: "Synthesizing" }> = {
          _tag: "Synthesizing",
          concerns,
          scope: state.scope,
          diffStat: state.diffStat,
          targetPaths: state.targetPaths,
          userPrompt: state.userPrompt,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          previousConcernSessionPaths: state.previousConcernSessionPaths,
          previousSynthesisSessionPaths: state.previousSynthesisSessionPaths,
          previousExecutionSessionPaths: state.previousExecutionSessionPaths,
        };
        return {
          state: next,
          effects: [
            statusEffectForState(next),
            visibleMessage(buildAuditPhaseMessage(next)),
            triggerSynthesisTool(),
            UI,
            persist(next),
          ],
        };
      }

      const next: Extract<AuditState, { _tag: "Auditing" }> = {
        ...state,
        concerns: concernExecution.concerns,
        cursor: concernExecution.cursor,
      };
      return {
        state: next,
        effects: [statusEffectForState(next), UI, persist(next)],
      };
    }

    case "ConcernAuditFailed": {
      if (state._tag !== "Auditing") return { state };
      const loop = continueAuditLoop(state, event.sessionPaths);
      return {
        state: loop.state,
        effects: [
          { type: "notify", message: event.message, level: "warning" },
          ...(loop.effects ?? []),
        ],
      };
    }

    case "SynthesisComplete": {
      if (state._tag !== "Synthesizing") return { state };
      const previousSynthesisSessionPaths = event.sessionPath
        ? [...state.previousSynthesisSessionPaths, event.sessionPath]
        : state.previousSynthesisSessionPaths;
      if (event.findings.length === 0) {
        const next: AuditState = { _tag: "Idle" };
        return {
          state: next,
          effects: [
            {
              type: "notify",
              message: "audit complete — no actionable findings remain",
              level: "info",
            },
            visibleMessage("Audit complete. No actionable findings remain."),
            statusEffectForState(next),
            UI,
            persist(next),
          ],
        };
      }

      const next: Extract<AuditState, { _tag: "Executing" }> = {
        _tag: "Executing",
        concerns: state.concerns,
        findings: event.findings,
        scope: state.scope,
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
        userPrompt: state.userPrompt,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        previousConcernSessionPaths: state.previousConcernSessionPaths,
        previousSynthesisSessionPaths,
        previousExecutionSessionPaths: state.previousExecutionSessionPaths,
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          triggerExecutionTool(),
          UI,
          persist(next),
        ],
      };
    }

    case "SynthesisFailed": {
      if (state._tag !== "Synthesizing") return { state };
      const loop = continueAuditLoop(state, [], event.sessionPath ? [event.sessionPath] : []);
      return {
        state: loop.state,
        effects: [
          {
            type: "notify",
            message:
              event.message ?? "audit synthesis ended before audit_synthesis_complete was called",
            level: "warning",
          },
          ...(loop.effects ?? []),
        ],
      };
    }

    case "ExecutionComplete": {
      if (state._tag !== "Executing") return { state };
      const loop = continueAuditLoop(state, [], [], [event.sessionPath]);
      return {
        state: loop.state,
        effects: [
          { type: "notify", message: "audit execution complete — re-auditing", level: "info" },
          ...(loop.effects ?? []),
        ],
      };
    }

    case "ExecutionFailed": {
      if (state._tag !== "Executing") return { state };
      const loop = continueAuditLoop(state, [], [], event.sessionPath ? [event.sessionPath] : []);
      return {
        state: loop.state,
        effects: [
          {
            type: "notify",
            message:
              event.message ?? "audit execution ended before audit_execution_result was called",
            level: "warning",
          },
          ...(loop.effects ?? []),
        ],
      };
    }

    case "Cancel": {
      if (state._tag === "Idle") return { state };
      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "audit cancelled", level: "info" },
          statusEffectForState(next),
          UI,
          persist(next),
        ],
      };
    }

    case "Hydrate": {
      const iteration = event.iteration ?? 1;
      const maxIterations = event.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const previousConcernSessionPaths = event.previousConcernSessionPaths ?? [];
      const previousSynthesisSessionPaths = event.previousSynthesisSessionPaths ?? [];
      const previousExecutionSessionPaths = event.previousExecutionSessionPaths ?? [];

      if (event.mode === "Detecting" && event.scope && event.previousThinkingLevel) {
        const next: Extract<AuditState, { _tag: "Detecting" }> = {
          _tag: "Detecting",
          scope: event.scope,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          skillCatalog: event.skillCatalog ?? [],
          userPrompt: event.userPrompt ?? "",
          detectionFeedback: event.detectionFeedback,
          previousThinkingLevel: event.previousThinkingLevel,
          iteration,
          maxIterations,
          previousConcernSessionPaths,
          previousSynthesisSessionPaths,
          previousExecutionSessionPaths,
        };
        return { state: next, effects: [statusEffectForState(next), triggerDetectionTool(), UI] };
      }

      if (
        event.mode === "AwaitingConcernApproval" &&
        event.scope &&
        event.previousThinkingLevel &&
        (event.proposedConcerns?.length ?? 0) > 0
      ) {
        const next: Extract<AuditState, { _tag: "AwaitingConcernApproval" }> = {
          _tag: "AwaitingConcernApproval",
          scope: event.scope,
          concerns: event.proposedConcerns ?? [],
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          skillCatalog: event.skillCatalog ?? [],
          userPrompt: event.userPrompt ?? "",
          detectionFeedback: event.detectionFeedback,
          previousThinkingLevel: event.previousThinkingLevel,
          iteration,
          maxIterations,
          previousConcernSessionPaths,
          previousSynthesisSessionPaths,
          previousExecutionSessionPaths,
        };
        return { state: next, effects: [statusEffectForState(next), UI] };
      }

      if (event.mode === "Auditing" && event.scope && (event.concerns?.length ?? 0) > 0) {
        const concernExecution = getHydratedConcernExecution(
          event.concerns ?? [],
          event.concernCursor,
        );
        if (!concernExecution) {
          const next: AuditState = { _tag: "Idle" };
          return { state: next, effects: [statusEffectForState(next), UI] };
        }

        const next: Extract<AuditState, { _tag: "Auditing" }> = {
          _tag: "Auditing",
          scope: event.scope,
          concerns: concernExecution.concerns,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          userPrompt: event.userPrompt ?? "",
          cursor: concernExecution.cursor,
          iteration,
          maxIterations,
          previousConcernSessionPaths,
          previousSynthesisSessionPaths,
          previousExecutionSessionPaths,
        };
        return { state: next, effects: [statusEffectForState(next), triggerConcernTool(), UI] };
      }

      if (event.mode === "Synthesizing" && (event.concerns?.length ?? 0) > 0 && event.scope) {
        const next: Extract<AuditState, { _tag: "Synthesizing" }> = {
          _tag: "Synthesizing",
          concerns: event.concerns ?? [],
          scope: event.scope,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          userPrompt: event.userPrompt ?? "",
          iteration,
          maxIterations,
          previousConcernSessionPaths,
          previousSynthesisSessionPaths,
          previousExecutionSessionPaths,
        };
        return { state: next, effects: [statusEffectForState(next), triggerSynthesisTool(), UI] };
      }

      if (event.mode === "Executing" && (event.findings?.length ?? 0) > 0 && event.scope) {
        const next: Extract<AuditState, { _tag: "Executing" }> = {
          _tag: "Executing",
          concerns: event.concerns ?? [],
          findings: event.findings ?? [],
          scope: event.scope,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          userPrompt: event.userPrompt ?? "",
          iteration,
          maxIterations,
          previousConcernSessionPaths,
          previousSynthesisSessionPaths,
          previousExecutionSessionPaths,
        };
        return { state: next, effects: [statusEffectForState(next), triggerExecutionTool(), UI] };
      }

      const next: AuditState = { _tag: "Idle" };
      return { state: next, effects: [statusEffectForState(next), UI] };
    }

    case "Reset": {
      const next: AuditState = { _tag: "Idle" };
      return { state: next, effects: [statusEffectForState(next), UI] };
    }
  }
};
