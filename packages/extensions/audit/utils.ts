/**
 * Audit utilities — typed signal names + transcript helpers.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getDisplayItems } from "@cvr/pi-sub-agent-render";
import type { AuditFinding } from "./machine";

export const AUDIT_SIGNAL_TOOLS = {
  proposeConcerns: "audit_proposed_concerns",
  detectConcerns: "audit_detected_concerns",
  concernComplete: "audit_concern_complete",
  synthesisComplete: "audit_synthesis_complete",
  findingResult: "audit_finding_result",
  fixGateResult: "audit_fix_gate_result",
  fixCounselResult: "audit_fix_counsel_result",
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

export function parseSynthesisComplete(messages: readonly Message[]): AuditFinding[] | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.synthesisComplete);
  if (!args) return null;
  return normalizeFindings(args.findings);
}

export function parseFindingResult(messages: readonly Message[]): "fixed" | "skip" | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.findingResult);
  return args?.outcome === "fixed" || args?.outcome === "skip" ? args.outcome : null;
}

export function parseGateResult(messages: readonly Message[]): "pass" | "fail" | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.fixGateResult);
  return args?.status === "pass" || args?.status === "fail" ? args.status : null;
}

export function parseCounselResult(messages: readonly Message[]): "pass" | "fail" | null {
  const args = getLastToolCallArgs(messages, AUDIT_SIGNAL_TOOLS.fixCounselResult);
  return args?.status === "pass" || args?.status === "fail" ? args.status : null;
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
