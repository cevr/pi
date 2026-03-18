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
import {
  enterSequentialExecutionGate,
  resolveSequentialExecutionCounsel,
  resolveSequentialExecutionGate,
  type SequentialExecutionPhase,
} from "@cvr/pi-sequential-execution";
import type { TaskListItem } from "@cvr/pi-task-list";
import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";

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

export interface AuditConcernTaskMetadata {
  description: string;
  skills: string[];
  notes?: string;
  sessionPath?: string;
}

export interface AuditConcernTask extends TaskListItem {
  metadata: AuditConcernTaskMetadata;
}

export type FixPhase = SequentialExecutionPhase;

export const AUDIT_GRAPH_POLICY: GraphExecutionPolicy = { maxParallel: 3 };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AuditScopeMode = "diff" | "paths";

export type AuditState =
  | { _tag: "Idle" }
  | {
      _tag: "Detecting";
      scope: AuditScopeMode;
      diffStat: string;
      targetPaths: string[];
      skillCatalog: SkillCatalogEntry[];
      userPrompt: string;
    }
  | {
      _tag: "Auditing";
      scope: AuditScopeMode;
      concerns: AuditConcernTask[];
      diffStat: string;
      targetPaths: string[];
      userPrompt: string;
      cursor: GraphExecutionCursor;
    }
  | {
      _tag: "Synthesizing";
      concerns: AuditConcernTask[];
      userPrompt: string;
    }
  | {
      _tag: "Fixing";
      concerns: AuditConcernTask[];
      findings: AuditFinding[];
      currentFinding: number;
      phase: FixPhase;
    }
  | {
      _tag: "Failed";
      failedPhase: "auditing";
      concerns: AuditConcernTask[];
      message: string;
    };

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
    }
  | { _tag: "ConcernsDetected"; concerns: AuditConcern[] }
  | { _tag: "DetectionFailed" }
  | {
      _tag: "ConcernSessionsPrepared";
      sessions: ReadonlyArray<{ taskId: string; sessionPath: string }>;
    }
  | { _tag: "ConcernAudited"; taskId: string; notes: string; sessionPath: string }
  | { _tag: "ConcernAuditFailed"; message: string }
  | { _tag: "SynthesisComplete"; findings: AuditFinding[] }
  | { _tag: "FindingFixed" }
  | { _tag: "FixGatePass" }
  | { _tag: "FixGateFail" }
  | { _tag: "FixCounselPass" }
  | { _tag: "FixCounselFail" }
  | { _tag: "FixSkip" }
  | { _tag: "Cancel" }
  | {
      _tag: "Hydrate";
      mode?: AuditState["_tag"];
      scope?: AuditScopeMode;
      concerns?: AuditConcernTask[];
      diffStat?: string;
      targetPaths?: string[];
      skillCatalog?: SkillCatalogEntry[];
      userPrompt?: string;
      concernCursor?: GraphExecutionCursor;
      findings?: AuditFinding[];
      currentFinding?: number;
      phase?: FixPhase;
      failedPhase?: "auditing";
      message?: string;
    }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type AuditEffect =
  | ExecutionEffect
  | { type: "persistState"; state: PersistPayload }
  | { type: "runConcernBatch"; state: Extract<AuditState, { _tag: "Auditing" }> }
  | { type: "updateUI" };

export interface PersistPayload {
  mode: AuditState["_tag"];
  scope?: AuditScopeMode;
  concerns?: AuditConcernTask[];
  diffStat?: string;
  targetPaths?: string[];
  skillCatalog?: SkillCatalogEntry[];
  userPrompt?: string;
  concernCursor?: GraphExecutionCursor;
  findings?: AuditFinding[];
  currentFinding?: number;
  phase?: FixPhase;
  failedPhase?: "auditing";
  message?: string;
}

// ---------------------------------------------------------------------------
// Prompt builders (pure — used by both reducer effects and wiring)
// ---------------------------------------------------------------------------

