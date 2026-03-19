/**
 * Audit utilities — typed signal names + transcript helpers.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getDisplayItems } from "@cvr/pi-sub-agent-render";
import type { AuditConcern, AuditFinding } from "./machine";

export const AUDIT_SIGNAL_TOOLS = {
  proposeConcerns: "audit_proposed_concerns",
  concernComplete: "audit_concern_complete",
  synthesisComplete: "audit_synthesis_complete",
  executionResult: "audit_execution_result",
} as const;

function getLastToolCallArgs(
  messages: readonly Message[],
  toolName: string,
): Record<string, unknown> | null {
  const toolCalls = getDisplayItems([...messages]).filter(
    (item): item is Extract<ReturnType<typeof getDisplayItems>[number], { type: "toolCall" }> =>
      item.type === "toolCall" && item.name === toolName && !item.isError,
  );
  return toolCalls.at(-1)?.args ?? null;
}

export function hasToolCall(messages: readonly Message[], toolName: string): boolean {
  return getLastToolCallArgs(messages, toolName) !== null;
}

export function parseConcernCompletion(messages: readonly Message[]): boolean {
  return hasToolCall(messages, AUDIT_SIGNAL_TOOLS.concernComplete);
}

export function parseProposedConcerns(messages: readonly Message[]): AuditConcern[] | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.proposeConcerns);
  if (!args) return null;
  return normalizeConcerns(args.concerns);
}

export function parseSynthesisComplete(messages: readonly Message[]): AuditFinding[] | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.synthesisComplete);
  if (!args) return null;
  return normalizeFindings(args.findings);
}

export function parseExecutionResult(messages: readonly Message[]): "completed" | "skip" | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.executionResult);
  return args?.outcome === "completed" || args?.outcome === "skip" ? args.outcome : null;
}

function normalizeConcerns(value: unknown): AuditConcern[] | null {
  if (!Array.isArray(value)) return null;

  const concerns: AuditConcern[] = [];

  for (const concern of value) {
    if (
      typeof concern !== "object" ||
      concern === null ||
      typeof (concern as { name?: unknown }).name !== "string" ||
      typeof (concern as { description?: unknown }).description !== "string"
    ) {
      return null;
    }

    concerns.push({
      name: (concern as { name: string }).name,
      description: (concern as { description: string }).description,
      skills: Array.isArray((concern as { skills?: unknown }).skills)
        ? (concern as { skills: unknown[] }).skills.filter(
            (skill): skill is string => typeof skill === "string" && skill.length > 0,
          )
        : [],
    });
  }

  return concerns;
}

function normalizeFindings(value: unknown): AuditFinding[] | null {
  if (!Array.isArray(value)) return null;

  const validSeverities = new Set(["critical", "warning", "suggestion"]);
  const findings: AuditFinding[] = [];

  for (const finding of value) {
    if (
      typeof finding !== "object" ||
      finding === null ||
      typeof (finding as { file?: unknown }).file !== "string" ||
      typeof (finding as { description?: unknown }).description !== "string"
    ) {
      return null;
    }

    const severity = (finding as { severity?: unknown }).severity;
    findings.push({
      file: (finding as { file: string }).file,
      description: (finding as { description: string }).description,
      severity: (validSeverities.has(typeof severity === "string" ? severity : "")
        ? severity
        : "warning") as AuditFinding["severity"],
    });
  }

  return findings;
}
