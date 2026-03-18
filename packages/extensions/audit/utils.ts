/**
 * Audit utilities — concern/findings JSON parsing from agent output.
 */

import type { AuditConcern, AuditFinding } from "./machine";

/**
 * Extract concerns JSON from agent text output.
 *
 * Returns:
 * - `AuditConcern[]` on success (may be empty if agent found no concerns)
 * - `null` if the JSON block is present but malformed (→ DetectionFailed)
 *
 * Looks for ```json { ... } ``` fenced blocks first, then bare JSON.
 */
export function parseConcernsJson(text: string): AuditConcern[] | null {
  const fenced = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  const raw = fenced?.[1] ?? extractBareJson(text, '{"concerns"');

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !("concerns" in parsed)) return null;
  const concerns = (parsed as { concerns: unknown }).concerns;
  if (!Array.isArray(concerns)) return null;

  return concerns
    .filter(
      (c: unknown): c is { name: string; description: string; skills?: unknown } =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as any).name === "string" &&
        typeof (c as any).description === "string",
    )
    .map((c) => ({
      name: c.name,
      description: c.description,
      skills: Array.isArray(c.skills) ? c.skills.filter((s: unknown) => typeof s === "string") : [],
    }));
}

/**
 * Extract findings JSON from synthesis output.
 *
 * Returns:
 * - `AuditFinding[]` on success (may be empty)
 * - `null` if no parseable findings block found
 */
export function parseFindingsJson(text: string): AuditFinding[] | null {
  const fenced = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  const raw = fenced?.[1] ?? extractBareJson(text, '{"findings"');

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !("findings" in parsed)) return null;
  const findings = (parsed as { findings: unknown }).findings;
  if (!Array.isArray(findings)) return null;

  const validSeverities = new Set(["critical", "warning", "suggestion"]);

  return findings
    .filter(
      (f: unknown): f is { file: string; description: string; severity?: string } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as any).file === "string" &&
        typeof (f as any).description === "string",
    )
    .map((f) => ({
      file: f.file,
      description: f.description,
      severity: (validSeverities.has(f.severity ?? "")
        ? f.severity
        : "warning") as AuditFinding["severity"],
    }));
}

/** Extract bare JSON by finding a key prefix and matching braces. */
function extractBareJson(text: string, prefix: string): string | null {
  const start = text.indexOf(prefix);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Phase exit marker patterns. */
export const PHASE_MARKERS = {
  detecting: /CONCERNS_DETECTED/i,
  auditing: /CONCERN_AUDITED/i,
  synthesizing: /AUDIT_COMPLETE/i,
  findingFixed: /FINDING_FIXED/i,
  findingSkip: /FINDING_SKIP/i,
  fixGatePass: /FIX_GATE_PASS/i,
  fixGateFail: /FIX_GATE_FAIL/i,
  fixCounselPass: /FIX_COUNSEL_PASS/i,
  fixCounselFail: /FIX_COUNSEL_FAIL/i,
} as const;