export function buildDetectionPrompt(state: Extract<AuditState, { _tag: "Detecting" }>): string {
  const pathsList = state.targetPaths.map((filePath) => `- ${filePath}`).join("\n");
  const skillsList = state.skillCatalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const userBlock = state.userPrompt ? `\n${state.userPrompt}\n` : "";
  const scopeBlock =
    state.scope === "diff"
      ? `## Changed Files\n${state.diffStat}\n\n${pathsList}`
      : `## Audit Paths\n${pathsList}\n\nThese are explicit audit targets. They may be files or directories. Inspect them directly before choosing concerns.`;

  return `Analyze the audit scope and determine which audit concerns apply.${userBlock}

${scopeBlock}

## Available Skills
${skillsList}

A concern is a review category (e.g., "correctness", "frontend-patterns", "type-safety", "effect-domain"). Each concern maps to 0+ skills. Maximum ${MAX_CONCERNS} concerns — merge overlapping domains.

Consider: file extensions, import patterns, directory structure, and the instructions above for explicit skill mentions.

Output a JSON block:
\`\`\`json
{"concerns": [{"name": "...", "description": "...", "skills": ["..."]}]}
\`\`\`

Say "CONCERNS_DETECTED" when done.`;
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

  return `Audit concern ${concern.order}/${state.concerns.length}: ${concern.subject}

## Concern
- Name: ${concern.subject}
- Description: ${concern.metadata.description}
- Skills: ${skills}${userBlock}

## Context
${scopeBlock}

${scopeRule}

Produce the concern-specific audit notes in plain text with concrete file references. When this concern audit is complete, say "CONCERN_AUDITED".`;
}

export function buildSynthesisPrompt(state: Extract<AuditState, { _tag: "Synthesizing" }>): string {
  const userBlock = state.userPrompt ? `\n## Focus\n${state.userPrompt}\n` : "";
  const concernNotes = state.concerns
    .map((concern) => {
      const notes = concern.metadata.notes?.trim() || "(no notes collected)";
      return `## Concern ${concern.order}: ${concern.subject}\n${notes}`;
    })
    .join("\n\n");

  return `Synthesize audit findings from ${state.concerns.length} concern-specific audits.${userBlock}

## Concern Audit Notes
${concernNotes}

1. Deduplicate across concerns
2. Rank by severity (critical → warning → suggestion)
3. Group by file with specific line references
4. Optionally use the \`counsel\` tool for a cross-vendor review

Present the actionable report, then output a structured JSON block of findings to fix:

\`\`\`json
{"findings": [{"file": "path/to/file.ts", "description": "what to fix", "severity": "critical|warning|suggestion"}]}
\`\`\`

If there are no actionable findings, output an empty array: \`{"findings": []}\`

Say "AUDIT_COMPLETE" when done.`;
}

export function buildFixPrompt(finding: AuditFinding, index: number, total: number): string {
  return `Fix finding ${index + 1}/${total}: [${finding.severity}] ${finding.file}

${finding.description}

Read the file, understand the context, and apply the fix. Only change what's necessary.

Say "FINDING_FIXED" when the fix is applied.
Say "FINDING_SKIP" if the finding doesn't apply or is already resolved.`;
}

export function buildFixGatePrompt(): string {
  return `Run the full gate (typecheck, lint, format check, test). Report FIX_GATE_PASS if all pass, FIX_GATE_FAIL if any fail.`;
}

export function buildFixCounselPrompt(): string {
  return `Gate passed. Run counsel for a cross-vendor review of the fix. Report FIX_COUNSEL_PASS if approved, FIX_COUNSEL_FAIL if issues found.`;
}

function formatConcernList(concerns: readonly AuditConcernTask[]): string {
  return concerns
    .map((concern) => `- ${concern.order}. ${concern.subject} — ${concern.metadata.description}`)
    .join("\n");
}

