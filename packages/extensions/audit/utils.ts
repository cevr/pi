/**
 * Audit utilities — concern JSON parsing from agent output.
 */

import type { AuditConcern } from "./machine";

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
  const raw = fenced?.[1] ?? extractBareJson(text);

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

/** Extract bare JSON by finding {"concerns": and matching braces. */
function extractBareJson(text: string): string | null {
  const start = text.indexOf('{"concerns"');
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
  auditing: /AUDITING_COMPLETE/i,
  synthesizing: /AUDIT_COMPLETE/i,
} as const;
