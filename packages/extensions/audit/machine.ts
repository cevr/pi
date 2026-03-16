/**
 * Audit — pure state machine.
 *
 * Zero pi imports beyond the state machine framework. Tested by calling the reducer directly.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

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

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AuditState =
  | { _tag: "Idle" }
  | {
      _tag: "Detecting";
      diffStat: string;
      changedFiles: string[];
      skillCatalog: SkillCatalogEntry[];
      userPrompt: string;
    }
  | {
      _tag: "Auditing";
      concerns: AuditConcern[];
      diffStat: string;
      changedFiles: string[];
      userPrompt: string;
    }
  | {
      _tag: "Synthesizing";
      concerns: AuditConcern[];
      userPrompt: string;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AuditEvent =
  | {
      _tag: "Start";
      diffStat: string;
      changedFiles: string[];
      skillCatalog: SkillCatalogEntry[];
      userPrompt: string;
    }
  | { _tag: "ConcernsDetected"; concerns: AuditConcern[] }
  | { _tag: "DetectionFailed" }
  | { _tag: "AuditingComplete" }
  | { _tag: "SynthesisComplete" }
  | { _tag: "Cancel" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type AuditEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Prompt builders (pure — used by both reducer effects and wiring)
// ---------------------------------------------------------------------------

export function buildDetectionPrompt(state: Extract<AuditState, { _tag: "Detecting" }>): string {
  const filesList = state.changedFiles.map((f) => `- ${f}`).join("\n");
  const skillsList = state.skillCatalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const userBlock = state.userPrompt ? `\n${state.userPrompt}\n` : "";

  return `Analyze the changed files and determine which audit concerns apply.${userBlock}

## Changed Files
${state.diffStat}

${filesList}

## Available Skills
${skillsList}

A concern is a review category (e.g., "correctness", "frontend-patterns", "type-safety", "effect-domain"). Each concern maps to 0+ skills. Maximum ${MAX_CONCERNS} concerns — merge overlapping domains.

Consider: file extensions, import patterns, and the instructions above for explicit skill mentions.

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
  const changedFilesList = state.changedFiles.join(", ");

  return `Run parallel audits for ${state.concerns.length} concerns.

## Concerns
${concernsList}

## Context
${state.diffStat}
Changed files: ${changedFilesList}

Use the \`subagent\` tool in parallel mode. One task per concern. Each subagent gets the concern description, changed file list, and skill parameter. Do NOT inject raw diff — each subagent reads files directly. Include brain principles (~/.brain/principles/) in each subagent's context.

When all subagent results are collected, say "AUDITING_COMPLETE".`;
}

export function buildSynthesisPrompt(state: Extract<AuditState, { _tag: "Synthesizing" }>): string {
  return `Synthesize audit findings from ${state.concerns.length} concern-specific audits.

1. Deduplicate across concerns
2. Rank by severity
3. Group by file with specific line references
4. Optionally use the \`counsel\` tool for a cross-vendor review
5. Present the final actionable report

Say "AUDIT_COMPLETE" when done.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<AuditState, AuditEffect>;

const UI: AuditEffect = { type: "updateUI" };

function triggerMessage(content: string): BuiltinEffect {
  return {
    type: "sendMessage",
    customType: "audit-trigger",
    content,
    display: false,
    triggerTurn: true,
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
    // ----- Start -----
    case "Start": {
      if (state._tag !== "Idle") return { state };
      const next: AuditState = {
        _tag: "Detecting",
        diffStat: event.diffStat,
        changedFiles: event.changedFiles,
        skillCatalog: event.skillCatalog,
        userPrompt: event.userPrompt,
      };
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "audit", text: "audit: detecting..." },
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
            { type: "setStatus", key: "audit" },
            UI,
          ],
        };
      }

      const concerns = event.concerns.slice(0, MAX_CONCERNS);
      const next: AuditState = {
        _tag: "Auditing",
        concerns,
        diffStat: state.diffStat,
        changedFiles: state.changedFiles,
        userPrompt: state.userPrompt,
      };
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "audit",
            text: `audit: ${concerns.length} concern${concerns.length > 1 ? "s" : ""}`,
          },
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
          { type: "setStatus", key: "audit" },
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
          { type: "setStatus", key: "audit", text: "audit: synthesizing..." },
          triggerMessage(buildSynthesisPrompt(next)),
          UI,
        ],
      };
    }

    // ----- SynthesisComplete -----
    case "SynthesisComplete": {
      if (state._tag !== "Synthesizing") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [
          { type: "notify", message: "audit complete", level: "info" },
          { type: "setStatus", key: "audit" },
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
          { type: "setStatus", key: "audit" },
          UI,
        ],
      };
    }

    // ----- Reset -----
    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "audit" }, UI],
      };
    }
  }
};