function summarizeAuditTargets(targetPaths: readonly string[]): string {
  if (targetPaths.length === 0) return "No explicit targets";
  if (targetPaths.length === 1) return targetPaths[0]!;
  return `${targetPaths[0]!} +${targetPaths.length - 1} more`;
}

export function buildAuditPhaseMessage(
  state: Extract<
    AuditState,
    { _tag: "Detecting" | "Auditing" | "Synthesizing" | "Fixing" | "Failed" }
  >,
): string {
  switch (state._tag) {
    case "Detecting":
      return `Audit started. Detecting concerns for ${summarizeAuditTargets(state.targetPaths)}.`;
    case "Auditing":
      return `Detected ${state.concerns.length} audit concern${state.concerns.length === 1 ? "" : "s"}. Launching concern audits.\n\n${formatConcernList(state.concerns)}`;
    case "Synthesizing":
      return `Concern audits complete. Synthesizing findings from ${state.concerns.length} concern${state.concerns.length === 1 ? "" : "s"}.`;
    case "Fixing": {
      const finding = state.findings[state.currentFinding];
      return finding
        ? `Audit synthesis complete. Starting fix ${state.currentFinding + 1}/${state.findings.length}: [${finding.severity}] ${finding.file} — ${finding.description}`
        : `Audit synthesis complete. Starting fix loop for ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}.`;
    }
    case "Failed":
      return `Audit failed during ${state.failedPhase}.\n\n${state.message}`;
  }
}

