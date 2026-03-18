/**
 * Audit — pure state machine.
 *
 * Full audit-loop: detect → audit → synthesize → fix → gate → counsel → next.
 * Zero pi imports beyond the state machine framework.
 */

import type { SkillCatalogEntry } from "@cvr/pi-diff-context";
import { executeTurn, type ExecutionEffect } from "@cvr/pi-execution";
import {
  enterSequentialExecutionGate,
  resolveSequentialExecutionCounsel,
  resolveSequentialExecutionGate,
  type SequentialExecutionPhase,
} from "@cvr/pi-sequential-execution";
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

export type FixPhase = SequentialExecutionPhase;

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
      concerns: AuditConcern[];
      diffStat: string;
      targetPaths: string[];
      userPrompt: string;
    }
  | {
      _tag: "Synthesizing";
      concerns: AuditConcern[];
      userPrompt: string;
    }
  | {
      _tag: "Fixing";
      concerns: AuditConcern[];
      findings: AuditFinding[];
      currentFinding: number;
      phase: FixPhase;
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
  | { _tag: "AuditingComplete" }
  | { _tag: "SynthesisComplete"; findings: AuditFinding[] }
  | { _tag: "FindingFixed" }
  | { _tag: "FixGatePass" }
  | { _tag: "FixGateFail" }
  | { _tag: "FixCounselPass" }
  | { _tag: "FixCounselFail" }
  | { _tag: "FixSkip" }
  | { _tag: "Cancel" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type AuditEffect = ExecutionEffect | { type: "updateUI" };

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

export function buildAuditingPrompt(state: Extract<AuditState, { _tag: "Auditing" }>): string {
  const concernsList = state.concerns
    .map((c) => {
      const skills = c.skills.length > 0 ? ` (skills: ${c.skills.join(", ")})` : "";
      return `- ${c.name} — ${c.description}${skills}`;
    })
    .join("\n");
  const targetPathsList = state.targetPaths.join(", ");
  const scopeBlock =
    state.scope === "diff"
      ? `${state.diffStat}\nChanged files: ${targetPathsList}`
      : `Explicit audit targets: ${targetPathsList}`;
  const scopeRule =
    state.scope === "diff"
      ? "Use diff stat only for scoping. Do NOT inject raw diff — each subagent reads files directly."
      : "These paths were selected explicitly, not from a diff. Each subagent should inspect the files or directories directly.";

  return `Run parallel audits for ${state.concerns.length} concerns.

## Concerns
${concernsList}

## Context
${scopeBlock}

Use the \`subagent\` tool in parallel mode. One task per concern. Each subagent gets the concern description, target path list, and skill parameter. ${scopeRule} Include brain principles (~/.brain/principles/) in each subagent's context.

When all subagent results are collected, say "AUDITING_COMPLETE".`;
}

export function buildSynthesisPrompt(state: Extract<AuditState, { _tag: "Synthesizing" }>): string {
  return `Synthesize audit findings from ${state.concerns.length} concern-specific audits.

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<AuditState, AuditEffect>;

const UI: AuditEffect = { type: "updateUI" };

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

function statusEffect(text?: string): BuiltinEffect {
  return { type: "setStatus", key: "audit", text };
}

function completeFindingSequence(state: Extract<AuditState, { _tag: "Fixing" }>): Result {
  const prevFile = state.findings[state.currentFinding]!.file;
  return {
    state: { _tag: "Idle" },
    effects: [
      { type: "notify", message: "audit-loop complete — all findings addressed", level: "info" },
      statusEffect(),
      displayMessage(`Commit the fix for ${prevFile}, then say "AUDIT_LOOP_DONE".`, "audit-commit"),
      UI,
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
      statusEffect(`audit: fix ${nextFindingIndex + 1}/${state.findings.length}`),
      displayMessage(
        `Commit the fix for ${prevFile}, then proceed.\n\n${buildFixPrompt(
          finding,
          nextFindingIndex,
          state.findings.length,
        )}`,
        "audit-fix",
      ),
      UI,
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
          statusEffect("audit: detecting..."),
          triggerMessage(buildDetectionPrompt(next)),
          UI,
        ],
      };
    }

    // ----- ConcernsDetected -----
    case "ConcernsDetected": {
      if (state._tag !== "Detecting") return { state };

      if (event.concerns.length === 0) {
        return {
          state: { _tag: "Idle" },
          effects: [
            { type: "notify", message: "no audit concerns detected", level: "info" },
            statusEffect(),
            UI,
          ],
        };
      }

      const concerns = event.concerns.slice(0, MAX_CONCERNS);
      const next: AuditState = {
        _tag: "Auditing",
        scope: state.scope,
        concerns,
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
        userPrompt: state.userPrompt,
      };
      return {
        state: next,
        effects: [
          statusEffect(`audit: ${concerns.length} concern${concerns.length > 1 ? "s" : ""}`),
          triggerMessage(buildAuditingPrompt(next)),
          UI,
        ],
      };
    }

    // ----- DetectionFailed -----
    case "DetectionFailed": {
      if (state._tag !== "Detecting") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [
          {
            type: "notify",
            message: "audit: couldn't parse concerns from agent output",
            level: "error",
          },
          statusEffect(),
          UI,
        ],
      };
    }

    // ----- AuditingComplete -----
    case "AuditingComplete": {
      if (state._tag !== "Auditing") return { state };
      const next: AuditState = {
        _tag: "Synthesizing",
        concerns: state.concerns,
        userPrompt: state.userPrompt,
      };
      return {
        state: next,
        effects: [
          statusEffect("audit: synthesizing..."),
          triggerMessage(buildSynthesisPrompt(next)),
          UI,
        ],
      };
    }

    // ----- SynthesisComplete -----
    case "SynthesisComplete": {
      if (state._tag !== "Synthesizing") return { state };

      if (event.findings.length === 0) {
        return {
          state: { _tag: "Idle" },
          effects: [
            { type: "notify", message: "audit complete — no findings to fix", level: "info" },
            statusEffect(),
            UI,
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
          statusEffect(`audit: fix 1/${event.findings.length}`),
          displayMessage(buildFixPrompt(first, 0, event.findings.length), "audit-fix"),
          UI,
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
          statusEffect(`audit: gating fix ${state.currentFinding + 1}/${state.findings.length}`),
          triggerMessage(buildFixGatePrompt(), "audit-gate"),
          UI,
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
          statusEffect(`audit: counsel fix ${state.currentFinding + 1}/${state.findings.length}`),
          triggerMessage(buildFixCounselPrompt(), "audit-counsel"),
          UI,
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
          statusEffect(`audit: fix ${state.currentFinding + 1}/${state.findings.length}`),
          triggerMessage(
            "Gate failed. Fix the failures, then say FINDING_FIXED again.",
            "audit-gate-fix",
          ),
          UI,
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
          statusEffect(`audit: fix ${state.currentFinding + 1}/${state.findings.length}`),
          triggerMessage(
            "Counsel found issues. Address the feedback, then say FINDING_FIXED again.",
            "audit-counsel-fix",
          ),
          UI,
        ],
      };
    }

    // ----- Cancel -----
    case "Cancel": {
      if (state._tag === "Idle") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [
          { type: "notify", message: "audit cancelled", level: "info" },
          statusEffect(),
          UI,
        ],
      };
    }

    // ----- Reset -----
    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [statusEffect(), UI],
      };
    }
  }
};