export function buildConcernSessionMessage(
  concerns: readonly AuditConcernTask[],
  sessions: ReadonlyArray<{ taskId: string; sessionPath: string }>,
): string {
  const lines = sessions.map(({ taskId, sessionPath }) => {
    const concern = concerns.find((item) => item.id === taskId);
    const label = concern ? `${concern.order}. ${concern.subject}` : taskId;
    return `- ${label}: ${sessionPath}`;
  });
  return `Concern audit transcripts:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<AuditState, AuditEffect>;

const UI: AuditEffect = { type: "updateUI" };

function runConcernBatch(state: Extract<AuditState, { _tag: "Auditing" }>): AuditEffect {
  return { type: "runConcernBatch", state };
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
        };
      case "Synthesizing":
        return {
          mode: "Synthesizing",
          concerns: state.concerns,
          userPrompt: state.userPrompt,
        };
      case "Fixing":
        return {
          mode: "Fixing",
          concerns: state.concerns,
          findings: state.findings,
          currentFinding: state.currentFinding,
          phase: state.phase,
        };
      case "Failed":
        return {
          mode: "Failed",
          failedPhase: state.failedPhase,
          concerns: state.concerns,
          message: state.message,
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
      return "audit: detecting...";
    case "Auditing": {
      const activeConcerns = getActiveAuditConcerns(state);
      if (activeConcerns.length <= 1) {
        const concern = activeConcerns[0] ?? getCurrentAuditConcern(state);
        return `audit: concern ${concern?.order ?? 0}/${state.concerns.length}`;
      }
      return `audit: ${activeConcerns.length} concerns active/${state.concerns.length}`;
    }
    case "Synthesizing":
      return "audit: synthesizing...";
    case "Fixing":
      return state.phase === "gating"
        ? `audit: gating fix ${state.currentFinding + 1}/${state.findings.length}`
        : state.phase === "counseling"
          ? `audit: counsel fix ${state.currentFinding + 1}/${state.findings.length}`
          : `audit: fix ${state.currentFinding + 1}/${state.findings.length}`;
    case "Failed":
      return `audit: failed (${state.failedPhase})`;
  }
}

function triggerMessage(content: string, customType = "audit-trigger"): ExecutionEffect {
  return executeTurn({
    customType,
    content,
    display: false,
    triggerTurn: true,
  });
}

function displayMessage(content: string, customType = "audit-trigger"): ExecutionEffect {
  return executeTurn({
    customType,
    content,
    display: true,
    triggerTurn: true,
  });
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

function getActiveAuditConcerns(
  state: Extract<AuditState, { _tag: "Auditing" }>,
): AuditConcernTask[] {
  return state.concerns.filter((concern) => state.cursor.activeTaskIds.includes(concern.id));
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
    status: concern.status === "completed" ? "completed" : "pending",
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

export function getCurrentAuditConcern(
  state: Extract<AuditState, { _tag: "Auditing" }>,
): AuditConcernTask | undefined {
  return getConcernForCursor(state.concerns, state.cursor);
}

function completeFindingSequence(state: Extract<AuditState, { _tag: "Fixing" }>): Result {
  const prevFile = state.findings[state.currentFinding]!.file;
  const next: AuditState = { _tag: "Idle" };
  return {
    state: next,
    effects: [
      { type: "notify", message: "audit-loop complete — all findings addressed", level: "info" },
      statusEffectForState(next),
      displayMessage(`Commit the fix for ${prevFile}, then say "AUDIT_LOOP_DONE".`, "audit-commit"),
      UI,
      persist(next),
    ],
  };
}

function continueWithFinding(
  state: Extract<AuditState, { _tag: "Fixing" }>,
  nextFindingIndex: number,
): Result {
  if (nextFindingIndex >= state.findings.length) {
    return completeFindingSequence(state);
  }

  const prevFile = state.findings[state.currentFinding]!.file;
  const finding = state.findings[nextFindingIndex]!;
  const next: AuditState = {
    ...state,
    currentFinding: nextFindingIndex,
    phase: "running",
  };
  return {
    state: next,
    effects: [
      statusEffectForState(next),
      displayMessage(
        `Commit the fix for ${prevFile}, then proceed.\n\n${buildFixPrompt(
          finding,
          nextFindingIndex,
          state.findings.length,
        )}`,
        "audit-fix",
      ),
      UI,
      persist(next),
    ],
  };
}

/** Transition into Fixing the next finding, or to Idle if all done. */
function advanceToNextFinding(state: Extract<AuditState, { _tag: "Fixing" }>): Result {
  return continueWithFinding(state, state.currentFinding + 1);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const auditReducer: Reducer<AuditState, AuditEvent, AuditEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    // ----- Start -----
    case "Start": {
      if (state._tag !== "Idle") return { state };
      const next: AuditState = {
        _tag: "Detecting",
        scope: event.scope,
        diffStat: event.diffStat,
        targetPaths: event.targetPaths,
        skillCatalog: event.skillCatalog,
        userPrompt: event.userPrompt,
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          triggerMessage(buildDetectionPrompt(next)),
          UI,
          persist(next),
        ],
      };
    }

    // ----- ConcernsDetected -----
    case "ConcernsDetected": {
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

      const concernExecution = startConcernExecution(
        createConcernTasks(event.concerns.slice(0, MAX_CONCERNS)),
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

      const next: AuditState = {
        _tag: "Auditing",
        scope: state.scope,
        concerns: concernExecution.concerns,
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
        userPrompt: state.userPrompt,
        cursor: concernExecution.cursor,
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          runConcernBatch(next),
          UI,
          persist(next),
        ],
      };
    }

    // ----- DetectionFailed -----
    case "DetectionFailed": {
      if (state._tag !== "Detecting") return { state };
      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [
          {
            type: "notify",
            message: "audit: couldn't parse concerns from agent output",
            level: "error",
          },
          statusEffectForState(next),
          UI,
          persist(next),
        ],
      };
    }

    // ----- ConcernSessionsPrepared -----
    case "ConcernSessionsPrepared": {
      if (state._tag !== "Auditing") return { state };
      const next: AuditState = {
        ...state,
        concerns: setConcernSessionPaths(state.concerns, event.sessions),
      };
      return {
        state: next,
        effects: [
          visibleMessage(buildConcernSessionMessage(next.concerns, event.sessions)),
          UI,
          persist(next),
        ],
      };
    }

    // ----- ConcernAudited -----
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
        const next: AuditState = {
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
        const next: AuditState = {
          _tag: "Synthesizing",
          concerns,
          userPrompt: state.userPrompt,
        };
        return {
          state: next,
          effects: [
            statusEffectForState(next),
            visibleMessage(buildAuditPhaseMessage(next)),
            triggerMessage(buildSynthesisPrompt(next)),
            UI,
            persist(next),
          ],
        };
      }

      const next: AuditState = {
        ...state,
        concerns: concernExecution.concerns,
        cursor: concernExecution.cursor,
      };
      return {
        state: next,
        effects: [statusEffectForState(next), runConcernBatch(next), UI, persist(next)],
      };
    }

    // ----- ConcernAuditFailed -----
    case "ConcernAuditFailed": {
      if (state._tag !== "Auditing") return { state };
      const next: AuditState = {
        _tag: "Failed",
        failedPhase: "auditing",
        concerns: state.concerns,
        message: event.message,
      };
      return {
        state: next,
        effects: [
          { type: "notify", message: event.message, level: "error" },
          visibleMessage(buildAuditPhaseMessage(next), "audit-error"),
          statusEffectForState(next),
          UI,
          persist(next),
        ],
      };
    }

    // ----- SynthesisComplete -----
    case "SynthesisComplete": {
      if (state._tag !== "Synthesizing") return { state };

      if (event.findings.length === 0) {
        const next: AuditState = { _tag: "Idle" };
        return {
          state: next,
          effects: [
            { type: "notify", message: "audit complete — no findings to fix", level: "info" },
            visibleMessage("Audit complete. No actionable findings."),
            statusEffectForState(next),
            UI,
            persist(next),
          ],
        };
      }

      const first = event.findings[0]!;
      const next: AuditState = {
        _tag: "Fixing",
        concerns: state.concerns,
        findings: event.findings,
        currentFinding: 0,
        phase: "running",
      };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          visibleMessage(buildAuditPhaseMessage(next)),
          displayMessage(buildFixPrompt(first, 0, event.findings.length), "audit-fix"),
          UI,
          persist(next),
        ],
      };
    }

    // ----- FindingFixed -----
    case "FindingFixed": {
      if (state._tag !== "Fixing" || state.phase !== "running") return { state };
      const progress = enterSequentialExecutionGate(
        {
          phase: state.phase,
          currentIndex: state.currentFinding,
          total: state.findings.length,
        },
        state.currentFinding,
      );
      if (!progress) return { state };

      const next: AuditState = { ...state, phase: progress.phase };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          triggerMessage(buildFixGatePrompt(), "audit-gate"),
          UI,
          persist(next),
        ],
      };
    }

    // ----- FixSkip -----
    case "FixSkip": {
      if (state._tag !== "Fixing" || state.phase !== "running") return { state };
      return advanceToNextFinding(state);
    }

    // ----- FixGatePass -----
    case "FixGatePass": {
      if (state._tag !== "Fixing" || state.phase !== "gating") return { state };
      const progress = resolveSequentialExecutionGate(
        {
          phase: state.phase,
          currentIndex: state.currentFinding,
          total: state.findings.length,
        },
        "pass",
      );
      if (!progress) return { state };

      const next: AuditState = { ...state, phase: progress.phase };
      return {
        state: next,
        effects: [
          statusEffectForState(next),
          triggerMessage(buildFixCounselPrompt(), "audit-counsel"),
          UI,
          persist(next),
        ],
      };
    }

    // ----- FixGateFail -----
    case "FixGateFail": {
      if (state._tag !== "Fixing" || state.phase !== "gating") return { state };
      const progress = resolveSequentialExecutionGate(
        {
          phase: state.phase,
          currentIndex: state.currentFinding,
          total: state.findings.length,
        },
        "fail",
      );
      if (!progress) return { state };

      const next: AuditState = { ...state, phase: progress.phase };
      return {
        state: next,
        effects: [
          { type: "notify", message: "gate failed — fix and retry", level: "warning" },
          statusEffectForState(next),
          triggerMessage(
            "Gate failed. Fix the failures, then say FINDING_FIXED again.",
            "audit-gate-fix",
          ),
          UI,
          persist(next),
        ],
      };
    }

    // ----- FixCounselPass -----
    case "FixCounselPass": {
      if (state._tag !== "Fixing" || state.phase !== "counseling") return { state };
      const progress = resolveSequentialExecutionCounsel(
        {
          phase: state.phase,
          currentIndex: state.currentFinding,
          total: state.findings.length,
        },
        "pass",
      );
      if (!progress) return { state };
      if (progress.type === "complete") return completeFindingSequence(state);
      if (progress.type === "advance") return continueWithFinding(state, progress.currentIndex);
      return { state };
    }

    // ----- FixCounselFail -----
    case "FixCounselFail": {
      if (state._tag !== "Fixing" || state.phase !== "counseling") return { state };
      const progress = resolveSequentialExecutionCounsel(
        {
          phase: state.phase,
          currentIndex: state.currentFinding,
          total: state.findings.length,
        },
        "fail",
      );
      if (!progress || progress.type !== "retry") return { state };

      const next: AuditState = { ...state, phase: progress.phase };
      return {
        state: next,
        effects: [
          { type: "notify", message: "counsel found issues — address feedback", level: "warning" },
          statusEffectForState(next),
          triggerMessage(
            "Counsel found issues. Address the feedback, then say FINDING_FIXED again.",
            "audit-counsel-fix",
          ),
          UI,
          persist(next),
        ],
      };
    }

    // ----- Cancel -----
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

    // ----- Hydrate -----
    case "Hydrate": {
      if (event.mode === "Detecting" && event.scope) {
        const next: AuditState = {
          _tag: "Detecting",
          scope: event.scope,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          skillCatalog: event.skillCatalog ?? [],
          userPrompt: event.userPrompt ?? "",
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
          return {
            state: next,
            effects: [statusEffectForState(next), UI],
          };
        }

        const next: AuditState = {
          _tag: "Auditing",
          scope: event.scope,
          concerns: concernExecution.concerns,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
          userPrompt: event.userPrompt ?? "",
          cursor: concernExecution.cursor,
        };
        return { state: next, effects: [statusEffectForState(next), runConcernBatch(next), UI] };
      }

      if (event.mode === "Synthesizing" && (event.concerns?.length ?? 0) > 0) {
        const next: AuditState = {
          _tag: "Synthesizing",
          concerns: event.concerns ?? [],
          userPrompt: event.userPrompt ?? "",
        };
        return { state: next, effects: [statusEffectForState(next), UI] };
      }

      if (event.mode === "Fixing" && (event.findings?.length ?? 0) > 0) {
        const findings = event.findings ?? [];
        const currentFinding =
          typeof event.currentFinding === "number" && event.currentFinding >= 0
            ? Math.min(event.currentFinding, findings.length - 1)
            : 0;
        const phase =
          event.phase === "gating" || event.phase === "counseling" || event.phase === "running"
            ? event.phase
            : "running";
        const next: AuditState = {
          _tag: "Fixing",
          concerns: event.concerns ?? [],
          findings,
          currentFinding,
          phase,
        };
        return { state: next, effects: [statusEffectForState(next), UI] };
      }

      if (
        event.mode === "Failed" &&
        (event.concerns?.length ?? 0) > 0 &&
        event.failedPhase &&
        event.message
      ) {
        const next: AuditState = {
          _tag: "Failed",
          failedPhase: event.failedPhase,
          concerns: event.concerns ?? [],
          message: event.message,
        };
        return { state: next, effects: [statusEffectForState(next), UI] };
      }

      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [statusEffectForState(next), UI],
      };
    }

    // ----- Reset -----
    case "Reset": {
      const next: AuditState = { _tag: "Idle" };
      return {
        state: next,
        effects: [statusEffectForState(next), UI],
      };
    }
  }
};
